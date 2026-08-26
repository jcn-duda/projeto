// Warmer contínuo em fundo para o Real-Debrid (Fase F3).
//
// Consome hashes desconhecidos da fila persistente em background, mantendo
// o ledger durável aquecido sem atrasar a resposta do usuário e respeitando
// a taxa de consultas (AIMD / rdGate / teto horário).
import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import * as realdebrid from '../debrid/realdebrid.js';
import * as held from '../debrid/protected.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as autofetch from './autofetch.js';
import * as activity from './activity.js';
import { prefix } from '../utils/cache-keys.js';
import { accountScope } from '../utils/request-key.js';
import { rdGate } from '../debrid/rd-gate.js';
import { isRateLimitError, isQuotaError } from '../debrid/common.js';

type WarmEntry = {
  hash: string;
  score: number;
  enqueuedAt: number;
};

const QUEUE_KEY = `${prefix('rdc')}wq`;

let queue: WarmEntry[] = [];
let loaded = false;
let started = false;
let inFlight = false;
let paused = false;
let lastTickAt = 0;
const hourBuckets = new Map<number, number>();

function ensureQueueLoaded(): void {
  if (loaded) return;
  loaded = true;
  loadQueue();
}

function loadQueue(): void {
  const stored = cache.get(QUEUE_KEY);
  if (Array.isArray(stored)) {
    queue = stored
      .filter((e) => e && /^[a-f0-9]{40}$/i.test(String(e.hash)))
      .map((e) => ({
        hash: String(e.hash).toLowerCase(),
        score: Number(e.score) || 0,
        enqueuedAt: Number(e.enqueuedAt) || Date.now(),
      }));
    queue.sort((a, b) => b.score - a.score || a.enqueuedAt - b.enqueuedAt);
  }
}

function persistQueue(): void {
  if (!queue.length) {
    cache.forget(QUEUE_KEY);
    return;
  }
  cache.set(QUEUE_KEY, queue.slice(0, config.debrid.rdWarm.queueMax), 30 * 24 * 3600);
}

function queriesThisHour(): number {
  const hour = Math.floor(Date.now() / 3_600_000);
  for (const bucket of [...hourBuckets.keys()]) {
    if (bucket < hour) hourBuckets.delete(bucket);
  }
  return hourBuckets.get(hour) || 0;
}

function noteQueries(count: number): void {
  const hour = Math.floor(Date.now() / 3_600_000);
  hourBuckets.set(hour, (hourBuckets.get(hour) || 0) + count);
}

function getEnvApiKey(): string | null {
  if (config.debrid.service !== 'realdebrid' && typeof (realdebrid as any).probeInstant !== 'function') return null;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.rdWarm.enabled) return null;
  return config.debrid.apiKey;
}

/**
 * Enfileira hashes para aquecimento em fundo. Custo zero, sem rede.
 * Deduplica por hash e reordena por score decrescente.
 */
function enqueue(hashes: string[], score = 0): void {
  if (!config.debrid.rdWarm.enabled) return;
  if (!Array.isArray(hashes) || hashes.length === 0) return;
  ensureQueueLoaded();

  const valid = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter((h) => /^[a-f0-9]{40}$/.test(h));
  if (!valid.length) return;

  const existingMap = new Map<string, WarmEntry>();
  for (const entry of queue) {
    existingMap.set(entry.hash, entry);
  }

  let added = 0;
  const now = Date.now();
  for (const hash of valid) {
    if (config.debrid.rdLedger.enabled && (rdLedger.isHit(hash) || rdLedger.peek(hash) === 'blocked')) {
      continue;
    }
    const existing = existingMap.get(hash);
    if (existing) {
      if (score > existing.score) {
        existing.score = score;
      }
    } else {
      const entry: WarmEntry = { hash, score, enqueuedAt: now };
      queue.push(entry);
      existingMap.set(hash, entry);
      added += 1;
    }
  }

  queue.sort((a, b) => b.score - a.score || a.enqueuedAt - b.enqueuedAt);
  if (queue.length > config.debrid.rdWarm.queueMax) {
    queue = queue.slice(0, config.debrid.rdWarm.queueMax);
  }
  persistQueue();
  if (added > 0) {
    metrics.count('debrid.rd.warm.queued', added);
  }
}

