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
import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import { accountScope } from './request-key.js';
import { prefix, magMetaCountsKey } from './cache-keys.js';
import { emptyAdapterTotals, rebuildFromL1, type AdapterTotals, type MagSide } from './magnetdb-counts.js';

export type { AdapterTotals };

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
  counters: {
    aliveSet: number; badSet: number; lieSet: number; dropped: number;
    droppedBad: number; droppedDead: number; droppedLie: number; badClearedBlocked: number;
  };
  _origem: Record<string, MagnetDbOrigem>;
};

type PersistentCountsPayload = { version: 1; updatedAt: number; adapters: Record<string, AdapterTotals> };

const adapterCounts = new Map<string, AdapterTotals>();

function getOrCreateAdapter(adapterId: string): AdapterTotals {
  let totals = adapterCounts.get(adapterId);
  if (!totals) {
    totals = emptyAdapterTotals();
    adapterCounts.set(adapterId, totals);
  }
  return totals;
}

let persistTimer: ReturnType<typeof setImmediate> | null = null;

function savePersistentCounts() {
  if (persistTimer) { clearImmediate(persistTimer); persistTimer = null; }
  if (!config.magnetDb.enabled) return;
  const adapters: Record<string, AdapterTotals> = Object.create(null);
  for (const [id, totals] of adapterCounts) {
    if (totals.alive > 0 || totals.bad > 0 || totals.lie > 0) {
      adapters[id] = { alive: totals.alive, bad: totals.bad, lie: totals.lie, ttlRemainingSums: { ...totals.ttlRemainingSums } };
    }
  }
  const payload: PersistentCountsPayload = { version: 1, updatedAt: Date.now(), adapters };
  cache.set(magMetaCountsKey(), payload, Math.max(config.magnetDb.aliveTtl, 7 * 86400));
}

function schedulePersistentSave() {
  if (persistTimer) return;
  persistTimer = setImmediate(() => { persistTimer = null; savePersistentCounts(); });
  persistTimer.unref?.();
}

function loadPersistentCounts() {
  const ns = cache.snapshot().namespaces as Record<string, { entries?: number }>;
  if ((ns?.mag?.entries || 0) === 0) { adapterCounts.clear(); return; }
  const raw = cache.peek(magMetaCountsKey()) as PersistentCountsPayload | null;
  adapterCounts.clear();
  if (!raw || typeof raw !== 'object' || !raw.adapters) {
    // Agregado ausente/ilegível com o L1 cheio: reconta do próprio L1 e
    // regrava. Devolver zero aqui seria mentira rotulada de `duravel`.
    for (const [id, totals] of rebuildFromL1()) adapterCounts.set(id, totals);
    if (adapterCounts.size > 0) schedulePersistentSave();
    return;
  }
  const now = Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - (raw.updatedAt || now)) / 1000));
  for (const [id, totals] of Object.entries(raw.adapters)) {
    if (!totals) continue;
    const alive = Math.max(0, Number(totals.alive) || 0);
    const bad = Math.max(0, Number(totals.bad) || 0);
    const lie = Math.max(0, Number(totals.lie) || 0);
    const rawTtl = totals.ttlRemainingSums || { alive: 0, bad: 0, lie: 0 };
    if (alive > 0 || bad > 0 || lie > 0) {
      adapterCounts.set(id, {
        alive, bad, lie,
        ttlRemainingSums: {
          alive: Math.max(0, (Number(rawTtl.alive) || 0) - elapsedSec * alive),
          bad: Math.max(0, (Number(rawTtl.bad) || 0) - elapsedSec * bad),
          lie: Math.max(0, (Number(rawTtl.lie) || 0) - elapsedSec * lie),
        },
      });
    }
  }
}

loadPersistentCounts();

cache.onForget((key: string) => {
  if (!key.startsWith(prefix('mag'))) return;
  const parts = key.split(':');
  const side = parts[2] as MagSide;
  const adapterId = parts[3];
  if (!side || !adapterId) return;
  const totals = adapterCounts.get(adapterId);
  if (!totals) return;
  if (side === 'alive') {
    totals.alive = Math.max(0, totals.alive - 1);
    totals.ttlRemainingSums.alive = Math.max(0, totals.ttlRemainingSums.alive - config.magnetDb.aliveTtl);
  } else if (side === 'bad') {
    totals.bad = Math.max(0, totals.bad - 1);
    totals.ttlRemainingSums.bad = Math.max(0, totals.ttlRemainingSums.bad - config.magnetDb.badTtl);
  } else if (side === 'lie') {
    totals.lie = Math.max(0, totals.lie - 1);
    totals.ttlRemainingSums.lie = Math.max(0, totals.ttlRemainingSums.lie - config.magnetDb.lieTtl);
  }
  schedulePersistentSave();
});

