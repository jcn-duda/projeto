import crypto from 'node:crypto';
import { prefix } from '../utils/cache-keys.js';
import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { getCore, requireCore } from '../utils/rust-core.js';
import { nativeKv, kvKeys, type NativeKvNapi } from '../utils/native-kv.js';
import type { AutofetchQueueCore } from '../utils/rust-autofetch.js';
import { markerKey, markerValue, markerTransferId, markerActive, setMarker, forgetMarker } from './autofetch-marker.js';
import { accountGateBlocked, resetAccountGate, accountGateSnapshot } from './autofetch-gate.js';
import { countAllSuppressed } from './autofetch-suppressed.js';
import { deadKey } from './autofetch-keys.js';

const pending = new Map(); const searchSlots = new Map();
const LOCK_TTL_MS = 60_000;

// Janela deslizante de 1h de enqueues por adapter:account
const hourlyEnqueues = new Map<string, number[]>();
const hourlyLimits = new Map<string, number>();
const budgetBlocked = new Map<string, number>();
// Índices de diagnóstico do processo: as filas/dead moram no disco (KV nativo/cache).
const knownQueues = new Map<string, number>();
const knownDead = new Set<string>();

function sha256(str: string) {
  return crypto.createHash('sha256').update(String(str || '')).digest('hex');
}

const QUEUE_PREFIX = `${prefix('autofetch')}q:`; const DEAD_PREFIX = `${prefix('autofetch')}dead:`;

/** Portas v3 da fila no núcleo (`queue_v3.rs`): o TS não guarda cópia da regra. */
const queueCore = () => requireCore() as unknown as AutofetchQueueCore;

/** Chave da fila: o formato v3 é do núcleo (mesmo sha256 hex de antes — contrato do dreno). */
function queueKey(searchKey: string) {
  return queueCore().autofetchV3QueueKey(String(searchKey || ''));
}


/** Trava só enquanto a API responde: gravar antes do aceite dava 6h de falso positivo. */
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
 * Vagas por busca, compartilhadas entre o passe parcial e o tardio (mesmo
 * searchKey): até `max` candidatos. A TTL limpa a busca que morreu (o lote
 * tardio pode terminar dezenas de segundos depois) e `releaseSearchSlot`
 * devolve a vaga em recusa/erro sem vazar o contador.
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

/** Portas `dead:` do núcleo (`queue_v3.rs`), ausentes do contrato compartilhado. */
type DeadPorts = {
  autofetchV3MarkDead(kv: NativeKvNapi, a: string, c: string, h: string, ttl: number, now: number): void;
  autofetchV3IsDead(kv: NativeKvNapi, a: string, c: string, h: string, now: number): boolean;
};
const deadPorts = () => requireCore() as unknown as DeadPorts;

/** A blacklist de mortos mora no KV nativo (`autofetch:v3:dead:…`, a MESMA `deadKey`) e o napi
 * é a FONTE. Medido 3,2–3,9 µs/hash (~0,6 ms p/ 200 streams): leitura direta, sem Set positivo
 * de processo — ele não expiraria o TTL de 24 h. Erro = false: o falso negativo só re-tenta. */
function isDead(adapterId: string, account: string, infoHash: string): boolean {
  if (!adapterId || !account || !infoHash) return false;
  try { return Boolean(deadPorts().autofetchV3IsDead(nativeKv(), adapterId, account, infoHash, Date.now())); }
  catch (err) { log.warn(`[autofetch] leitura da blacklist falhou: ${log.errorMessage(err)}`); return false; }
}

/** Grava pelo nativo e mantém o índice do painel. TTL <= 0 sai fora (o nativo gravaria PERMANENTE, o mesmo portão do `writeQueue`); erro só loga. */
function blacklist(adapterId: string, account: string, infoHash: string, ttlSeconds = autofetchLive.effective().autoFetchDeadTtl) {
  if (!adapterId || !account || !infoHash || !(Number(ttlSeconds) > 0)) return;
  try { deadPorts().autofetchV3MarkDead(nativeKv(), adapterId, account, infoHash, Math.trunc(Number(ttlSeconds)), Date.now()); knownDead.add(deadKey(adapterId, account, infoHash)); }
  catch (err) { log.warn(`[autofetch] gravação da blacklist falhou: ${log.errorMessage(err)}`); }
}

/** Fila persistente de candidatos excedentes */
interface QueueCandidate {
  infoHash: string;
  name?: string; title?: string; quality?: string;
  size?: number; // bytes do download (política seeds do dreno); ausente = cai no 💾 do title
  seeders?: number;
  br?: boolean; dubbed?: boolean; lied?: boolean;
  bankDub?: boolean; // áudio que só o banco tem: o dreno leva a marca ao protectBr
  pool?: string; imdbId?: string;
  isPack?: boolean; rare?: boolean; slotLimit?: number; // evidência rara do pool seeds p/ o dreno
  // Sonda (Fase 4): a identidade ORIGINAL da busca — o pack tem `episode` nulo para cap.
  season?: number | null; episode?: number | null; probeSeason?: number | null; probeEpisode?: number | null;
  addedAt?: number;
  [key: string]: unknown;
}

