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
import { promoteCachedBoltsAcrossStreams } from './rd-probe.js';

type WarmEntry = {
  hash: string;
  score: number;
  enqueuedAt: number;
};

const QUEUE_KEY = `${prefix('rdq')}wq`;

// Prefixo das chaves `bad` do magnetdb escopadas ao Real-Debrid (qualquer
// conta): é o que delimita o reparo seletivo dos hashes que a varredura
// correlaciona com o ledger `blocked`.
const BAD_RD_PREFIX = `${prefix('mag')}bad:realdebrid:`;

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

/**
 * Credencial RD observada numa requisição real. A config selada na URL do app
 * nunca chega ao `.env`, então sem isto o warmer fica permanentemente inerte
 * numa instalação que só configura o debrid pelo link de instalação — e sem
 * nenhum log dizendo por quê.
 *
 * Vive SÓ em memória do processo: nunca é persistida no cache nem logada.
 */
let notedApiKey = '';

/** Registra a chave RD efetiva de uma requisição que de fato usou Real-Debrid. */
function noteCredential(apiKey: string): void {
  const key = String(apiKey || '');
  if (!key || key === notedApiKey) return;
  const first = !notedApiKey;
  notedApiKey = key;
  if (first) log.info('[rd-warmer] credencial RD vista numa requisição; aquecimento habilitado');
}

/**
 * Chave para o aquecimento. O `.env` do operador tem precedência — é a conta
 * que ele escolheu gastar; sem ela, vale a última credencial vista numa
 * requisição com Real-Debrid.
 */
function resolveApiKey(): string | null {
  if (!config.debrid.rdWarm.enabled) return null;
  // Gate de OPERADOR (conta do .env), não o de herança para installs.
  if (config.debrid.service === 'realdebrid' && config.debrid.apiKey && config.debrid.envOperatorAccount) {
    return config.debrid.apiKey;
  }
  return notedApiKey || null;
}

/** Real-Debrid está em uso aqui, seja pelo `.env` ou pela config da URL. */
function rdInPlay(): boolean {
  return Boolean(resolveApiKey());
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
  const apiKey = resolveApiKey();
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
        promoteCachedBoltsAcrossStreams([hash]);
      } else if (result.reason === 'blocked') {
        rdLedger.noteBlocked(hash);
        // Recusa legal do Real-Debrid (HTTP 451 / error_code 35), não magnet
        // quebrado: não toca no magnetdb. Antes este ramo marcava `bad`, o que
        // escondia um magnet potencialmente bom e poluía o histórico — o
        // dedupe pelo `blocked` do ledger e o corte ternário do cachedOnly já
        // cobrem o que é preciso para NÃO re-sondar e NÃO prometer ⚡.
        metrics.count('debrid.rd.warm.blocked');
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
  const apiKey = resolveApiKey();
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

/** Último token 40-hex de uma chave `bad` = hash do conteúdo (sem expor digest de conta). */
function hashFromBadKey(key: string): string {
  const last = key.split(':').pop() || '';
  return /^[a-f0-9]{40}$/.test(last) ? last : '';
}

/**
 * Reparo idempotente dos bads que um ramo antigo deste mesmo warmer gravou:
 * hash que o Real-Debrid recusou por lei (HTTP 451) era marcado `bad` no
 * magnetdb. Recusa legal NÃO é magnet quebrado — e o NoVideoError legítimo
 * nunca grava `blocked` no ledger, então `bad + blocked` é, por definição,
 * esse dano. Varre o L1 (carregado do SQLite no boot) uma vez por processo e
 * apaga o `bad` de todo hash RD cujo ledger diga `blocked`. Não usa clear
 * amplo nem bump de namespace; a segunda execução encontra nada e devolve 0.
 * Entradas tardias/L2 são cobertas pelo self-healing no applyDebrid.
 */
function scanBlockedRdBads(): number {
  if (!config.debrid.rdLedger.enabled) return 0;
  let cleared = 0;
  for (const key of cache.keysMatching(BAD_RD_PREFIX)) {
    const hash = hashFromBadKey(key);
    if (!hash || rdLedger.peekQuiet(hash) !== 'blocked') continue;
    if (magnetdb.forgetBadKey(key)) {
      cleared += 1;
      metrics.count('magnetdb.bad.clearedBlocked');
    }
  }
  if (cleared) {
    // As listas prontas foram construídas SEM esses hashes; só limpar o bad não
    // os reinsere. Invalida streams uma vez no reparo para a próxima abertura
    // reconstruir a lista a partir do índice/raw já persistido.
    cache.clearNamespace('streams');
    log.info(`[rd-warmer] ${cleared} bad(s) RD recusa legal recuperado(s); cache de streams invalidado`);
  }
  return cleared;
}

/**
 * Inicia o timer em background do warmer.
 */
function start(): void {
  if (started) return;
  started = true;
  ensureQueueLoaded();
  // Reparo do dano do ramo antigo roda no boot, mesmo com o warmer desativado
  // (os bads persistem no L2 e não dependem de o aquecimento estar ligado).
  try {
    scanBlockedRdBads();
  } catch (err) {
    log.warn('[rd-warmer] varredura de reparo falhou:', (err as Error)?.message || err);
  }
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
function status(): { enabled: boolean; queueDepth: number; lastTickAt: number | null; paused: boolean; processedLastHour: number } {
  ensureQueueLoaded();
  return {
    enabled: config.debrid.rdWarm.enabled,
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
  notedApiKey = '';
  hourBuckets.clear();
}

export { enqueue, tick, start, drain, setPaused, status, reset, scanBlockedRdBads, noteCredential, rdInPlay };
export default { enqueue, tick, start, drain, setPaused, status, reset, scanBlockedRdBads, noteCredential, rdInPlay };