async function processBatch(maxItems: number): Promise<number> {
  ensureQueueLoaded();
  const apiKey = getEnvApiKey();
  if (!apiKey) return 0;
  const account = accountScope(apiKey);
  if (rdGate.isCoolingDown(account)) return 0;
  if (queriesThisHour() >= config.debrid.rdWarm.maxPerHour) return 0;

  let processedCount = 0;
  const limit = Math.max(0, Math.min(maxItems, config.debrid.rdWarm.maxPerHour - queriesThisHour()));

  while (processedCount < limit && queue.length) {
    if (activity.recentUserTraffic(config.debrid.rdWarm.idleWindowMs)) break;
    if (rdGate.isCoolingDown(account)) break;

    const entry = queue.shift();
    if (!entry) break;
    persistQueue();

    const hash = entry.hash;
    if (config.debrid.rdLedger.enabled && (rdLedger.isHit(hash) || rdLedger.peek(hash) === 'blocked' || rdLedger.peek(hash) === 'miss')) {
      continue;
    }
    if (held.isHeld(hash, account)) {
      continue;
    }
    if (cache.get(autofetch.markerKey('realdebrid', account, hash))) {
      continue;
    }
    if (magnetdb.isBad('realdebrid', apiKey, hash)) {
      continue;
    }

    try {
      const result = await realdebrid.probeInstant(apiKey, hash);
      noteQueries(1);
      processedCount += 1;
      metrics.count('debrid.rd.warm.processed');
      if (result.instant) {
        rdLedger.noteHit([hash]);
        magnetdb.markAlive('realdebrid', apiKey, [hash]);
        metrics.count('debrid.rd.warm.hit');
      } else if (result.reason === 'blocked') {
        rdLedger.noteBlocked(hash);
        magnetdb.markBad('realdebrid', apiKey, hash);
        metrics.count('debrid.rd.warm.miss');
      } else {
        rdLedger.noteMiss(hash);
        metrics.count('debrid.rd.warm.miss');
      }
    } catch (err: unknown) {
      if (isRateLimitError(err) || isQuotaError(err)) {
        metrics.count('debrid.rd.warm.requeued');
        queue.unshift(entry);
        persistQueue();
        break;
      }
      noteQueries(1);
      processedCount += 1;
      metrics.count('debrid.rd.warm.processed');
      rdLedger.noteMiss(hash);
      metrics.count('debrid.rd.warm.miss');
      log.warn(`[rd-warmer] falha em ${hash.slice(0, 8)}:`, (err as Error)?.message || err);
    }
  }

  return processedCount;
}

/**
 * Um passo do ciclo: consome até rdWarmBatch hashes da fila.
 * Exportado para teste cobrir contabilidade sem subir timer.
 */
async function tick(): Promise<void> {
  if (paused || inFlight || !config.debrid.rdWarm.enabled) return;
  if (activity.recentUserTraffic(config.debrid.rdWarm.idleWindowMs)) return;
  const apiKey = getEnvApiKey();
  if (!apiKey) return;
  const account = accountScope(apiKey);
  if (rdGate.isCoolingDown(account)) return;
  if (queriesThisHour() >= config.debrid.rdWarm.maxPerHour) return;
  ensureQueueLoaded();
  if (!queue.length) return;

  inFlight = true;
  lastTickAt = Date.now();
  try {
    await processBatch(config.debrid.rdWarm.batch);
  } finally {
    inFlight = false;
  }
}

/**
 * Inicia o timer em background do warmer.
 */
function start(): void {
  if (started) return;
  started = true;
  ensureQueueLoaded();
  if (!config.debrid.rdWarm.enabled) {
    log.info('[rd-warmer] desativado');
    return;
  }
  if (queue.length) {
    log.info(`[rd-warmer] fila recuperada: ${queue.length} hash(es)`);
  }
  const timer = setInterval(() => {
    tick().catch((err) => log.warn('[rd-warmer] tick falhou:', (err as Error)?.message || err));
  }, config.debrid.rdWarm.intervalMs);
  timer.unref();
}

/**
 * Drena até `max` itens imediatamente, sem furar freios operacionais.
 */
async function drain(max = config.debrid.rdWarm.batch): Promise<{ processed: number; queueRemaining: number }> {
  ensureQueueLoaded();
  if (paused || inFlight || !config.debrid.rdWarm.enabled) {
    return { processed: 0, queueRemaining: queue.length };
  }
  if (activity.recentUserTraffic(config.debrid.rdWarm.idleWindowMs)) {
    return { processed: 0, queueRemaining: queue.length };
  }
  inFlight = true;
  lastTickAt = Date.now();
  let processed = 0;
  try {
    processed = await processBatch(max);
  } finally {
    inFlight = false;
  }
  return { processed, queueRemaining: queue.length };
}

/** Pausa operacional em memória. */
function setPaused(v: boolean): void {
  paused = Boolean(v);
}

/** Estado operacional do warmer. */
function status(): { queueDepth: number; lastTickAt: number | null; paused: boolean; processedLastHour: number } {
  ensureQueueLoaded();
  return {
    queueDepth: queue.length,
    lastTickAt: lastTickAt || null,
    paused,
    processedLastHour: queriesThisHour(),
  };
}

function reset(): void {
  queue = [];
  loaded = false;
  started = false;
  inFlight = false;
  paused = false;
  lastTickAt = 0;
  hourBuckets.clear();
}

export { enqueue, tick, start, drain, setPaused, status, reset };
export default { enqueue, tick, start, drain, setPaused, status, reset };
