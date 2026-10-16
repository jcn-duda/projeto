/**
 * Ledger e AIMD do Real-Debrid em Rust: o próximo estado (`rdc:v2` de hit,
 * miss e bloqueio; gap, cooldown e retry-after do gate) é decidido no núcleo.
 * O Node continua dono do cache.db e da fila; o kill-switch fica nele
 * (`enabled` já vem resolvido). O TS da regra saiu do branch (oráculo no `esm`).
 */
import { requireCore } from './rust-core.js';
import * as metrics from './metrics.js';

export type RdCore = {
  debridRdNextHit(enabled: boolean, hitTtl: number, now: number, current: string): RdWriteNapi;
  debridRdNextMiss(
    enabled: boolean, hash: string, backoffMs: number[], now: number, current: string,
    priorS: string | null, priorN: number | null,
  ): RdWriteNapi;
  debridRdNextBlocked(enabled: boolean, hash: string, blockedTtl: number, now: number): RdWriteNapi;
  debridRdOnRateLimit(
    gapMs: number, nextAllowedAt: number, cooldownUntil: number, rateLimits: number[],
    now: number, minGapMs: number, maxGapMs: number, cooldownMs: number, retryAfterMs: number | null,
  ): RdRateNapi;
  debridRdOnSuccess(gapMs: number, successes: number, successThreshold: number, minGapMs: number, maxGapMs: number): RdSuccessNapi;
  debridRdOnFinished(nextAllowedAt: number, gapMs: number, now: number): number;
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

export type RdRateStep = {
  gapMs: number; successes: number; nextAllowedAt: number; cooldownUntil: number; rateLimits: number[]; honoredRetryAfter: boolean;
};

function core(): RdCore {
  metrics.count('rust.debrid.rd.calls');
  return requireCore() as unknown as RdCore;
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

function rdNextHit(input: { enabled: boolean; hitTtl: number; now: number; current: string }): RdWrite {
  return writeFrom(core().debridRdNextHit(input.enabled, input.hitTtl, input.now, input.current));
}

function rdNextMiss(input: {
  enabled: boolean; hash: string; backoffMs: readonly number[]; now: number; current: string;
  prior: { s?: unknown; n?: number } | null;
}): RdWrite {
  const priorS = typeof input.prior?.s === 'string' ? input.prior.s : null;
  const priorN = typeof input.prior?.n === 'number' ? input.prior.n : null;
  return writeFrom(core().debridRdNextMiss(
    input.enabled, input.hash, [...input.backoffMs], input.now, input.current, priorS, priorN,
  ));
}

function rdNextBlocked(input: { enabled: boolean; hash: string; blockedTtl: number; now: number }): RdWrite {
  return writeFrom(core().debridRdNextBlocked(input.enabled, input.hash, input.blockedTtl, input.now));
}

function field(raw: RdRateNapi, camel: 'gapMs' | 'nextAllowedAt' | 'cooldownUntil', snake: 'gap_ms' | 'next_allowed_at' | 'cooldown_until'): number {
  return Number(raw[camel] ?? raw[snake]);
}

function rdOnRateLimit(args: {
  gapMs: number; nextAllowedAt: number; cooldownUntil: number; rateLimits: number[];
  now: number; minGapMs: number; maxGapMs: number; cooldownMs: number; retryAfterMs: number | null;
}): RdRateStep {
  const raw = core().debridRdOnRateLimit(
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
}

function rdOnSuccess(gapMs: number, successes: number, successThreshold: number, minGapMs: number, maxGapMs: number) {
  const raw = core().debridRdOnSuccess(gapMs, successes, successThreshold, minGapMs, maxGapMs);
  return { gapMs: Number(raw.gapMs ?? raw.gap_ms), successes: Number(raw.successes) };
}

function rdOnFinished(nextAllowedAt: number, gapMs: number, now: number): number {
  return Number(core().debridRdOnFinished(nextAllowedAt, gapMs, now));
}

export { rdNextHit, rdNextMiss, rdNextBlocked, rdOnRateLimit, rdOnSuccess, rdOnFinished };