function readQueue(searchKey: string): QueueCandidate[] {
  if (!searchKey) return [];
  try {
    const raw = queueCore().autofetchV3ReadQueue(nativeKv(), searchKey, Date.now());
    const value: unknown = raw == null ? null : JSON.parse(raw);
    return Array.isArray(value) ? (value as QueueCandidate[]) : [];
  } catch (err) {
    // Fila ilegível ou núcleo fora = sem candidato: o dreno não pode lançar.
    log.warn(`[autofetch] leitura da fila falhou: ${log.errorMessage(err)}`);
    return [];
  }
}

/** Itens de uma fila JÁ CHAVEADA (`null` = leitura falhou, não é o mesmo que vazia). */
function queueCountAt(key: string, nowMs: number): number | null {
  try {
    const raw = nativeKv().getJson(key, nowMs);
    if (raw == null) return 0;
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return null;
  }
}

function writeQueue(
  searchKey: string,
  candidates: QueueCandidate[],
  ttlSeconds = config.debrid.autoFetchQueueTtl,
  adapterId?: string,
  account?: string, countAdded = true,
) {
  if (!searchKey) return;
  // O `cache.set` do Node descartava TTL <= 0; o nativo gravaria PERMANENTE — o portão fica aqui.
  if (!(Number(ttlSeconds) > 0)) return;
  // Sem hash sai aqui (o `QueueCandidate` nativo exige o campo) e morto também,
  // pela blacklist nativa. Dedupe, `addedAt`, teto e fila vazia são do nativo.
  const withHash = candidates.filter((c) => Boolean(c?.infoHash));
  const alive = adapterId && account
    ? withHash.filter((c) => !isDead(adapterId, account, String(c.infoHash)))
    : withHash;
  let key = ''; let kept = 0;
  try {
    const core = queueCore();
    key = core.autofetchV3QueueKey(searchKey);
    kept = Number(core.autofetchV3WriteQueue(nativeKv(), searchKey, JSON.stringify(alive), {
      ttlSeconds: Number(ttlSeconds), depth: Number(autofetchLive.effective().autoFetchQueueDepth) || 0,
    }, Date.now()).kept) || 0;
  } catch (err) {
    // Sem núcleo/KV a fila não é gravada (o dreno acha vazio), como o cache fazia.
    log.warn(`[autofetch] gravação da fila falhou: ${log.errorMessage(err)}`);
    return;
  }
  if (kept <= 0) { knownQueues.delete(key); return; }
  knownQueues.set(key, kept);
  if (countAdded) metrics.count('autofetch.queue.added', kept);
}

function dropQueue(keyOrSearchKey: string) {
  if (!keyOrSearchKey) return;
  let key = '';
  let dropped = false;
  try {
    const core = queueCore();
    // O nativo resolve chave pronta OU searchKey; o Map só guarda a pronta.
    key = keyOrSearchKey.startsWith(QUEUE_PREFIX) ? keyOrSearchKey : core.autofetchV3QueueKey(keyOrSearchKey);
    dropped = Boolean(core.autofetchV3DropQueue(nativeKv(), keyOrSearchKey));
  } catch (err) {
    log.warn(`[autofetch] remoção da fila falhou: ${log.errorMessage(err)}`);
  }
  if (dropped) metrics.count('autofetch.queue.dropped');
  knownQueues.delete(key);
}

function drainQueues(): { queues: number; items: number } {
  let queues = 0;
  let items = 0;
  for (const [key, count] of [...knownQueues.entries()]) {
    dropQueue(key);
    queues += 1;
    items += count;
  }
  metrics.count('autofetch.queue.drained_all', items);
  return { queues, items };
}

// drainNext lê a fila direto; snapshot/drainQueues dependem deste reindex, que
// reconstrói knownQueues do KV nativo (é o que faz o painel marcar "duravel").
function reindexQueues() {
  // Sem núcleo JÁ carregado não há varredura: importar aqui não pode carregar o `.node`.
  const core = getCore();
  if (!core?.autofetchV3QueueKeys) return 0;
  let n = 0;
  try {
    const kv = nativeKv();
    const now = Date.now();
    for (const key of core.autofetchV3QueueKeys(kv, now) || []) {
      if (knownQueues.has(key)) continue;
      const count = queueCountAt(key, now);
      if (count == null || count === 0) continue;
      knownQueues.set(key, count);
      n += 1;
    }
  } catch (err) {
    log.warn(`[autofetch] reindex das filas falhou: ${log.errorMessage(err)}`);
  }
  metrics.count('autofetch.queue.reindexed', n);
  return n;
}

