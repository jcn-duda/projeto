import crypto from 'node:crypto';
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';

const pending = new Map();
const searchSlots = new Map();
const LOCK_TTL_MS = 60_000;

// Janela deslizante de 1h de enqueues por adapter:account
const hourlyEnqueues = new Map<string, number[]>();
const hourlyLimits = new Map<string, number>();
const budgetBlocked = new Map<string, number>();
// Índices de diagnóstico deste processo. As filas/blacklists continuam no
// cache persistente; estes sets só permitem contar sem enumerar chaves privadas.
const knownQueues = new Map<string, number>();
const knownDead = new Set<string>();

function sha256(str: string) {
  return crypto.createHash('sha256').update(String(str || '')).digest('hex');
}

function markerKey(adapterId: string, account: string, infoHash: string) {
  return `${prefix('autofetch')}m:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

function deadKey(adapterId: string, account: string, infoHash: string) {
  return `${prefix('autofetch')}dead:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

function queueKey(searchKey: string) {
  return `${prefix('autofetch')}q:${sha256(searchKey)}`;
}

function prefetchKey(account: string, id: string, s: number | string, e: number | string) {
  return `${prefix('autofetch')}pf:${account}:${id}:${s}:${e}`;
}

/**
 * Trava apenas enquanto a API responde. Persistir antes do aceite criava seis
 * horas de falso positivo quando o processo reiniciava ou a chamada falhava.
 */
function acquire(key: string) {
  if (pending.has(key)) return false;
  const token = Symbol(key);
  pending.set(key, token);
  setTimeout(() => {
    if (pending.get(key) === token) pending.delete(key);
  }, LOCK_TTL_MS).unref();
  return true;
}

function release(key: string) {
  pending.delete(key);
}

/**
 * Contador de vagas por busca, compartilhado entre o passe parcial e o tardio
 * (os dois usam o mesmo searchKey). Substitui o boolean antigo: permitia só um
 * torrent por busca, qualquer que fosse; agora cabem até `max` candidatos.
 *
 * A TTL limpa a entrada inteira quando a busca morre (o lote tardio pode
 * terminar dezenas de segundos depois); cada `releaseSearchSlot` em refusa/erro
 * devolve a vaga sem vazar o contador.
 */
function acquireSearchSlot(searchKey: string, max = 1) {
  if (!searchKey) return false;
  const limit = Math.max(1, Math.trunc(Number(max) || 1));
  const entry = searchSlots.get(searchKey);
  if (entry) {
    if (entry.used >= limit) return false;
    entry.used += 1;
    return true;
  }
  const token = Symbol(searchKey);
  searchSlots.set(searchKey, { used: 1, token });
  setTimeout(() => {
    if (searchSlots.get(searchKey)?.token === token) searchSlots.delete(searchKey);
  }, LOCK_TTL_MS).unref();
  return true;
}

function releaseSearchSlot(searchKey: string) {
  const entry = searchSlots.get(searchKey);
  if (!entry) return;
  entry.used -= 1;
  if (entry.used <= 0) searchSlots.delete(searchKey);
}

/** Compatibilidade com o contrato antigo: uma vaga só por busca. */
function acquireSearch(searchKey: string) {
  return acquireSearchSlot(searchKey, 1);
}

function releaseSearch(searchKey: string) {
  releaseSearchSlot(searchKey);
}

/** Blacklist por adapter:account:hash com TTL 24h */
function isDead(adapterId: string, account: string, infoHash: string): boolean {
  if (!adapterId || !account || !infoHash) return false;
  return cache.get(deadKey(adapterId, account, infoHash)) === 1;
}

function blacklist(
  adapterId: string,
  account: string,
  infoHash: string,
  ttlSeconds = config.debrid.autoFetchDeadTtl,
) {
  if (!adapterId || !account || !infoHash) return;
  const key = deadKey(adapterId, account, infoHash);
  cache.set(key, 1, ttlSeconds);
  knownDead.add(key);
}

/** Fila persistente de candidatos excedentes */
interface QueueCandidate {
  infoHash: string;
  name?: string;
  title?: string;
  quality?: string;
  seeders?: number;
  br?: boolean;
  dubbed?: boolean;
  pool?: string;
  imdbId?: string;
  isPack?: boolean;
  season?: number | null;
  episode?: number | null;
  addedAt?: number;
  [key: string]: unknown;
}

function readQueue(searchKey: string): QueueCandidate[] {
  if (!searchKey) return [];
  const hit = cache.get(queueKey(searchKey));
  return Array.isArray(hit) ? hit : [];
}

function writeQueue(
  searchKey: string,
  candidates: QueueCandidate[],
  ttlSeconds = config.debrid.autoFetchQueueTtl,
  adapterId?: string,
  account?: string,
) {
  if (!searchKey) return;
  const seen = new Set<string>();
  const clean: QueueCandidate[] = [];
  const depth = config.debrid.autoFetchQueueDepth;

  for (const c of candidates) {
    if (!c?.infoHash) continue;
    const hash = String(c.infoHash).toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (adapterId && account && isDead(adapterId, account, hash)) continue;
    clean.push({ ...c, infoHash: hash, addedAt: c.addedAt || Date.now() });
    if (clean.length >= depth) break;
  }

  if (clean.length > 0) {
    const key = queueKey(searchKey);
    cache.set(key, clean, ttlSeconds);
    knownQueues.set(key, clean.length);
    metrics.count('autofetch.queue.added', clean.length);
  } else {
    const key = queueKey(searchKey);
    cache.forget(key);
    knownQueues.delete(key);
  }
}

function dropQueue(searchKey: string) {
  if (!searchKey) return;
  const k = queueKey(searchKey);
  if (cache.get(k)) {
    cache.forget(k);
    metrics.count('autofetch.queue.dropped');
  }
  knownQueues.delete(k);
}

function takeNext(
  queue: QueueCandidate[],
  skipFn?: (item: QueueCandidate) => boolean,
): { next: QueueCandidate | null; remaining: QueueCandidate[] } {
  if (!Array.isArray(queue) || queue.length === 0) {
    return { next: null, remaining: [] };
  }
  for (let i = 0; i < queue.length; i += 1) {
    const candidate = queue[i];
    if (!skipFn || !skipFn(candidate)) {
      const remaining = [...queue.slice(0, i), ...queue.slice(i + 1)];
      return { next: candidate, remaining };
    }
  }
  return { next: null, remaining: queue };
}

/**
 * Orçamento deslizante de enqueues/hora por adapter:account.
 */
function checkAndRecordBudget(adapterId: string, account: string, limit?: number): boolean {
  if (!adapterId || !account) return true;
  const key = `${adapterId}:${account}`;
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  let timestamps = (hourlyEnqueues.get(key) || []).filter((t) => t > oneHourAgo);
  const maxHourly = limit != null && Number.isFinite(limit)
    ? limit
    : config.debrid.autoFetchEnqueueMaxHour;
  hourlyLimits.set(key, maxHourly);

  if (timestamps.length >= maxHourly) {
    metrics.count('autofetch.budget');
    log.warn(
      `[autofetch] orçamento de enqueues esgotado para ${adapterId}:${account} ` +
        `(${timestamps.length}/${maxHourly} na última hora)`,
    );
    hourlyEnqueues.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  hourlyEnqueues.set(key, timestamps);
  return true;
}

function budgetKey(adapterId: string, account: string) {
  return `${adapterId}:${account}`;
}

/** Pausa a drenagem quando o limite horário já foi consumido. */
function blockBudget(adapterId: string, account: string, backoffMs: number) {
  if (!adapterId || !account || backoffMs <= 0) return;
  budgetBlocked.set(budgetKey(adapterId, account), Date.now() + backoffMs);
}

function budgetBlockedUntil(adapterId: string, account: string) {
  const key = budgetKey(adapterId, account);
  const until = budgetBlocked.get(key) || 0;
  if (until <= Date.now()) {
    budgetBlocked.delete(key);
    return 0;
  }
  return until;
}

function resetBudget(adapterId?: string, account?: string) {
  if (adapterId && account) {
    hourlyEnqueues.delete(`${adapterId}:${account}`);
    hourlyLimits.delete(`${adapterId}:${account}`);
    budgetBlocked.delete(budgetKey(adapterId, account));
  } else {
    hourlyEnqueues.clear();
    hourlyLimits.clear();
    budgetBlocked.clear();
  }
}

/** Estado operacional sem expor searchKey, conta ou infoHash. */
function snapshot() {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  let used = 0;
  let limit = 0;
  const budgets: Array<{ id: string; used: number; limit: number }> = [];
  for (const [key, raw] of hourlyEnqueues) {
    const timestamps = raw.filter((t) => t > oneHourAgo);
    hourlyEnqueues.set(key, timestamps);
    const itemLimit = hourlyLimits.get(key) || config.debrid.autoFetchEnqueueMaxHour;
    used += timestamps.length;
    limit += itemLimit;
    budgets.push({ id: sha256(key).slice(0, 12), used: timestamps.length, limit: itemLimit });
  }

  let queueItems = 0;
  for (const [key] of [...knownQueues]) {
    const value = cache.get(key);
    if (!Array.isArray(value) || value.length === 0) {
      knownQueues.delete(key);
      continue;
    }
    knownQueues.set(key, value.length);
    queueItems += value.length;
  }
  for (const key of [...knownDead]) {
    if (cache.get(key) !== 1) knownDead.delete(key);
  }
  let occupiedSlots = 0;
  for (const entry of searchSlots.values()) occupiedSlots += Number(entry?.used || 0);

  return {
    pendingLocks: pending.size,
    searchSlots: { searches: searchSlots.size, occupied: occupiedSlots },
    budget: { used, limit, accounts: budgets },
    deadBlacklistCount: knownDead.size,
    queues: { count: knownQueues.size, items: queueItems },
  };
}

export {
  LOCK_TTL_MS,
  markerKey,
  deadKey,
  queueKey,
  prefetchKey,
  acquire,
  release,
  acquireSearch,
  releaseSearch,
  acquireSearchSlot,
  releaseSearchSlot,
  isDead,
  blacklist,
  readQueue,
  writeQueue,
  dropQueue,
  takeNext,
  checkAndRecordBudget,
  blockBudget,
  budgetBlockedUntil,
  resetBudget,
  snapshot,
};
export type { QueueCandidate };