const magKey = (side: MagSide, adapterId: string, apiKey: string, hash: string) =>
  `${prefix('mag')}${side}:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
const aliveKey = (adapterId: string, apiKey: string, hash: string) => magKey('alive', adapterId, apiKey, hash);
const badKey = (adapterId: string, apiKey: string, hash: string) => magKey('bad', adapterId, apiKey, hash);
const lieKey = (adapterId: string, apiKey: string, hash: string) => magKey('lie', adapterId, apiKey, hash);

/**
 * Grava em lote que os hashes tocariam na hora nesta conta. Chamado quando a
 * checagem de cache do debrid confirma o positivo e quando o /resolve devolve
 * link de verdade. Regravar um hash já vivo só renova o TTL.
 */
function markAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  // Sem isto o cache.forget(alive) do markBad é desfeito por cache-check na checagem seguinte.
  const unique = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter(Boolean);
  const allowed = unique.filter((hash) => !isBad(adapterId, apiKey, hash));
  const refused = unique.length - allowed.length;
  if (refused > 0) metrics.count('magnetdb.alive.refused-bad', refused);
  const writes = allowed.map((hash) => ({
    key: aliveKey(adapterId, apiKey, hash),
    value: 1,
    ttlSeconds: ttl,
  }));
  if (writes.length === 0) return;

  let newAliveCount = 0;
  for (const write of writes) {
    if (!cache.has(write.key)) {
      newAliveCount++;
    }
  }

  cache.setMany(writes);

  if (newAliveCount > 0) {
    const totals = getOrCreateAdapter(adapterId);
    totals.alive += newAliveCount;
    totals.ttlRemainingSums.alive += newAliveCount * ttl;
    schedulePersistentSave();
  }
  metrics.count('magnetdb.alive.set', writes.length);
}

function isAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash ? cache.get(aliveKey(adapterId, apiKey, hash)) === 1 : false;
}

/**
 * Grava que o hash provou estar quebrado nesta conta (torrent sem arquivo de
 * vídeo no play). TTL próprio: torrent pode ganhar upload novo, então o
 * negativo também envelhece.
 *
 * bad VENCE sobre alive: as janelas de TTL são distintas (24h contra 7 dias),
 * então os dois podem coexistir no mesmo hash — e aí o comportamento seria
 * indefinido (o filtro pré-checagem corta, mas o instantSet já o empurrou ao
 * topo do sort, gastando uma vaga do pool de candidatos). Evidência mais
 * recente e específica (play sem vídeo depois da confirmação de cache) manda.
 */
function markBad(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.badTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  const key = badKey(adapterId, apiKey, hash);
  const alive = aliveKey(adapterId, apiKey, String(hash || '').toLowerCase());
  const badExisted = cache.has(key);

  cache.set(key, 1, ttl);
  // O alive não pode sobreviver ao bad no mesmo hash: sem o forget ele
  // continuaria desempatando o sort por até 7 dias num magnet que provou
  // estar quebrado.
  cache.forget(alive);

  if (!badExisted) {
    const totals = getOrCreateAdapter(adapterId);
    totals.bad += 1;
    totals.ttlRemainingSums.bad += ttl;
    schedulePersistentSave();
  }
  metrics.count('magnetdb.bad.set');
}

function isBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash ? cache.get(badKey(adapterId, apiKey, hash)) === 1 : false;
}

/**
 * Esquece um registro `bad` (e a amostra local), SEM tocar em alive/lie do
 * mesmo hash. É a função do REPARO do dano do F3: um ramo antigo do warmer
 * marcava `bad` no hash cuja resposta era `blocked` — recusa legal
 * (HTTP 451/error_code 35) do Real-Debrid, não magnet quebrado. Recusa legal
 * não grava `blocked` no magnetdb, e NoVideoError legítimo não grava blocked
 * no ledger; portanto `bad + blocked` por definição é aquela escrita
 * equivocada e pode ser desfeita com segurança. Retorna true se havia um
 * registro para apagar.
 */
function forgetBad(adapterId: string, apiKey: string, hash: string): boolean {
  return forgetBadKey(badKey(adapterId, apiKey, hash));
}

/**
 * Apaga um `bad` pela chave crua (usada pela varredura de reparo que enumera
 * o L1 por prefixo de adapter). Idempotente: segunda passada devolve false
 * porque a chave já não existe. `alive`/`lie` do mesmo hash não são tocados.
 */
function forgetBadKey(key: string): boolean {
  // `has` e não `peek`: entrada vencida que ainda espera a poda está no store
  // e É apagada aqui — com peek ela sairia do cache reportando `cleared: 0`,
  // e o operador leria "nada a limpar" logo depois de limpar. Mesmo critério
  // de presença física que markAlive/markBad/markLie usam para contar.
  const existed = cache.has(key);
  cache.forget(key);
  return existed;
}

/** Há vídeo, mas o post prometeu áudio PT e os arquivos provaram release EN. */
function markLie(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.lieTtl;
  if (!config.magnetDb.enabled || !config.magnetDb.lieEnabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  const key = lieKey(adapterId, apiKey, hash);
  const lieExisted = cache.has(key);

  cache.set(key, 1, ttl);

  if (!lieExisted) {
    const totals = getOrCreateAdapter(adapterId);
    totals.lie += 1;
    totals.ttlRemainingSums.lie += ttl;
    schedulePersistentSave();
  }

  metrics.count('magnetdb.lie.set');
}

function isLie(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && config.magnetDb.lieEnabled && adapterId && apiKey && hash ? cache.get(lieKey(adapterId, apiKey, hash)) === 1 : false;
}

// Variantes de LEITURA SEM EFEITO (P5 diagnóstico): `cache.peek` não promove o
// LRU nem conta hit/miss — leitura de diagnóstico não pode aquecer o cache de
// produção nem poluir a medição. Mesma semântica, outro instrumento: quem
// consulta é um operador explicando o que SUMIU, não o pipeline decidindo.
function peekAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash ? cache.peek(aliveKey(adapterId, apiKey, hash)) === 1 : false;
}
function peekBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash ? cache.peek(badKey(adapterId, apiKey, hash)) === 1 : false;
}
function peekLie(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && config.magnetDb.lieEnabled && adapterId && apiKey && hash ? cache.peek(lieKey(adapterId, apiKey, hash)) === 1 : false;
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
  const stale = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter((hash) => {
    if (!hash || isBad(adapterId, apiKey, hash)) return false;
    const remaining = cache.peekRemaining(aliveKey(adapterId, apiKey, hash));
    return remaining == null || remaining < ttl / 2;
  });
  markAlive(adapterId, apiKey, stale);
}

/**
 * Estado de diagnóstico do painel.
 * - sizeAlive/Bad/Lie + byAdapter: contagens duráveis agregadas por adapter.
 * - l1Entries/l1Max: ocupação real do namespace mag no L1 (snapshot do cache).
 * - evictedQuota: quantas vezes a cota mag girou (métrica, não scan).
 * - `_origem` durável: contagens refletem estado durável.
 */
function status(): MagnetDbStatus {
  const ns = cache.snapshot().namespaces as Record<string, { entries?: number; maxEntries?: number }>;
  const magNs = ns?.mag;
  const l1Entries = magNs?.entries || 0;

  if (l1Entries === 0) {
    adapterCounts.clear();
  } else if (adapterCounts.size === 0) {
    loadPersistentCounts();
  }

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
    l1Max: magNs?.maxEntries || cache.QUOTAS?.mag || 0,
    evictedQuota: counters['cache.evicted.quota.mag'] || 0,
    counters: {
      aliveSet: counters['magnetdb.alive.set'] || 0, badSet: counters['magnetdb.bad.set'] || 0,
      lieSet: counters['magnetdb.lie.set'] || 0, dropped: counters['magnetdb.dropped'] || 0,
      droppedBad: counters['magnetdb.dropped.bad'] || 0, droppedDead: counters['magnetdb.dropped.dead'] || 0,
      droppedLie: counters['magnetdb.dropped.lie'] || 0, badClearedBlocked: counters['magnetdb.bad.clearedBlocked'] || 0,
    },
    _origem: {
      enabled: 'duravel', aliveTtlSeconds: 'duravel', badTtlSeconds: 'duravel', lieTtlSeconds: 'duravel',
      sizeAlive: 'duravel', sizeBad: 'duravel', sizeLie: 'duravel', ttlRemainingSeconds: 'duravel',
      byAdapter: 'duravel', l1Entries: 'duravel', l1Max: 'duravel', evictedQuota: 'duravel',
    },
  };
}

export {
  markAlive, isAlive, peekAlive, markBad, isBad, peekBad,
  forgetBad, forgetBadKey, markLie, isLie, peekLie,
  renewAlive, status, savePersistentCounts, loadPersistentCounts,
};
