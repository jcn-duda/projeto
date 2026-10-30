// Banco de magnets: memória durável POR HASH, escopada por serviço+conta.
//
// Diferente do davail (cache de disponibilidade de TTL curto que responde ao
// checkCached por minutos), isto é o HISTÓRICO de longo prazo: sobrevive dias,
// atravessa buscas e usuários diferentes da mesma conta, e alimenta duas
// decisões na listagem — descartar o que provou estar quebrado e desempatar a
// ordem a favor do que provou tocar na hora.
//
// Regra de ouro: só evidência MEDIDA entra, nunca palpite. Falso negativo é
// pior que falso positivo — descartar um magnet bom esconde stream do usuário.
// Por isso:
// - `alive` nasce de confirmação do debrid (checagem de cache) ou de play que
//   resolveu de verdade no /resolve;
// - `bad` nasce apenas de falha DETERMINÍSTICA do play (torrent sem nenhum
//   arquivo de vídeo). Erro transitório (rede, auth, quota, rate) não grava
//   nada; falha de escolha de arquivo (WorkPickError/EpisodePickError) também
//   não — o pack pode servir outra obra/episódio.
//
// DONO NATIVO (T2-L5b): as linhas `mag:v1:<side>:<adapter>:<conta>:<hash>` são
// do `MagnetStateStore` (Rust). Toda escrita e leitura passa pela ponte
// `debrid-state-native.ts` — este módulo não monta chave nem toca o `cache` do
// Node, que não é dono desse namespace. A ESCRITA saiu para o oráculo de teste
// (`test/helpers/pipeline-oracle/play/magnetdb-writes.ts`): quem grava a
// evidência em produção é o gateway. Aqui ficam a leitura sem efeito, a
// limpeza do painel e o status; o AGREGADO persistido (`mag_meta:v1:counts`)
// vive em magnetdb-persist.ts e o TTL vem da config.
import config from '../config.js';
import * as metrics from './metrics.js';
import { magnetState } from './debrid-state-native.js';
import { QUOTAS } from './cache-quotas.js';
import type { AdapterTotals } from './magnetdb-counts.js';
import {
  adapterCounts, ensureCountsLoaded,
  savePersistentCounts, loadPersistentCounts, schedulePersistentSave, markMutation,
  ttlRemainingBasis, sweepNativeNamespaces, type TtlRemainingBasis,
} from './magnetdb-persist.js';

export type { AdapterTotals };
export { savePersistentCounts, loadPersistentCounts, ttlRemainingBasis, sweepNativeNamespaces };
export type { TtlRemainingBasis };

type MagnetSizes = { alive: number; bad: number; lie: number };
type TtlRemaining = { alive: number | null; bad: number | null; lie: number | null };

export type MagnetDbAdapterStatus = {
  sizeAlive: number; sizeBad: number; sizeLie: number; ttlRemainingSeconds: TtlRemaining;
};

/** Procedência do campo no painel: L1/L2/config vs contadores do processo. */
export type MagnetDbOrigem = 'duravel' | 'amostra' | 'naomedido';

export type MagnetDbStatus = {
  enabled: boolean;
  aliveTtlSeconds: number;
  badTtlSeconds: number;
  lieTtlSeconds: number;
  sizeAlive: number;
  sizeBad: number;
  sizeLie: number;
  ttlRemainingSeconds: TtlRemaining;
  byAdapter: Record<string, MagnetDbAdapterStatus>;
  l1Entries: number;
  l1Max: number;
  evictedQuota: number;
  /**
   * Procedência da soma de TTL restante: `l1-rebuild` = restante real de cada
   * chave, preciso só no instante do rebuild; `aggregate-estimate` = estimativa
   * incremental/restaurada (escrita/esquecimento somam/subtraem TTL nominal).
   */
  ttlRemainingBasis: TtlRemainingBasis;
  counters: {
    aliveSet: number; badSet: number; lieSet: number; dropped: number;
    droppedBad: number; droppedDead: number; droppedLie: number; badClearedBlocked: number;
  };
  _origem: Record<string, MagnetDbOrigem>;
};

// Contadores, persistência (mag_meta:v1) e o relógio da varredura nativa moram
// em magnetdb-persist.ts — este arquivo estava no teto de 400 linhas. A API
// pública continua aqui (reexportação acima de save/load e do sweep).

/**
 * Apaga o `bad` de QUALQUER conta do adapter. É o caminho da limpeza do painel,
 * que enumera por adapter e não tem a chave da conta em mãos (o reparo do
 * warmer saiu com o warmer TS). Idempotente: a segunda passada devolve false.
 * `alive`/`lie` do mesmo hash não são tocados.
 *
 * O núcleo apaga o par (adapter, hash) em TODAS as contas e devolve quantas
 * linhas saíram; o agregado durável baixa esse número — o antigo `onForget` do
 * cache fazia isso e morreu com a escrita nativa. Sem o decremento, o painel
 * mostrava `bad` fantasma até a sentinela do boot.
 */
