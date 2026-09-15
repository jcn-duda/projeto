import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';
import type { Stream } from '../../types/domain.js';
import {
  pickBrDubbedByTargetQualities,
  pickAnyDubbedCandidates,
  canAutoFetchBr,
} from '../utils/format.js';
import debrid from '../debrid/index.js';
import * as held from '../debrid/protected.js';
import { accountScope } from '../utils/request-key.js';
import { opts } from '../runtime.js';
import * as autofetch from './autofetch.js';
import { noteSkip } from './autofetch-gates.js';
import { pickSeedsPool, purgeSeedsQueue } from './autofetch-seeds-pool.js';
import { requestBrProbe, probeBlocksSeeds } from './br-probe.js';
import { hasBrEvidence, hasBrDubbed } from '../utils/br-gap.js';
import * as releaseIndex from '../utils/release-index.js';
import { pickLowerPoolFallbacks, composeQueueEntries, toQueueCandidate } from './autofetch-fallback.js';
import {
  filterSeedsUniverse,
  seedsSelectionBlock,
  type SeedsPolicyConfig,
} from './autofetch-policy.js';
import * as metrics from '../utils/metrics.js';

// Seleção do Chupim extraída do runner para a catraca de linhas. Continua sendo
// o passe SÍNCRONO, sem rede: escolhe os candidatos e segura os hashes; quem
// dispara é o `enqueueAutofetch` (runner), depois do checkCached. A decisão de
// seeds aqui é só a de SELEÇÃO — a de parada por cache vive no despacho.

export type AutoFetchStream = Stream & { infoHash: string };
// `slotLimit`: teto da vaga por busca que o candidato leva do pool que o
// escolheu (título raro no seeds sobe o limite imediato — a vaga precisa
// acompanhar, senão o 3º disparo morreria em `slot`). Ausente = teto do pool.
export type AutoFetchCandidate = { stream: AutoFetchStream; account: string; pool: string; slotLimit?: number; rare?: boolean };
export type AutoFetchRequest = {
  cached: Set<string>;
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
};

function isAutoFetchStream(stream: Stream): stream is AutoFetchStream {
  return typeof stream.infoHash === 'string' && stream.infoHash.length > 0;
}

/** Config de política seeds a partir do runtime do usuário + operador. */
export function seedsPolicyConfig(): SeedsPolicyConfig {
  const user = opts();
  return {
    dubbedOnly: user.dubbedOnly,
    cachedOnly: user.debridCachedOnly,
    maxSizeGb: user.maxSizeGb,
    seedsMaxGb: config.debrid.autoFetchSeedsMaxGb,
    seedsMaxQuality: config.debrid.autoFetchSeedsMaxQuality,
  };
}

/** Contabiliza o universo seeds recusado: 1 skip por motivo (não inflado). */
function noteSeedsRejections(rejected: Map<string, number>, adapterId: string): void {
  for (const [reason, count] of rejected) {
    metrics.count(`autofetch.seeds.rejected.${reason}`, count);
    noteSkip(reason, null, adapterId, 'seeds');
  }
}

/**
 * Sem fonte BR dublada tocável, manda o debrid baixar as melhores — o play passa
 * a funcionar minutos depois, sem o usuário pedir. Roda em TODA busca, então as
 * travas importam mais que a funcionalidade:
 *
 * - desligável (`autoFetchBr`), e desligado junto quando não há debrid;
 * - exige `known`: sem saber o que está em cache não há como saber o que falta,
 *   e sairíamos enfileirando torrent às cegas (Real-Debrid e Debrid-Link caem
 *   aqui — neles o /resolve do play já adiciona o magnet de qualquer forma);
 * - ATÉ `autoFetchMax` torrents por busca, com uma vaga por candidato
 *   compartilhada entre o passe parcial e o tardio (acquireSearchSlot);
 * - marca o hash no cache ANTES de chamar a API: a mesma busca é repetida pelo
 *   Stremio e ainda passa pelo passe tardio, e sem isso cada repetição mandaria
 *   o mesmo torrent de novo;
 * - nunca entra no caminho da resposta: erro só vira log.
 */
