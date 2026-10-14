// Ledger durável de disponibilidade do Real-Debrid.
//
// O CDN/cache do RD pertence ao SERVIÇO, não à conta que observou o resultado;
// por isso a chave deste ledger (`rdc:v2:<hash>`) deliberadamente não leva
// apiKey nem accountScope. Isto convive com `mag:alive`, que continua por conta
// e registra um play que funcionou naquela credencial. O ledger alimenta o
// ranking, o filtro ternário do cachedOnly e o oráculo. Falso negativo é pior
// que falso positivo, então miss expira com backoff e nunca condena uma release
// sem nova medição.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';
import { prefix } from '../utils/cache-keys.js';
import { shadowBlocked, shadowHit, shadowMiss } from '../utils/rust-debrid-rd.js';

export type LedgerState = 'hit' | 'miss' | 'blocked' | 'unknown';
type LedgerValue = { s: Exclude<LedgerState, 'unknown'>; at: number; n: number };
type Tracked = { state: Exclude<LedgerState, 'unknown'>; expiresAt: number };

/** Próximo valor do ledger. `hash` só vem em miss/blocked (a chave lógica). */
export type RdLedgerWrite = {
  s: Exclude<LedgerState, 'unknown'>;
  at: number;
  n: number;
  ttlSeconds: number;
  hash?: string;
};

const tracked = new Map<string, Tracked>();

/** 40 hex depois de lower; qualquer outra forma é vazio e a leitura é unknown. */
export function normalizeRdHash(hash: string): string {
  const value = String(hash || '').toLowerCase();
  return /^[a-f0-9]{40}$/.test(value) ? value : '';
}

function hashOf(hash: string) {
  return normalizeRdHash(hash);
}

/** Desligado, ausente ou `s` fora do trio → `unknown`. Não olha apiKey. */
export function peekLedgerState(
  enabled: boolean,
  stored: { s?: unknown } | null | undefined,
): LedgerState {
  if (!enabled || !stored) return 'unknown';
  const s = stored.s;
  if (s === 'hit' || s === 'miss' || s === 'blocked') return s;
  return 'unknown';
}

/**
 * Hit refresca `{s,at,n:0}`. Bloqueio legal não é apagado por inventário
 * atrasado: `current === 'blocked'` não escreve.
 */
export function nextOnHit(input: {
  enabled: boolean;
  hitTtl: number;
  now: number;
  current: LedgerState;
}): RdLedgerWrite | null {
  if (!input.enabled || input.hitTtl <= 0 || input.current === 'blocked') return shadowHit(input, null);
  return shadowHit(input, { s: 'hit', at: input.now, n: 0, ttlSeconds: input.hitTtl });
}

/**
 * Miss só adia a próxima sonda. O degrau é `backoff[min(n, último)]` e o `n`
 * continua crescendo — nunca vira "uncached permanente". `blocked` não cede.
 * `ttlMs` 0/NaN não escreve; o resto vira segundos com teto mínimo de 1.
 */
export function nextOnMiss(input: {
  enabled: boolean;
  hash: string;
  backoffMs: readonly number[];
  now: number;
  current: LedgerState;
  prior: { s?: unknown; n?: number } | null;
}): RdLedgerWrite | null {
  const normalized = normalizeRdHash(input.hash);
  if (!input.enabled || !normalized || input.backoffMs.length === 0 || input.current === 'blocked') {
    return shadowMiss(input, null);
  }
  let attempts = 1;
  if (input.prior?.s === 'miss') {
    const n = input.prior.n;
    attempts = (typeof n === 'number' ? n : Number.NaN) + 1;
  }
  const ttlMs = input.backoffMs[Math.min(attempts - 1, input.backoffMs.length - 1)];
  if (!ttlMs) return shadowMiss(input, null);
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  return shadowMiss(input, { s: 'miss', at: input.now, n: attempts, ttlSeconds, hash: normalized });
}

/** Bloqueio cobre hit e miss. TTL não positivo ou hash inválido não escreve. */
export function nextOnBlocked(input: {
  enabled: boolean;
  hash: string;
  blockedTtl: number;
  now: number;
}): RdLedgerWrite | null {
  const normalized = normalizeRdHash(input.hash);
  if (!input.enabled || input.blockedTtl <= 0 || !normalized) return shadowBlocked(input, null);
  return shadowBlocked(input, { s: 'blocked', at: input.now, n: 0, ttlSeconds: input.blockedTtl, hash: normalized });
}

