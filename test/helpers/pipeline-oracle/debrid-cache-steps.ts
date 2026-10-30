// Etapas do corte de debrid que SÓ o oráculo congelado do pipeline TS usa
// (`countFirstBr`, `pruneKnownBroken`). Saíram de `src/providers/` porque a
// produção não as chama desde o F4.4; o oráculo segue medindo a régua antiga.
import config from '../../../src/config.js';
import type { DebridAdapter, Stream } from '../../../types/domain.js';
import debrid from '../../../src/debrid/index.js';
import { magnetState } from '../../../src/utils/debrid-state-native.js';
import * as rdLedger from '../../../src/debrid/rd-ledger.js';
import * as autofetch from '../../../src/providers/autofetch.js';
import * as releaseIndex from '../../../src/utils/release-index.js';
import * as log from '../../../src/utils/logger.js';
import * as metrics from '../../../src/utils/metrics.js';
import type { FirstObserverState } from './first-observer.js';
import { dropTrace } from '../../../src/utils/stream-trace.js';
import type { StreamTraceState } from '../../../src/utils/stream-trace.js';
import { assertSafeTestDb } from '../db-guard.js';

// O oráculo chama `cache.set`/KV: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/debrid-cache-steps');

// Régua LOCAL de leitura/reparo do banco de magnets: o oráculo chama a PONTE
// nativa (`magnetState()`) direto, com as MESMAS guardas da régua que estava
// em `src/utils/magnetdb.ts` (o módulo vivo conservou só leitura/reparo do
// painel — a escrita de produção é do gateway e do play_effects nativo).
// A precedência `bad > lie > alive` é do NÚCLEO: `state()` devolve o veredito
// único do hash. Sem bookkeeping do agregado: nenhum teste do oráculo o lê.
function isBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'bad'
    : false;
}

function isLie(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && config.magnetDb.lieEnabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'lie'
    : false;
}

/**
 * Esquece um registro `bad`, SEM tocar em alive/lie do mesmo hash. É a função
 * do REPARO do dano do F3 (bad + blocked do RD por recusa legal). Retorna
 * true se havia um registro para apagar — mesmo comportamento observável da
 * régua viva, sem o decremento do agregado do painel.
 */
function forgetBad(adapterId: string, apiKey: string, hash: string): boolean {
  return magnetState().forgetBad(adapterId, apiKey, hash);
}

// I0 — observabilidade do funil da primeira resposta BR no corte do debrid.
// O brFound agora é contado no buildStreams (funil pré-debrid); aqui ficam
// apenas brCached/brHidden (ESTAGIADOS no estado para a finalização coerente
// no `onSelected`) e o aviso do cachedOnly. Métricas first só na passada
// reclamada (`observeFirstPass`); o aviso, porém, vale em TODOS os passes,
// inclusive nos tardios — é transparência do corte, não diagnóstico de
// primeira resposta. Estes contadores não mudam comportamento; só observam os
// pontos de corte que já existem.
export function countFirstBr(
  streams: Stream[],
  cached: Set<string>,
  after: Stream[],
  observeFirstPass: boolean,
  firstObserver: FirstObserverState | null | undefined,
  showCachedOnly: { cachedOnly: boolean; showUncachedBr: boolean },
) {
  const isBr = (s: Stream) => Boolean((s as any)._br);
  const brEntered = streams.filter(isBr).length;
  if (!brEntered) return;
  // Normaliza o lote de cache para minúsculo antes de comparar: o hash do CDN
  // pode chegar em caixa mista e o `infoHash` do stream já vem normalizado.
  const cachedLc = new Set([...cached].map((h) => String(h).toLowerCase()));
  const brCached = streams.filter((s) => isBr(s) && s.infoHash && cachedLc.has(String(s.infoHash).toLowerCase())).length;
  const brSurvived = after.filter(isBr).length;
  const hidden = brEntered - brSurvived;
  // pendingBrHidden alimenta o log da entrada do corte e o notice de UI em
  // TODO passe — não só o first. Sempre sobrescreve (inclusive com 0) para
  // um passe que deixou de ocultar BR não herdar o N do passe anterior.
  // As métricas search.first.* continuam gateadas pelo observeFirstPass.
  if (firstObserver) firstObserver.pendingBrHidden = hidden;
  if (observeFirstPass && firstObserver && !firstObserver.firstCounted) {
    firstObserver.pendingBrCached = brCached;
  }
  // I1 — transparência do corte cachedOnly. "Sumiu o dublado" é a queixa mais
  // comum e sem esta mensagem é indistinguível de "não existe dublado no
  // acervo". O conserto não é código, é escolha de config, então o log aponta
  // a página e o switch. Só informa quando o corte realmente removeu BR fora
  // do cache e o usuário não optou por mostrá-los como P2P. Roda em TODO passe.
  if (showCachedOnly.cachedOnly && !showCachedOnly.showUncachedBr && hidden > 0) {
    log.warn(
      `[debrid] ${hidden} fonte(s) BR fora do cache ocultada(s) pelo cachedOnly ` +
      `(${brCached} em cache); ligue "Mostrar BR ainda fora do cache" para vê-las como P2P`,
    );
  }
}

