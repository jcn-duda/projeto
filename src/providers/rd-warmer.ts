// Warmer contínuo em fundo para o Real-Debrid (Fase F3).
//
// Consome hashes desconhecidos da fila persistente em background, mantendo
// o ledger durável aquecido sem atrasar a resposta do usuário e respeitando
// a taxa de consultas (AIMD / rdGate / teto horário).
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { kvForget, kvPeek, kvSet } from '../utils/native-kv.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import * as realdebrid from '../debrid/realdebrid.js';
import * as held from '../debrid/protected.js';
import * as magnetdb from '../utils/magnetdb.js';
import { magnetState } from '../utils/debrid-state-native.js';
import * as autofetch from './autofetch.js';
import * as activity from './activity.js';
import * as harvesterDebrid from '../utils/harvester-debrid-live.js';
import { prefix } from '../utils/cache-keys.js';
import { accountScope } from '../utils/request-key.js';
import { rdGate } from '../debrid/rd-gate.js';
import { isRateLimitError, isQuotaError } from '../debrid/common.js';
import { clearNativeStreamsSoon } from '../utils/streams-store-native.js';
import { probeNativeRdWarm } from '../utils/rd-warm-native.js';

type WarmEntry = { hash: string; score: number; enqueuedAt: number };

const QUEUE_KEY = `${prefix('rdq')}wq`;
// Teto horário durável (≠ `wq`): restart não zera o teto na mesma hora civil.
const HOUR_KEY = `${prefix('rdq')}hour`;

let queue: WarmEntry[] = [];
let loaded = false;
let started = false;
// Geração do start: um `reset()` no meio da sonda nativa invalida o callback
// pendente, senão ele religaria o timer de um warmer já resetado.
let startGeneration = 0;
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
  const stored = kvPeek(QUEUE_KEY);
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
    kvForget(QUEUE_KEY);
    return;
  }
  kvSet(QUEUE_KEY, queue.slice(0, config.debrid.rdWarm.queueMax), 30 * 24 * 3600);
}

function queriesThisHour(): number {
  const hour = Math.floor(Date.now() / 3_600_000);
  for (const bucket of [...hourBuckets.keys()]) {
    if (bucket < hour) hourBuckets.delete(bucket);
  }
  // Lazy: Map vazio pós-restart reidrata do KV nativo se ainda for a hora corrente.
  if (!hourBuckets.has(hour)) {
    const stored = kvPeek(HOUR_KEY) as { hour?: unknown; count?: unknown } | null;
    const n = stored && Number(stored.hour) === hour ? Number(stored.count) : NaN;
    if (Number.isFinite(n) && n > 0) hourBuckets.set(hour, n);
  }
  return hourBuckets.get(hour) || 0;
}

function noteQueries(count: number): void {
  if (!count) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  // Hidrata antes de somar: senão o 1º note pós-restart sobrescreve o total.
  const next = queriesThisHour() + count;
  hourBuckets.set(hour, next);
  // TTL = resto da hora + 60s de folga (mín. 60): o balde some na virada.
  const ttl = Math.max(60, Math.ceil(((hour + 1) * 3_600_000 - Date.now()) / 1000) + 60);
  kvSet(HOUR_KEY, { hour, count: next }, ttl);
}

/**
 * Credencial RD observada numa requisição real. A config selada na URL do app
 * nunca chega ao `.env`, então este era o caminho que destravava o warmer numa
 * instalação configurada só pelo link de instalação.
 *
 * Vive SÓ em memória do processo: nunca é persistida no cache nem logada.
 * Fase 1 do corte TS: o único escritor era o `noteCredential`, chamado apenas
 * pelo `applyDebrid` (que saiu do `src/` no F4.4). Sem escritor, o ramo
 * `sessao` de `resolveApiKeySource` fica inalcançável; ele permanece aqui
 * porque `status()` e o painel tipam essa união — remover o ramo é outra
 * fatia, não esta.
 */
let notedApiKey = '';

/**
 * Chave para o aquecimento e a origem dela. Painel é fonte ÚNICA: RD liga,
 * AllDebrid desliga mesmo com `.env` RD; sem override, `.env` com gate de
 * operador; senão, a credencial de sessão — hoje sem escritor (ver `notedApiKey`).
 */
function resolveApiKeySource(): { apiKey: string | null; source: 'panel' | 'env' | 'sessao' | 'none' } {
  const warm = harvesterDebrid.resolveWarm();
  if (warm.source === 'panel' || warm.source === 'env') return { apiKey: warm.apiKey, source: warm.source };
  if (warm.reason === 'painel-desliga') return { apiKey: null, source: 'none' };
  return notedApiKey ? { apiKey: notedApiKey, source: 'sessao' } : { apiKey: null, source: 'none' };
}