function key(hash: string) {
  return `${prefix('rdc')}${hashOf(hash)}`;
}

function read(hash: string): LedgerValue | null {
  const normalized = hashOf(hash);
  if (!config.debrid.rdLedger.enabled || !normalized) return null;
  const value = cache.get(key(normalized)) as LedgerValue | null;
  if (!value || !['hit', 'miss', 'blocked'].includes(value.s)) return null;
  return value;
}

function pruneTracked() {
  const now = Date.now();
  for (const [hash, item] of tracked) {
    if (item.expiresAt <= now) {
      tracked.delete(hash);
    }
  }
  if (tracked.size > 5000) {
    const overflow = tracked.size - 5000;
    let removed = 0;
    for (const hash of tracked.keys()) {
      tracked.delete(hash);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
}

// `prune=false` é para lotes: noteHit já podou uma vez antes do laço, e podar
// por hash faria a varredura de expirados custar O(|lote| × |tracked|).
function track(
  hash: string,
  state: Exclude<LedgerState, 'unknown'>,
  ttlSeconds: number,
  prune = true,
) {
  if (ttlSeconds <= 0) return;
  if (prune) pruneTracked();
  tracked.set(hash, { state, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function writeMany(entries: { key: string; value: LedgerValue; ttlSeconds: number }[]) {
  if (!entries.length) return;
  // cache.setMany existe no cache atual para uma transação/evicção só. O loop
  // mantém o módulo utilizável por implementações antigas usadas em harnesses.
  if (typeof cache.setMany === 'function') cache.setMany(entries);
  else for (const entry of entries) cache.set(entry.key, entry.value, entry.ttlSeconds);
}

function peek(hash: string): LedgerState {
  // `blocked` ocupa a mesma chave e não é sobrescrito por hit/miss; assim ele
  // vence mesmo quando uma evidência antiga ainda existe no processo.
  return peekLedgerState(config.debrid.rdLedger.enabled, read(hash));
}

/** Leitura para varreduras: não promove LRU nem incrementa hit/miss do cache. */
function peekQuiet(hash: string): LedgerState {
  const normalized = hashOf(hash);
  if (!config.debrid.rdLedger.enabled || !normalized) return 'unknown';
  return peekLedgerState(true, cache.peek(key(normalized)) as LedgerValue | null);
}

function isHit(hash: string) {
  return peek(hash) === 'hit';
}

function noteHit(hashes: string[]) {
  const ttl = config.debrid.rdLedger.hitTtl;
  if (!config.debrid.rdLedger.enabled || ttl <= 0) return;
  const unique = [...new Set(hashes.map(hashOf))].filter(Boolean);
  const now = Date.now();
  // A lista elegível (não-blocked) é calculada UMA vez e serve tanto para a
  // escrita quanto para o `track` do processo. Antes o `track` reconsultava
  // `peek` pós-escrita, custando mais uma leitura L1+SQLite por hash; o peek
  // pós-write só distinguia "escrita venceu" de "blocked", e assumindo que o
  // writeMany não falha silenciosamente a elegibilidade já cobre isso.
  const eligible: string[] = [];
  const writes: { key: string; value: LedgerValue; ttlSeconds: number }[] = [];
  for (const hash of unique) {
    // Bloqueio legal é mais específico que confirmação anterior e não pode ser
    // apagado por um caminho atrasado de inventário/recheck.
    const write = nextOnHit({ enabled: true, hitTtl: ttl, now, current: peek(hash) });
    if (!write) continue;
    eligible.push(hash);
    writes.push({ key: key(hash), value: { s: 'hit', at: write.at, n: write.n }, ttlSeconds: write.ttlSeconds });
  }
  writeMany(writes);
  // Podar uma vez pelo lote inteiro: o prune varre o Map `tracked` inteiro, e
  // chamá-lo por hash seria O(|lote| × |tracked|).
  if (eligible.length) pruneTracked();
  for (const hash of eligible) {
    track(hash, 'hit', ttl, false);
  }
  if (writes.length) {
    metrics.count('debrid.rd.ledger.hit', writes.length);
    metrics.count('debrid.rd.ledger.noted', writes.length);
  }
}

function noteMiss(hash: string) {
  if (!config.debrid.rdLedger.enabled) return;
  const normalized = hashOf(hash);
  const backoff = config.debrid.rdLedger.missBackoffMs;
  if (!normalized || backoff.length === 0 || peek(normalized) === 'blocked') return;
  const prior = read(normalized);
  const write = nextOnMiss({
    enabled: true,
    hash: normalized,
    backoffMs: backoff,
    now: Date.now(),
    current: peekLedgerState(true, prior),
    prior,
  });
  if (!write?.hash) return;
  writeMany([{ key: key(write.hash), value: { s: 'miss', at: write.at, n: write.n }, ttlSeconds: write.ttlSeconds }]);
  track(write.hash, 'miss', write.ttlSeconds);
  metrics.count('debrid.rd.ledger.miss');
  metrics.count('debrid.rd.ledger.noted');
}

function noteBlocked(hash: string) {
  const ttl = config.debrid.rdLedger.blockedTtl;
  const normalized = hashOf(hash);
  const write = nextOnBlocked({
    enabled: config.debrid.rdLedger.enabled,
    hash: normalized,
    blockedTtl: ttl,
    now: Date.now(),
  });
  if (!write?.hash) return;
  writeMany([{ key: key(write.hash), value: { s: 'blocked', at: write.at, n: write.n }, ttlSeconds: write.ttlSeconds }]);
  track(write.hash, 'blocked', write.ttlSeconds);
  metrics.count('debrid.rd.ledger.blocked');
  metrics.count('debrid.rd.ledger.noted');
}

/** Renova confirmação já conhecida só na segunda metade do TTL, como magnetdb. */
function renewHits(hashes: string[]) {
  const ttl = config.debrid.rdLedger.hitTtl;
  if (!config.debrid.rdLedger.enabled || ttl <= 0) return;
  const stale = [...new Set(hashes.map(hashOf))].filter((hash) => {
    if (!hash || peek(hash) !== 'hit') return false;
    const remaining = cache.peekRemaining(key(hash));
    return remaining == null || remaining < ttl / 2;
  });
  noteHit(stale);
}

/** Amostra local para diagnóstico; nunca inclui hash, conta ou credencial. */
function status() {
  const now = Date.now();
  let hits = 0;
  let misses = 0;
  let blocked = 0;
  for (const [hash, item] of tracked) {
    // Evicção/forget do cache não notifica o Map — sem o peek a amostra
    // SUPERCONTA depois que a cota rdc gira (mesmo padrão do magnetdb).
    if (item.expiresAt <= now || cache.peek(key(hash)) == null) {
      tracked.delete(hash);
      continue;
    }
    if (item.state === 'hit') hits += 1;
    else if (item.state === 'miss') misses += 1;
    else blocked += 1;
  }
  // Ocupação real do namespace `rdc` no L1 — snapshot do cache, igual ao mag
  // do magnetdb. Inclui chaves plantadas antes do processo (L2→L1) e órfãs
  // sem track; por isso pode diferir da amostra.
  const ns = cache.snapshot().namespaces as Record<string, { entries?: number; maxEntries?: number }>;
  const rdcNs = ns?.rdc;
  // `_origem` aditivo: tracked/hits/… = amostra do processo; l1* = L1 durável
  // (Mecanismo A — debrid-status / painel).
  return {
    tracked: hits + misses + blocked,
    hits,
    misses,
    blocked,
    l1Entries: rdcNs?.entries || 0,
    // Sem snapshot/QUOTAS, inventar um número no painel é pior que zero.
    l1Max: rdcNs?.maxEntries || cache.QUOTAS?.rdc || 0,
    _origem: {
      tracked: 'amostra' as const,
      hits: 'amostra' as const,
      misses: 'amostra' as const,
      blocked: 'amostra' as const,
      l1Entries: 'duravel' as const,
      l1Max: 'duravel' as const,
    },
  };
}

function reset() {
  tracked.clear();
}

export { key, peek, peekQuiet, isHit, noteHit, noteMiss, noteBlocked, renewHits, status, reset };