/** Repovoa o índice de diagnóstico com as chaves VIVAS (`kvKeys(DEAD_PREFIX)`); o `.node` nunca carrega aqui (`getCore` + 0 sem núcleo), como no `reindexQueues`. */
function reindexDead() {
  if (!getCore()) return 0;
  let n = 0;
  try { for (const key of kvKeys(DEAD_PREFIX)) if (!knownDead.has(key)) { knownDead.add(key); n += 1; } }
  catch (err) { log.warn(`[autofetch] reindex da blacklist falhou: ${log.errorMessage(err)}`); }
  metrics.count('autofetch.dead.reindexed', n); return n;
}

function takeNext(
  queue: QueueCandidate[],
  skipFn?: (item: QueueCandidate) => boolean,
  deferFn?: (item: QueueCandidate) => boolean,
): { next: QueueCandidate | null; remaining: QueueCandidate[] } {
  // skipFn = obsoleto (sai da fila). deferFn = apenas ADIADO (hold transitório):
  // fica em `remaining`, pois purgá-lo perderia candidato que drenaria depois.
  if (!Array.isArray(queue) || queue.length === 0) return { next: null, remaining: [] };
  const kept: QueueCandidate[] = []; let next: QueueCandidate | null = null;
  for (const candidate of queue) {
    if (skipFn?.(candidate)) continue;
    if (next === null && !deferFn?.(candidate)) next = candidate;
    else kept.push(candidate);
  }
  return { next, remaining: kept };
}
/** Orçamento deslizante de enqueues/hora por adapter:account. */
function checkAndRecordBudget(adapterId: string, account: string, limit?: number): boolean {
  if (!adapterId || !account) return true;
  const key = `${adapterId}:${account}`;
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  let timestamps = (hourlyEnqueues.get(key) || []).filter((t) => t > oneHourAgo);
  const maxHourly = limit != null && Number.isFinite(limit)
    ? limit
    : autofetchLive.effective().autoFetchEnqueueMaxHour;
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

/** Gate de ocupação da conta: decisão, memo e contrato moram em autofetch-gate.ts (extraído
 * para a catraca); aqui fica só o reexport que testes e runner consomem. */

/** Estado operacional sem expor searchKey, conta ou infoHash. */
function snapshot() {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const live = autofetchLive.effective();
  let used = 0;
  let limit = 0;
  const budgets: Array<{ id: string; used: number; limit: number }> = [];
  for (const [key, raw] of hourlyEnqueues) {
    const timestamps = raw.filter((t) => t > oneHourAgo);
    hourlyEnqueues.set(key, timestamps);
    const itemLimit = hourlyLimits.get(key) || live.autoFetchEnqueueMaxHour;
    used += timestamps.length;
    limit += itemLimit;
    budgets.push({ id: sha256(key).slice(0, 12), used: timestamps.length, limit: itemLimit });
  }

  let queueItems = 0;
  for (const [key] of [...knownQueues]) {
    const count = queueCountAt(key, now);
    // Leitura falhou ≠ fila sumiu: mantém a contagem anterior em vez de zerar.
    if (count == null) { queueItems += knownQueues.get(key) || 0; continue; }
    if (count === 0) { knownQueues.delete(key); continue; }
    knownQueues.set(key, count);
    queueItems += count;
  }
  const deadLive = new Set(kvKeys(DEAD_PREFIX));
  for (const key of [...knownDead]) if (!deadLive.has(key)) knownDead.delete(key);
  let occupiedSlots = 0;
  for (const entry of searchSlots.values()) occupiedSlots += Number(entry?.used || 0);

  // Remoções represadas (autofetch-suppressed): o snapshot é síncrono e sem conta,
  // então o número é o AGREGADO — o drain do painel age só na conta do operador.
  const suppressed = countAllSuppressed();

  return {
    pendingLocks: pending.size,
    searchSlots: { searches: searchSlots.size, occupied: occupiedSlots },
    budget: { used, limit, accounts: budgets },
    deadBlacklistCount: knownDead.size,
    queues: { count: knownQueues.size, items: queueItems },
    suppressed,
    accountGate: accountGateSnapshot(),
    config: autofetchLive.snapshot(),
    // queues/dead/suppressed=durável (varredura do disco, não Map de processo); resto=amostra.
    _origem: { queues: 'duravel', deadBlacklistCount: 'duravel', budget: 'amostra', accountGate: 'amostra', suppressed: 'duravel' },
  };
}

export {
  LOCK_TTL_MS, markerKey, markerValue, markerTransferId, markerActive, setMarker, forgetMarker, deadKey, queueKey,
  acquire, release, acquireSearch, releaseSearch, acquireSearchSlot, releaseSearchSlot,
  isDead, blacklist, readQueue, writeQueue, dropQueue, drainQueues, takeNext,
  checkAndRecordBudget, blockBudget, budgetBlockedUntil, resetBudget,
  accountGateBlocked, resetAccountGate, accountGateSnapshot, snapshot, reindexQueues, reindexDead,
};

reindexQueues();
reindexDead();

export type { QueueCandidate };