export function autoFetchCandidates(
  streams: Stream[],
  { season, episode, imdbId, searchKey }: { season?: number | null; episode?: number | null; imdbId?: string; searchKey?: string } = {},
) {
  const { autoFetchBr, debridApiKey } = opts();
  const adapter = debrid.current();
  if (!canAutoFetchBr({ autoFetchBr }, adapter)) {
    noteSkip('disabled', streams[0] || null, adapter?.id || '', '');
    return [];
  }
  const account = accountScope(debridApiKey);
  const policy = seedsPolicyConfig();

  // Torrent morto na blacklist é ignorado antes de montar os pools
  const liveStreams = streams.filter((s) => !s.infoHash || !autofetch.isDead(adapter!.id, account, s.infoHash));
  const live = autofetchLive.effective();

  // Espelho do waiver do piso em sortAndLimit: o waiver existe para o item
  // alcançar a CHECAGEM do debrid (cache não precisa de swarm) e a reserva BR —
  // não para o Chupim BAIXAR o que ninguém semeia. Torrent abaixo do piso é
  // download que não termina e, no pool br da AllDebrid, viraria acervo
  // protegido (protectBr) eterno sem nunca tocar. O waiver viaja marcado
  // (`_seedFloorWaived`, setado no próprio corte do piso), então o corte aqui é
  // exato: sobrevivente do waiver não vira candidato; quem PASSOU pelo piso na
  // listagem segue elegível como sempre. Vale para os TRÊS pools — inclusive o
  // de swarm: com `autoFetchMinSeeders=0` o piso próprio do seeds não filtra e
  // só este corte impede que o waiver seja baixado.
  const isSeedFloorWaived = (s: AutoFetchStream) => Boolean(s._seedFloorWaived);
  const isViableForEnqueue = (s: AutoFetchStream) => {
    if (!isSeedFloorWaived(s)) return true;
    metrics.count('autofetch.seed-floor-skipped');
    return false;
  };

  const queueDepth = live.autoFetchQueue ? live.autoFetchQueueDepth : 0;
  const totalMax = live.autoFetchMax + queueDepth;

  // Cascata br → any → seeds: no pool BR pega 1 por qualidade-alvo
  // (720/1080/4K); recusar o nível `any` não pode abortar a busca inteira —
  // o corte antigo (`return []`) matava o terceiro nível justamente quando
  // o operador pediu só a rede de segurança de swarm.
  let candidates = pickBrDubbedByTargetQualities(liveStreams, new Set(), totalMax, { season })
    .filter(isAutoFetchStream)
    .filter(isViableForEnqueue);
  let pool = 'br';
  // Sonda dirigida (Fase 4): pool BR vazio — não existe BR dublada ou todas
  // foram cortadas pelo piso de seeders. ANTES de decidir seeds, pede a sonda
  // (index-only∩pt-BR). O tipo é inferido da temporada: série traz S/E, filme
  // não. `requestBrProbe` só grava pending se a sonda tiver virado trabalho na
  // fila — sem isso, nada bloqueia seeds.
  const probeWork = imdbId
    ? { type: (season != null ? 'series' : 'movie') as 'movie' | 'series', imdbId, season: season ?? null, episode: episode ?? null }
    : null;
  if (probeWork && candidates.length === 0) {
    // Gate de plausibilidade (C6): consulta QUIET o índice da obra/location.
    // Pool vazio sozinho NÃO dispara a sonda — numa obra sem nenhuma evidência
    // isBr, a ausência de dublado é o esperado. Enfileirar `br-gap` aqui era
    // colheita COMPLETA (~30 consultas, tier de prioridade por 1h) para todo
    // filme gringo aberto, limitada só pelo dedupe de 12h: mais caro que a
    // sonda que o gate acabou de recusar. Sem vestígio, NADA sobe — o caminho
    // regular de miss/gap da busca cuida da descoberta. Com evidência BR, a
    // sonda é upgrade (já há dublado) ou ausência dentro da obra com prova BR.
    const releases = releaseIndex.lookupQuiet(imdbId as string, { season: season ?? null, episode: episode ?? null });
    if (hasBrEvidence(releases)) {
      requestBrProbe(probeWork, { mode: hasBrDubbed(releases) ? 'upgrade' : 'evidence' });
    } else {
      metrics.count('autofetch.brProbe.skipped.no-evidence');
    }
  }
  // `pending` (procurando) bloqueia seeds de forma transitória; `found` NÃO —
  // a lista/índice decide na próxima abertura, o TTL do estado não segura
  // swarm. empty/failed/capped liberam.
  const probeBlocked = Boolean(probeWork && probeBlocksSeeds(probeWork));
  const dubbedGlobal = candidates.length === 0
    ? pickAnyDubbedCandidates(liveStreams, new Set(), totalMax, { season })
        .filter(isAutoFetchStream)
        .filter(isViableForEnqueue)
    : [];
  if (dubbedGlobal.length > 0) {
    if (live.autoFetchAnyDubbed) {
      candidates = dubbedGlobal;
      pool = 'any';
      metrics.count('autofetch.any-dubbed');
    } else {
      metrics.count('autofetch.any-dubbed-skipped');
    }
  }
  let seedsImmediateLimit = live.autoFetchTopSeedsMax, seedsRare = false;
  let seedsBlocked = false;
  if (candidates.length === 0 && live.autoFetchTopSeeds) {
    // Política do pool seeds (dubbedOnly / lista P2P tocável) é decidida ANTES
    // de selecionar; o filtro de qualidade/tamanho roda no universo, antes do
    // pickSeedsPool. Nada aqui consulta cache — a parada por cache é do despacho.
    const block = seedsSelectionBlock(policy, liveStreams, { brProbePending: probeBlocked });
    if (block) {
      seedsBlocked = true;
      noteSkip(block, liveStreams[0] || null, adapter?.id || '', 'seeds');
      // Só `dubbed-only` purga (regra PERMANENTE). `br-probe-pending` é
      // transitório: a fila seeds fica retida e volta a drenar quando o lease
      // da sonda termina/finaliza.
      if (block === 'dubbed-only' && live.autoFetchQueue && searchKey) {
        purgeSeedsQueue(searchKey, {
          ttl: config.debrid.autoFetchQueueTtl,
          adapterId: adapter!.id,
          account,
        });
      }
    } else {
      const { eligible, rejected } = filterSeedsUniverse(liveStreams, policy);
      noteSeedsRejections(rejected, adapter?.id || '');
      // Seleção do pool seeds (estrito + complemento relaxado + título raro) vive
      // em autofetch-seeds-pool.ts; o limite imediato e a marca de raro voltam de lá.
      const seeds = pickSeedsPool(eligible, live, {
        season,
        queueDepth,
        viable: isViableForEnqueue,
        rare: { max: live.autoFetchRareMax, threshold: live.autoFetchRareThreshold, maxSeeders: live.autoFetchRareMaxSeeders },
      });
      candidates = seeds.candidates;
      seedsImmediateLimit = seeds.immediateLimit;
      seedsRare = seeds.rareUsed;
      pool = 'seeds';
      if (candidates.length > 0) metrics.count('autofetch.top-seeded');
    }
  }
  if (candidates.length === 0 && !seedsBlocked) {
    metrics.count('autofetch.no-candidate');
    noteSkip('no-candidate', liveStreams[0] || null, adapter?.id || '', pool);
  }

  const immediateLimit = pool === 'seeds' ? seedsImmediateLimit : live.autoFetchMax;
  const immediate = candidates.slice(0, immediateLimit);

  // Hold apenas nos candidatos imediatos que serão disparados
  for (const candidate of immediate) {
    held.hold(String(candidate.infoHash), live.autoFetchTtl, account);
  }

  // Fila persistente: excedente do pool primário + fallback dos pools
  // inferiores habilitados (br → any → seeds). O fallback NÃO é disparado
  // agora: fica RETIDO na fila para o `drainNext` subir somente no colapso
  // comprovado do primário (dead/stalled). Settle sem evidência não drena.
  // Ready antes disso descarta a fila inteira; cada entrada
  // carrega o próprio pool.
  if (live.autoFetchQueue && searchKey) {
    // Profundidade zero não executa seletores nem emite métricas de fallback inexistente.
    const fallbacks = queueDepth > 0
      ? pickLowerPoolFallbacks(liveStreams, live, {
        primaryPool: pool,
        excludeHashes: candidates.map((s) => String(s.infoHash || '')),
        season,
        viable: isViableForEnqueue,
        policy,
        // A fila persistida herda o bloqueio da sonda: sem isto, o fallback
        // seeds reposto driblaria a política que a seleção primária respeitou.
        brProbePending: probeBlocked,
      })
      : [];
    const entries = composeQueueEntries(
      candidates.slice(immediateLimit).map((stream) => ({
        stream,
        pool,
        ...(pool === 'seeds' ? { rare: seedsRare, slotLimit: seedsImmediateLimit } : {}),
      })),
      fallbacks,
      queueDepth,
    );
    autofetch.writeQueue(
      searchKey,
      entries.map(({ stream, pool: entryPool, rare, slotLimit }) => toQueueCandidate(stream, entryPool, {
        imdbId,
        season,
        episode,
        seasonFill: Boolean(live.autoFetchSeasonFill && adapter?.cacheCheck),
        rare,
        slotLimit,
      })),
      config.debrid.autoFetchQueueTtl,
      adapter!.id,
      account,
    );
    const brQueued = entries.filter((entry) => entry.pool === 'br').length;
    if (brQueued > 0) metrics.count('autofetch.queue.surplus', brQueued);
  }

  return immediate.map((stream) => ({ stream, account, pool, ...(pool === 'seeds' ? { slotLimit: seedsImmediateLimit, rare: seedsRare } : {}) }));
}