/** Resultado do filtro pré-checagem: a lista viva e o total descartado
 * (bad+dead+lie+miss) que o `onCacheResult` precisa reportar quando a lista
 * esvazia. */
export type BrokenPrune = {
  streams: Stream[];
  trustDropped: number;
};

/**
 * Filtro pré-checagem: o que já PROVOU estar quebrado sai ANTES de gastar lote
 * (nem upload, na AllDebrid) com fracasso conhecido. Emite as métricas e o log
 * de descarte — o applyDebrid só precisa do resultado.
 */
export function pruneKnownBroken(
  streams: Stream[],
  adapterId: string,
  { apiKey, trustScope, season, episode, imdbId, trace }: {
    apiKey: string;
    trustScope: string;
    season?: number | null;
    episode?: number | null;
    imdbId?: string | null;
    /** P5 — ledger observacional: cada descarte leva o motivo real (bad, dead,
     * lie ou idx-miss) e o título, ANTES de gastar lote na checagem. */
    trace?: StreamTraceState | null;
  },
): BrokenPrune {
  // Banco de magnets + blacklist do autofetch: o que já PROVOU estar quebrado
  // sai ANTES da checagem — não se gasta lote (nem upload, na AllDebrid) com
  // fracasso conhecido. Só histórico desta conta: cache do debrid pertence a
  // ela, e um morto aqui pode estar vivo em outro serviço.
  // Contadores SEPARADOS por origem: bad é play sem vídeo (banco de magnets),
  // dead é estado terminal no recheck do autofetch. Somados escondem qual dos
  // dois corta — e é exatamente o que o diagnóstico precisa distinguir.
  let droppedBad = 0;
  let droppedDead = 0;
  let droppedLie = 0;
  let droppedMiss = 0;
  const kept = streams.filter((s) => {
    if (!s.infoHash) return true;
    // Corta por infoHash puro: item `fromFallback` / via instantânea do
    // magnet-bank (selo 📦) também sai — não há exceção por origem. Sem isto
    // a reserva reapresentaria hash que o play já provou sem vídeo.
    if (isBad(adapterId, apiKey, s.infoHash)) {
      // Autocorreção tardia do dano F3: um ramo antigo marcava `bad` no hash
      // que o Real-Debrid recusou por lei (HTTP 451/error_code 35). Recusa
      // legal não é magnet quebrado, e NoVideoError legítimo não grava
      // `blocked`; logo `bad + blocked` neste adapter só pode ser aquela
      // escrita equivocada. Limpa e deixa o stream seguir: fora do cachedOnly
      // volta como P2P/sem ⚡; no cachedOnly o corte ternário o remove logo
      // abaixo pelo próprio ledger.
      if (config.debrid.rdLedger.enabled && adapterId === 'realdebrid' && rdLedger.peek(s.infoHash) === 'blocked') {
        if (forgetBad(adapterId, apiKey, s.infoHash)) {
          metrics.count('magnetdb.bad.clearedBlocked');
          log.info(`[debrid] bad RD de recusa legal recuperado (${String(s.infoHash).slice(0, 8)})`);
        }
        return true;
      }
      droppedBad += 1;
      dropTrace(trace, s, 'bad');
      return false;
    }
    if (s._lied || isLie(adapterId, apiKey, s.infoHash)) {
      droppedLie += 1;
      dropTrace(trace, s, 'lie');
      return false;
    }
    // Prova fina do índice: este hash já provou NÃO servir ESTE episódio
    // (play ou tail). Só vale com s/e + obra na busca — filme e série sem
    // episódio não têm o que conferir.
    if (season != null && episode != null && imdbId && releaseIndex.isMissing(imdbId, { season, episode }, s.infoHash)) {
      droppedMiss += 1;
      dropTrace(trace, s, 'idx-miss');
      return false;
    }
    if (autofetch.isDead(adapterId, trustScope, s.infoHash)) {
      droppedDead += 1;
      dropTrace(trace, s, 'dead');
      return false;
    }
    return true;
  });
  if (droppedBad + droppedDead + droppedLie + droppedMiss > 0) {
    // O agregado magnetdb.dropped soma SÓ bad/dead/lie de propósito: miss é
    // marca do release-index (não do banco de magnets) e conta em separado,
    // como search.idx.miss.dropped — o diagnóstico não pode culpar o lado errado.
    metrics.count('magnetdb.dropped', droppedBad + droppedDead + droppedLie);
    if (droppedBad) metrics.count('magnetdb.dropped.bad', droppedBad);
    if (droppedDead) metrics.count('magnetdb.dropped.dead', droppedDead);
    if (droppedLie) metrics.count('magnetdb.dropped.lie', droppedLie);
    if (droppedMiss) metrics.count('search.idx.miss.dropped', droppedMiss);
    log.info(`[debrid] ${droppedBad + droppedDead + droppedLie + droppedMiss} magnet(s) com histórico ruim descartado(s) antes da checagem (${droppedBad} bad, ${droppedDead} dead, ${droppedLie} lie, ${droppedMiss} miss)`);
  }
  return { streams: kept, trustDropped: droppedBad + droppedDead + droppedLie + droppedMiss };
}
