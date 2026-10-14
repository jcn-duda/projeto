/**
 * Sombra do ledger e do AIMD (`RUST_DEBRID_RD`). O Node continua dono do
 * cache.db e da fila. O Rust só recalcula o próximo estado com os mesmos
 * números. Kill-switch fica no Node: `enabled` já vem resolvido.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

export type RdCore = {
  debridRdNextHit?(enabled: boolean, hitTtl: number, now: number, current: string): RdWriteNapi;
  debridRdNextMiss?(
    enabled: boolean, hash: string, backoffMs: number[], now: number, current: string,
    priorS: string | null, priorN: number | null,
  ): RdWriteNapi;
  debridRdNextBlocked?(enabled: boolean, hash: string, blockedTtl: number, now: number): RdWriteNapi;
  debridRdOnRateLimit?(
    gapMs: number, nextAllowedAt: number, cooldownUntil: number, rateLimits: number[],
    now: number, minGapMs: number, maxGapMs: number, cooldownMs: number, retryAfterMs: number | null,
  ): RdRateNapi;
  debridRdOnSuccess?(gapMs: number, successes: number, successThreshold: number, minGapMs: number, maxGapMs: number): RdSuccessNapi;
  debridRdOnFinished?(nextAllowedAt: number, gapMs: number, now: number): number;
};

type RdWriteNapi = { present: boolean; s: string; at: number; n: number; ttlSeconds?: number; ttl_seconds?: number; hash?: string | null };
type RdRateNapi = {
  gapMs?: number; gap_ms?: number; successes: number;
  nextAllowedAt?: number; next_allowed_at?: number;
  cooldownUntil?: number; cooldown_until?: number;
  rateLimits?: number[]; rate_limits?: number[];
  honoredRetryAfter?: boolean; honored_retry_after?: boolean;
};
type RdSuccessNapi = { gapMs?: number; gap_ms?: number; successes: number };

export type RdWrite = { s: 'hit' | 'miss' | 'blocked'; at: number; n: number; ttlSeconds: number; hash?: string } | null;

type GetCore = () => RdCore | null;
let getCore: GetCore | null = null;
let loggedDiffs = 0;
let loggedMissing = false;

function mode() {
  return config.rustDebrid.rd;
}

function noteMissing(name: string) {
  if (loggedMissing) return;
  loggedMissing = true;
  log.info(`[rust] núcleo sem ${name} (binário antigo); sombra RD desligada`);
}

function sameNum(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return a === b;
}

function logDiff(op: string) {
  metrics.count('rust.debrid.rd.diff');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(`[rust] RD divergiu: op=${op}`);
}

function pick<T>(op: string, ts: T, load: () => T, same: (ts: T, rust: T) => boolean): T {
  if (mode() === 'off' || !getCore) return ts;
  metrics.count('rust.debrid.rd.calls');
  let rust: T;
  try {
    rust = load();
  } catch (err) {
    metrics.count('rust.debrid.rd.error');
    log.debug('[rust] RD lançou:', log.errorMessage(err));
    return ts;
  }
  if (mode() === 'shadow') {
    if (!same(ts, rust)) logDiff(op);
    return ts;
  }
  return rust;
}

function writeFrom(raw: RdWriteNapi | null | undefined): RdWrite {
  if (!raw?.present) return null;
  if (raw.s !== 'hit' && raw.s !== 'miss' && raw.s !== 'blocked') throw new Error('estado RD inválido');
  return {
    s: raw.s,
    at: Number(raw.at),
    n: Number(raw.n),
    ttlSeconds: Number(raw.ttlSeconds ?? raw.ttl_seconds),
    ...(raw.hash ? { hash: String(raw.hash) } : {}),
  };
}

function sameWrite(ts: RdWrite, rust: RdWrite): boolean {
  if (ts == null || rust == null) return ts == null && rust == null;
  return ts.s === rust.s && sameNum(ts.at, rust.at) && sameNum(ts.n, rust.n)
    && sameNum(ts.ttlSeconds, rust.ttlSeconds) && (ts.hash ?? '') === (rust.hash ?? '');
}

function shadowHit(input: { enabled: boolean; hitTtl: number; now: number; current: string }, ts: RdWrite): RdWrite {
  const fn = getCore?.()?.debridRdNextHit;
  if (typeof fn !== 'function') {
    if (mode() !== 'off' && getCore) noteMissing('debridRdNextHit');
    return ts;
  }
  return pick('next-hit', ts, () => writeFrom(fn(input.enabled, input.hitTtl, input.now, input.current)), sameWrite);
}

function shadowMiss(input: {
  enabled: boolean; hash: string; backoffMs: readonly number[]; now: number; current: string;
  prior: { s?: unknown; n?: number } | null;
}, ts: RdWrite): RdWrite {
  const fn = getCore?.()?.debridRdNextMiss;
  if (typeof fn !== 'function') {
    if (mode() !== 'off' && getCore) noteMissing('debridRdNextMiss');
    return ts;
  }
  const priorS = typeof input.prior?.s === 'string' ? input.prior.s : null;
  const priorN = typeof input.prior?.n === 'number' ? input.prior.n : null;
  return pick('next-miss', ts, () => writeFrom(fn(
    input.enabled, input.hash, [...input.backoffMs], input.now, input.current, priorS, priorN,
  )), sameWrite);
}

function shadowBlocked(input: { enabled: boolean; hash: string; blockedTtl: number; now: number }, ts: RdWrite): RdWrite {
  const fn = getCore?.()?.debridRdNextBlocked;
  if (typeof fn !== 'function') {
    if (mode() !== 'off' && getCore) noteMissing('debridRdNextBlocked');
    return ts;
  }
  return pick('next-blocked', ts, () => writeFrom(fn(input.enabled, input.hash, input.blockedTtl, input.now)), sameWrite);
}

function field(raw: RdRateNapi, camel: 'gapMs' | 'nextAllowedAt' | 'cooldownUntil', snake: 'gap_ms' | 'next_allowed_at' | 'cooldown_until'): number {
  const value = raw[camel] ?? raw[snake];
  return Number(value);
}

function shadowRate(ts: {
  gapMs: number; successes: number; nextAllowedAt: number; cooldownUntil: number; rateLimits: number[]; honoredRetryAfter: boolean;
}, args: {
  gapMs: number; nextAllowedAt: number; cooldownUntil: number; rateLimits: number[];
  now: number; minGapMs: number; maxGapMs: number; cooldownMs: number; retryAfterMs: number | null;
}): typeof ts {
  if (mode() === 'off' || !getCore) return ts;
  const fn = getCore()?.debridRdOnRateLimit;
  if (typeof fn !== 'function') {
    noteMissing('debridRdOnRateLimit');
    return ts;
  }
  return pick('rate-limit', ts, () => {
    const raw = fn(
      args.gapMs, args.nextAllowedAt, args.cooldownUntil, args.rateLimits,
      args.now, args.minGapMs, args.maxGapMs, args.cooldownMs, args.retryAfterMs,
    );
    return {
      gapMs: field(raw, 'gapMs', 'gap_ms'),
      successes: Number(raw.successes),
      nextAllowedAt: field(raw, 'nextAllowedAt', 'next_allowed_at'),
      cooldownUntil: field(raw, 'cooldownUntil', 'cooldown_until'),
      rateLimits: [...(raw.rateLimits ?? raw.rate_limits ?? [])],
      honoredRetryAfter: Boolean(raw.honoredRetryAfter ?? raw.honored_retry_after),
    };
  }, (left, right) => left.honoredRetryAfter === right.honoredRetryAfter
    && sameNum(left.gapMs, right.gapMs)
    && left.successes === right.successes
    && sameNum(left.nextAllowedAt, right.nextAllowedAt)
    && sameNum(left.cooldownUntil, right.cooldownUntil)
    && left.rateLimits.length === right.rateLimits.length
    && left.rateLimits.every((item, index) => sameNum(item, right.rateLimits[index])));
}

function shadowSuccess(
  ts: { gapMs: number; successes: number },
  gapMs: number, successes: number, successThreshold: number, minGapMs: number, maxGapMs: number,
): { gapMs: number; successes: number } {
  if (mode() === 'off' || !getCore) return ts;
  const fn = getCore()?.debridRdOnSuccess;
  if (typeof fn !== 'function') {
    noteMissing('debridRdOnSuccess');
    return ts;
  }
  return pick('success', ts, () => {
    const raw = fn(gapMs, successes, successThreshold, minGapMs, maxGapMs);
    return { gapMs: Number(raw.gapMs ?? raw.gap_ms), successes: Number(raw.successes) };
  }, (left, right) => sameNum(left.gapMs, right.gapMs) && left.successes === right.successes);
}

function shadowFinished(ts: number, nextAllowedAt: number, gapMs: number, now: number): number {
  if (mode() === 'off' || !getCore) return ts;
  const fn = getCore()?.debridRdOnFinished;
  if (typeof fn !== 'function') {
    noteMissing('debridRdOnFinished');
    return ts;
  }
  return pick('finished', ts, () => Number(fn(nextAllowedAt, gapMs, now)), sameNum);
}

function installDebridRdHook(get: GetCore) {
  getCore = get;
}

function resetDebridRdHook() {
  getCore = null;
  loggedDiffs = 0;
  loggedMissing = false;
}

export {
  shadowHit, shadowMiss, shadowBlocked, shadowRate, shadowSuccess, shadowFinished, installDebridRdHook, resetDebridRdHook,
};
