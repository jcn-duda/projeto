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
// Node, que não é dono desse namespace. Aqui ficam só o AGREGADO persistido
// (`mag_meta:v1:counts`, em magnetdb-persist.ts) e o TTL, que vem da config.
import config from '../config.js';
import * as metrics from './metrics.js';
import { magnetState } from './debrid-state-native.js';
import { QUOTAS } from './cache-quotas.js';
import { isSupportedHash, type AdapterTotals } from './magnetdb-counts.js';
import {
  adapterCounts, getOrCreateAdapter, ensureCountsLoaded,
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
 * Grava em lote que os hashes tocariam na hora nesta conta. Chamado quando a
 * checagem de cache do debrid confirma o positivo e quando o /resolve devolve
 * link de verdade. Regravar um hash já vivo só renova o TTL.
 */
function markAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  // Dedup + minúsculas: o núcleo casa por hash já normalizado, e a métrica de
  // recusa conta HASHES — duas cópias do mesmo hash inflariam `alive.set`.
  const candidates = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter(Boolean);
  // Só grava hash que o parse da chave aceita de volta: gravar o que ele
  // recusa cria linha física que a enumeração de diagnóstico não reconhece,
  // e a sentinela de divergência acusa desacordo em todo boot sem nunca
  // convergir.
  const unique = candidates.filter(isSupportedHash);
  const malformed = candidates.length - unique.length;
  if (malformed > 0) metrics.count('magnetdb.hash.refused', malformed);
  if (unique.length === 0) return;
  const now = Date.now();
  // UMA varredura para saber quais já estão `bad`: a precedência
  // `bad > lie > alive` é do núcleo, e um `isBad` por hash custaria uma
  // travessia napi por candidato.
  const bad = new Set(
    magnetState().stateSnapshot(adapterId, apiKey, unique, now)
      .filter((mark) => mark.state === 'bad')
      .map((mark) => String(mark.hash || '').toLowerCase()),
  );
  const allowed = unique.filter((hash) => !bad.has(hash));
  const refused = unique.length - allowed.length;
  if (refused > 0) metrics.count('magnetdb.alive.refused-bad', refused);
  if (allowed.length === 0) return;

  // `born` = quantas chaves NASCERAM; renovação de chave viva não conta.
  const born = magnetState().markAlive(adapterId, apiKey, allowed, ttl, now);

  // Qualquer escrita degrada a base para estimativa — inclusive a renovação
  // econômica do renewAlive (born === 0): a soma não sabe o restante
  // anterior da chave renovada, então `l1-rebuild` não sobrevive nem a ela.
  markMutation();
  if (born > 0) {
    const totals = getOrCreateAdapter(adapterId);
    totals.alive += born;
    totals.ttlRemainingSums.alive += born * ttl;
    schedulePersistentSave();
  }
  metrics.count('magnetdb.alive.set', allowed.length);
}

function isAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'alive'
    : false;
}

/**
 * Grava que o hash provou estar quebrado nesta conta (torrent sem arquivo de
 * vídeo no play). TTL próprio: torrent pode ganhar upload novo, então o
 * negativo também envelhece.
 *
 * bad VENCE sobre alive: o núcleo apaga o `alive` do mesmo hash na MESMA
 * transação do `bad`, e `state()` devolve o veredito único pela precedência
 * `bad > lie > alive`. Sem isso as janelas de TTL são distintas (24h contra 7
 * dias) e os dois coexistiriam — o filtro pré-checagem cortaria, mas o
 * instantSet já teria empurrado o hash ao topo do sort, gastando uma vaga do
 * pool de candidatos. Evidência mais recente e específica (play sem vídeo
 * depois da confirmação de cache) manda.
 */
function markBad(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.badTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  if (!isSupportedHash(hash)) { metrics.count('magnetdb.hash.refused'); return; }
  const now = Date.now();
  // `mark_bad` apaga o `alive` do mesmo hash na MESMA transação, mas a ponte
  // só informa se o `bad` nasceu — sem olhar a janela do alive aqui, o agregado
  // ficaria contando um vivo que o núcleo já apagou até a sentinela do boot.
  // `remaining` consulta a chave `alive` direto (não passa pela precedência
  // bad > lie > alive), então enxerga o alive mesmo quando há `lie`.
  const hadAlive = magnetState().remaining(adapterId, apiKey, 'alive', hash, now) !== null;
  // `true` = o bad nasceu agora; o alive do mesmo hash sai na mesma transação.
  const born = magnetState().markBad(adapterId, apiKey, hash, ttl, now);
  if (born || hadAlive) {
    const totals = getOrCreateAdapter(adapterId);
    if (born) {
      totals.bad += 1;
      totals.ttlRemainingSums.bad += ttl;
    }
    if (hadAlive) {
      totals.alive = Math.max(0, totals.alive - 1);
      totals.ttlRemainingSums.alive = Math.max(0, totals.ttlRemainingSums.alive - config.magnetDb.aliveTtl);
    }
    markMutation();
    schedulePersistentSave();
  }
  metrics.count('magnetdb.bad.set');
}

function isBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'bad'
    : false;
}

/**
 * Esquece um registro `bad`, SEM tocar em alive/lie do mesmo hash. É a função
 * do REPARO do dano do F3: um ramo antigo do warmer marcava `bad` no hash cuja
 * resposta era `blocked` — recusa legal (HTTP 451/error_code 35) do
 * Real-Debrid, não magnet quebrado. Recusa legal não grava `blocked` no
 * magnetdb, e NoVideoError legítimo não grava blocked no ledger; portanto
 * `bad + blocked` por definição é aquela escrita equivocada e pode ser
 * desfeita com segurança. Retorna true se havia um registro para apagar.
 */
function forgetBad(adapterId: string, apiKey: string, hash: string): boolean {
  const removed = magnetState().forgetBad(adapterId, apiKey, hash);
  // O antigo `onForget` do cache decrementava o agregado aqui; a escrita agora
  // é nativa e não passa pelo Node, então o decremento é explícito.
  if (removed) {
    const totals = adapterCounts.get(adapterId);
    if (totals) {
      totals.bad = Math.max(0, totals.bad - 1);
      totals.ttlRemainingSums.bad = Math.max(0, totals.ttlRemainingSums.bad - config.magnetDb.badTtl);
      markMutation();
      schedulePersistentSave();
    }
  }
  return removed;
}

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

/** Há vídeo, mas o post prometeu áudio PT e os arquivos provaram release EN. */
function markLie(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.lieTtl;
  if (!config.magnetDb.enabled || !config.magnetDb.lieEnabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  if (!isSupportedHash(hash)) { metrics.count('magnetdb.hash.refused'); return; }
  // `lie` NÃO apaga o alive do mesmo hash: o magnet toca, só não é dublado.
  const born = magnetState().markLie(adapterId, apiKey, hash, ttl, Date.now());
  if (born) {
    const totals = getOrCreateAdapter(adapterId);
    totals.lie += 1;
    totals.ttlRemainingSums.lie += ttl;
    markMutation();
    schedulePersistentSave();
  }
  metrics.count('magnetdb.lie.set');
}

function isLie(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && config.magnetDb.lieEnabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'lie'
    : false;
}

// Variantes de LEITURA SEM EFEITO (P5 diagnóstico): a leitura nativa também não
// aquece LRU, não conta hit/miss e não promove nada — diagnóstico não pode
// aquecer o cache de produção nem poluir a medição. Mesma semântica de
// isAlive/isBad/isLie.
//
// A precedência `bad > lie > alive` é do NÚCLEO: `state()` devolve o veredito
// único do hash, então as três leituras nunca divergem entre si nem dependem da
// ordem em que o pipeline consulta.
function peekAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'alive'
    : false;
}
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
 * Renovação ECONÔMICA para o atalho do davail: regrava só o hash cujo alive
 * está na segunda metade do TTL. O hit do L1 não é evidência nova — é a mesma
 * confirmação de antes —, e regravar o histórico inteiro em todo hit de título
 * popular virava escrita recorrente sem ganho: quem está no começo do TTL de
 * 7 dias desempata igual. Entrada sem registro (expirou) também renova — o
 * davail acabou de confirmar o positivo; hash com `bad` NÃO renova (bad vence,
 * e a renovação não pode ressuscitá-lo pela janela do davail).
 */
function renewAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  const now = Date.now();
  const stale = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter((hash) => {
    if (!hash || isBad(adapterId, apiKey, hash)) return false;
    const remaining = magnetState().remaining(adapterId, apiKey, 'alive', hash, now);
    return remaining == null || remaining < ttl / 2;
  });
  markAlive(adapterId, apiKey, stale);
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
  markAlive, isAlive, peekAlive, markBad, isBad, peekBad,
  forgetBad, forgetBadOf, markLie, isLie, peekLie,
  renewAlive, status,
};