function forgetBadOf(adapterId: string, hash: string): boolean {
  const removed = magnetState().forgetBadOf(adapterId, hash);
  if (removed > 0) {
    const totals = adapterCounts.get(adapterId);
    if (totals) {
      totals.bad = Math.max(0, totals.bad - removed);
      totals.ttlRemainingSums.bad = Math.max(
        0,
        totals.ttlRemainingSums.bad - removed * config.magnetDb.badTtl,
      );
      markMutation();
      schedulePersistentSave();
    }
  }
  return removed > 0;
}


// Variantes de LEITURA SEM EFEITO (P5 diagnóstico): a leitura nativa também não
// aquece LRU, não conta hit/miss e não promove nada — diagnóstico não pode
// aquecer o cache de produção nem poluir a medição. Mesma semântica de
// isAlive/isBad/isLie.
//
// A precedência `bad > lie > alive` é do NÚCLEO: `state()` devolve o veredito
// único do hash, então as três leituras nunca divergem entre si nem dependem da
// ordem em que o pipeline consulta.
function peekBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'bad'
    : false;
}
function peekLie(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && config.magnetDb.lieEnabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'lie'
    : false;
}


/**
 * Estado de diagnóstico do painel.
 * - sizeAlive/Bad/Lie + byAdapter: contagens duráveis agregadas por adapter.
 * - l1Entries: linhas vivas do namespace mag, contadas pelo NÚCLEO (o Node não
 *   tem mais o namespace no L1, então `snapshot()` não as enxerga).
 * - l1Max: cota do namespace, de `QUOTAS` (mesmo motivo).
 * - evictedQuota: métrica do cache do Node; a poda agora é da varredura nativa,
 *   que não alimenta esse contador — fica 0 até o painel ler `sweep()`.
 * - `_origem` durável: contagens refletem estado durável.
 */
function status(): MagnetDbStatus {
  const l1Entries = magnetState().liveCount(Date.now());

  ensureCountsLoaded(l1Entries);

  let sizeAlive = 0;
  let sizeBad = 0;
  let sizeLie = 0;
  const totalTtlSums = { alive: 0, bad: 0, lie: 0 };
  const byAdapter: Record<string, MagnetDbAdapterStatus> = Object.create(null);

  for (const [adapterId, totals] of adapterCounts) {
    sizeAlive += totals.alive;
    sizeBad += totals.bad;
    sizeLie += totals.lie;
    totalTtlSums.alive += totals.ttlRemainingSums.alive;
    totalTtlSums.bad += totals.ttlRemainingSums.bad;
    totalTtlSums.lie += totals.ttlRemainingSums.lie;

    byAdapter[adapterId] = {
      sizeAlive: totals.alive, sizeBad: totals.bad, sizeLie: totals.lie,
      ttlRemainingSeconds: {
        alive: totals.alive ? Math.ceil(totals.ttlRemainingSums.alive / totals.alive) : null,
        bad: totals.bad ? Math.ceil(totals.ttlRemainingSums.bad / totals.bad) : null,
        lie: totals.lie ? Math.ceil(totals.ttlRemainingSums.lie / totals.lie) : null,
      },
    };
  }

  const ttlRemainingSeconds: TtlRemaining = {
    alive: sizeAlive ? Math.ceil(totalTtlSums.alive / sizeAlive) : null,
    bad: sizeBad ? Math.ceil(totalTtlSums.bad / sizeBad) : null,
    lie: sizeLie ? Math.ceil(totalTtlSums.lie / sizeLie) : null,
  };

  const counters = metrics.snapshot().counters;

  return {
    enabled: config.magnetDb.enabled,
    aliveTtlSeconds: config.magnetDb.aliveTtl,
    badTtlSeconds: config.magnetDb.badTtl,
    lieTtlSeconds: config.magnetDb.lieTtl,
    sizeAlive,
    sizeBad,
    sizeLie,
    ttlRemainingSeconds,
    byAdapter,
    l1Entries,
    l1Max: QUOTAS.mag,
    evictedQuota: counters['cache.evicted.quota.mag'] || 0,
    ttlRemainingBasis: ttlRemainingBasis(),
    counters: {
      aliveSet: counters['magnetdb.alive.set'] || 0, badSet: counters['magnetdb.bad.set'] || 0,
      lieSet: counters['magnetdb.lie.set'] || 0, dropped: counters['magnetdb.dropped'] || 0,
      droppedBad: counters['magnetdb.dropped.bad'] || 0, droppedDead: counters['magnetdb.dropped.dead'] || 0,
      droppedLie: counters['magnetdb.dropped.lie'] || 0, badClearedBlocked: counters['magnetdb.bad.clearedBlocked'] || 0,
    },
    _origem: {
      enabled: 'duravel', aliveTtlSeconds: 'duravel', badTtlSeconds: 'duravel', lieTtlSeconds: 'duravel',
      sizeAlive: 'duravel', sizeBad: 'duravel', sizeLie: 'duravel', ttlRemainingSeconds: 'duravel',
      ttlRemainingBasis: 'duravel',
      byAdapter: 'duravel', l1Entries: 'duravel', l1Max: 'duravel', evictedQuota: 'duravel',
    },
  };
}

export {
  peekBad, peekLie, forgetBadOf, status,
};