/** Real-Debrid está em uso aqui, seja pelo `.env`, painel ou sessão. */
function rdInPlay(): boolean {
  return config.debrid.rdWarm.enabled ? Boolean(resolveApiKeySource().apiKey) : false;
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
  const apiKey = resolveApiKeySource().apiKey;
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
    if (autofetch.markerActive('realdebrid', account, hash)) {
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
        // Nada a promover no L1: desde o F4.2(c) a lista pronta de `streams`
        // vive no `streams.db` do gateway e o ⚡ entra na próxima construção
        // (o ledger que acabou de virar `hit` já responde a consulta).
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
  const apiKey = resolveApiKeySource().apiKey;
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
 * Reparo idempotente dos bads que um ramo antigo deste mesmo warmer gravou:
 * hash que o Real-Debrid recusou por lei (HTTP 451) era marcado `bad` no
 * magnetdb. Recusa legal NÃO é magnet quebrado — e o NoVideoError legítimo
 * nunca grava `blocked` no ledger, então `bad + blocked` é, por definição,
 * esse dano. Enumera os `bad` do realdebrid pelo núcleo (dono do `mag`) uma vez
 * por processo e apaga o `bad` de todo hash cujo ledger diga `blocked`. Não usa
 * clear amplo nem bump de namespace; a segunda execução encontra nada e devolve
 * 0. Entradas tardias/L2 são cobertas pelo self-healing no applyDebrid.
 *
 * A chave (com o digest da conta) é montada e parseada do lado de lá: aqui só
 * chega adapter/side/hash, e o `forgetBadOf` apaga o par (adapter, hash) em
 * TODAS as contas — o reparo não precisa da credencial.
 */
function scanBlockedRdBads(): number {
  if (!config.debrid.rdLedger.enabled) return 0;
  let cleared = 0;
  // `limit` 0 = SEM LIMITE de propósito: o reparo precisa varrer o namespace
  // inteiro do realdebrid, não uma página do painel.
  const page = magnetState().entries('realdebrid', 'bad', null, 0, Date.now());
  for (const item of page.items) {
    const hash = item.hash;
    if (rdLedger.peekQuiet(hash) !== 'blocked') continue;
    if (magnetdb.forgetBadOf('realdebrid', hash)) {
      cleared += 1;
      metrics.count('magnetdb.bad.clearedBlocked');
    }
  }
  if (cleared) {
    // As listas prontas foram construídas SEM esses hashes; só limpar o bad não
    // os reinsere. Pede o clear do store NATIVO (F4.2(c)): o L1 do Node nunca
    // recebeu `streams`, então `clearNamespace('streams')` era no-op silencioso.
    clearNativeStreamsSoon();
    log.info(`[rd-warmer] ${cleared} bad(s) RD recusa legal recuperado(s); clear do streams.db pedido`);
  }
  return cleared;
}
/**
 * Arranque LOCAL (timer do Node): só quando a sonda nativa falhou, senão dois
 * timers sondariam a mesma conta. O reparo do dano antigo roda no boot mesmo
 * com o warmer desativado (os bads do L2 não dependem do aquecimento).
 */
function startLocal(): void {
  ensureQueueLoaded();
  try {
    scanBlockedRdBads();
  } catch (err) {
    log.warn('[rd-warmer] varredura de reparo falhou:', (err as Error)?.message || err);
  }
  if (!config.debrid.rdWarm.enabled) {
    log.info('[rd-warmer] desativado');
    return;
  }
  if (queue.length) log.info(`[rd-warmer] fila recuperada: ${queue.length} hash(es)`);
  const timer = setInterval(() => {
    tick().catch((err) => log.warn('[rd-warmer] tick falhou:', (err as Error)?.message || err));
  }, config.debrid.rdWarm.intervalMs);
  timer.unref();
}
/** Inicia o warmer: se `/rd-warm` responde (inclusive `enabled:false`), o gateway é o dono e o timer do Node NÃO liga. */
function start(): void {
  if (started) return;
  started = true;
  const generation = ++startGeneration;
  const settle = (native: boolean): void => {
    if (generation !== startGeneration) return;
    if (native) log.info('[rd-warmer] warmer nativo assume o RD; timer do Node desligado');
    else startLocal();
  };
  void probeNativeRdWarm().then(settle).catch((err: unknown) => {
    log.warn('[rd-warmer] sonda do warmer nativo falhou; timer local assume:', (err as Error)?.message || err);
    settle(false);
  });
}

/**
 * Drena até `max` itens imediatamente, sem furar freios operacionais.
 */
async function drain(max = config.debrid.rdWarm.batch): Promise<{ processed: number; queueRemaining: number }> {
  ensureQueueLoaded();
  if (paused || inFlight || !config.debrid.rdWarm.enabled) return { processed: 0, queueRemaining: queue.length };
  if (activity.recentUserTraffic(config.debrid.rdWarm.idleWindowMs)) return { processed: 0, queueRemaining: queue.length };
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
function status(): { enabled: boolean; queueDepth: number; lastTickAt: number | null; paused: boolean; processedLastHour: number; accountSource: 'panel' | 'env' | 'sessao' | 'none' } {
  ensureQueueLoaded();
  return {
    enabled: config.debrid.rdWarm.enabled,
    queueDepth: queue.length,
    lastTickAt: lastTickAt || null,
    paused,
    processedLastHour: queriesThisHour(),
    accountSource: config.debrid.rdWarm.enabled ? resolveApiKeySource().source : 'none',
  };
}

function reset(): void {
  queue = [];
  loaded = false;
  started = false;
  // Invalida sonda de `start()` em voo: sem isso ela religaria o timer depois.
  startGeneration += 1;
  inFlight = false;
  paused = false;
  lastTickAt = 0;
  notedApiKey = '';
  hourBuckets.clear();
  // Sem forget, reset deixaria o balde no KV e o próximo teste reidrataria.
  kvForget(HOUR_KEY);
}

export { enqueue, tick, start, drain, setPaused, status, reset, scanBlockedRdBads, rdInPlay };
export default { enqueue, tick, start, drain, setPaused, status, reset, scanBlockedRdBads, rdInPlay };
