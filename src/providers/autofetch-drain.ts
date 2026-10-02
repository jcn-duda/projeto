// Seleção do dreno do Chupim (Fase 2). Extraído do `drainNext` (autofetch-recheck)
// para a catraca de linhas e para concentrar a reserva do teto por OBRA num só
// ponto: escolher o próximo candidato elegível da fila persistente JÁ reservando
// a vaga da obra.
//
// Diferença de contrato em relação ao dreno antigo: o candidato que o teto da
// obra fecha NESTA janela é DEFERIDO — permanece na fila enquanto a seleção
// procura outro elegível. Descartá-lo apagava um BR que voltaria a caber assim
// que a vaga da obra liberasse (morte/parada), e o candidato era perdido até o
// TTL. O adiamento conta na métrica própria `autofetch.drain.obra-cap-deferred`
// — defer NÃO é skip do painel (o candidato segue na fila).

import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as held from '../debrid/protected.js';
import * as metrics from '../utils/metrics.js';
import type { DebridAdapter } from '../../types/domain.js';
import * as autofetch from './autofetch.js';
import type { QueueCandidate } from './autofetch.js';
import { noteSkip } from './autofetch-gates.js';
import { seedsPolicyConfig } from './autofetch-candidates.js';
import { seedsDrainRejection } from './autofetch-policy.js';
import { probeBlocksSeeds } from './br-probe.js';
import { reserveObra, type ObraLease } from './autofetch-obra.js';

export type DrainSelection = {
  next: QueueCandidate | null;
  /** Fila já sem os obsoletos; os barrados pelo teto voltam à frente (deferidos). */
  remaining: QueueCandidate[];
  /** Reserva da vaga da obra para o `next`; `null` quando não há `next`. */
  lease: ObraLease | null;
};

/** Estado permanente que tira o candidato da fila (não é adiamento transitório). */
function isObsolete(cand: QueueCandidate, adapter: DebridAdapter, account: string): boolean {
  const h = String(cand.infoHash).toLowerCase();
  return (
    autofetch.isDead(adapter.id, account, h) ||
    Boolean(cache.get(autofetch.markerKey(adapter.id, account, h))) ||
    held.isDurablyProtected(adapter.id, account, h)
  );
}

/**
 * Escolhe o próximo candidato da fila que (a) não é obsoleto, (b) não está em
 * hold transitório e (c) tem vaga no teto por obra. Devolve a fila remanescente
 * já gravada e a reserva do escolhido (se houver).
 */
export function takeDrainCandidate(
  searchKey: string,
  adapter: DebridAdapter,
  account: string,
): DrainSelection {
  const queue = autofetch.readQueue(searchKey) as QueueCandidate[];
  if (!queue.length) return { next: null, remaining: [], lease: null };

  const drainPolicy = seedsPolicyConfig();
  const skipFn = (cand: QueueCandidate): boolean => {
    if (isObsolete(cand, adapter, account)) return true;
    // Regras PERMANENTES do pool seeds (dubbedOnly/qualidade/tamanho) são
    // revalidadas antes do enqueue: candidato inválido SAI da fila. Bloqueio
    // transitório (hold) pertence ao deferFn, não aqui.
    const rejection = cand.pool === 'seeds' ? seedsDrainRejection(cand, drainPolicy) : null;
    if (rejection) {
      noteSkip(rejection, cand as any, adapter.id, 'seeds');
      return true;
    }
    return false;
  };
  const deferFn = (cand: QueueCandidate) => {
    if (held.isHeld(String(cand.infoHash).toLowerCase(), account)) return true;
    // Sonda dirigida (Fase 4): com pending da obra, o candidato seeds fica em
    // `remaining` (ADIADO, não descartado) — a fila é preservada e volta a
    // drenar quando o lease terminar. br/any não são afetados.
    if (cand.pool === 'seeds' && cand.imdbId) {
      // Identidade da SONDA, não a do teto por obra: no pack `episode` é nulo
      // (cap da temporada), mas a sonda observa o EPISÓDIO solicitado. Entrada
      // antiga sem `probeEpisode` cai no `episode` persistido.
      const probeSeason = cand.probeSeason ?? cand.season ?? null;
      const probeEpisode = cand.probeEpisode ?? (cand.isPack === true ? null : (cand.episode ?? null));
      return probeBlocksSeeds({
        type: (probeSeason != null || cand.isPack === true ? 'series' : 'movie') as 'movie' | 'series',
        imdbId: String(cand.imdbId),
        season: probeSeason,
        episode: probeEpisode,
      });
    }
    return false;
  };

  let working: QueueCandidate[] = queue;
  let next: QueueCandidate | null = null;
  let remaining: QueueCandidate[] = [];
  // Candidatos barrados pelo cap da obra: DEFERIDOS, voltam à fila no fim.
  const deferredByCap: QueueCandidate[] = [];
  let lease: ObraLease | null = null;
  // Bounded pelo tamanho da fila: cada volta remove um candidato de `working`.
  for (let i = 0; i <= queue.length; i += 1) {
    const picked = autofetch.takeNext(working, skipFn, deferFn);
    const candidate = picked.next;
    remaining = picked.remaining;
    if (!candidate) break;
    lease = reserveObra({
      adapterId: adapter.id,
      account,
      imdbId: candidate.imdbId,
      season: candidate.season,
      // Pack de temporada usa a identidade da TEMPORADA; `rare`/`slotLimit`
      // preservam o cap do pool seeds que a seleção primária aplicou.
      episode: candidate.isPack === true ? null : (candidate.episode ?? null),
      isPack: candidate.isPack === true,
      searchKey,
      pool: String(candidate.pool || ''),
      hash: String(candidate.infoHash || ''),
      rare: candidate.rare === true,
      slotLimit: candidate.slotLimit,
      quality: candidate.quality,
    });
    if (lease) {
      next = candidate;
      break;
    }
    // Cap da obra fechado nesta janela: bloqueio TRANSITÓRIO. O candidato é
    // MANTIDO na fila (não descartado) e o laço segue para o próximo elegível —
    // sem loop infinito porque cada volta encurta `working`. Aqui NÃO se chama
    // `noteSkip`: defer não é desistência, e contar o mesmo candidato a cada
    // passagem inflava o painel/trace (o trace é ring e seria inundado). A
    // métrica própria é a canônica deste adiamento.
    metrics.count('autofetch.drain.obra-cap-deferred');
    deferredByCap.push(candidate);
    working = picked.remaining;
  }

  // Os barrados pelo cap voltam à FRENTE da fila (ordem relativa preservada):
  // continuam disponíveis para a próxima janela, quando a vaga liberar.
  remaining = [...deferredByCap, ...remaining];
  autofetch.writeQueue(searchKey, remaining, config.debrid.autoFetchQueueTtl, adapter.id, account);
  return { next, remaining, lease };
}
