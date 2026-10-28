import crypto from 'node:crypto';
import * as cache from '../utils/cache.js';
import type { RuntimeContext } from '../runtime.js';
import autofetchLive from '../utils/autofetch-live.js';
import { forgetLotNative, lotNativeKey, readLotNative, writeLotNative } from '../utils/autofetch-state-native.js';

export type SeasonHint = { imdbId?: string | null; season?: number | null; episode?: number | null; isPack?: boolean };
export type RecheckLot = {
  hashes: Set<string>;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  ctx: RuntimeContext;
  deadStreak: Map<string, number>;
  stallStreak: Map<string, number>;
  seasonHints: Map<string, SeasonHint>;
  createdAt: number;
  isSettle: boolean;
  refusals: number;
  adapterId: string;
};

function lotKey(searchKey: string): string {
  return lotNativeKey(searchKey) || `autofetch:v3:lot:${crypto.createHash('sha256').update(searchKey).digest('hex')}`;
}

export function persistLot(searchKey: string, lot: RecheckLot): void {
  const ttl = Math.max(1, Math.trunc(Number(autofetchLive.effective().autoFetchTtl) || 0));
  const snapshot = {
    hashes: [...lot.hashes], attempts: Math.max(0, Math.trunc(lot.attempts || 0)),
    deadStreak: Object.fromEntries(lot.deadStreak), stallStreak: Object.fromEntries(lot.stallStreak),
    seasonHints: Object.fromEntries(lot.seasonHints), createdAt: Number(lot.createdAt) || Date.now(),
    isSettle: lot.isSettle === true, refusals: Math.max(0, Math.trunc(lot.refusals || 0)),
    adapterId: String(lot.adapterId || ''),
  };
  writeLotNative(searchKey, snapshot, ttl);
  cache.set(lotKey(searchKey), snapshot, ttl);
}

export function restoreLot(searchKey: string, ctx: RuntimeContext, adapterId: string): RecheckLot | undefined {
  const snapshot = readLotNative(searchKey) ?? cache.peek(lotKey(searchKey)) as ReturnType<typeof readLotNative>;
  if (!snapshot || !Array.isArray(snapshot.hashes) || snapshot.hashes.length === 0) return undefined;
  return {
    hashes: new Set(snapshot.hashes.map((hash) => String(hash).toLowerCase()).filter(Boolean)),
    attempts: Math.max(0, Math.trunc(Number(snapshot.attempts) || 0)), timer: null, inFlight: false, ctx,
    deadStreak: new Map(Object.entries(snapshot.deadStreak || {}).map(([hash, value]) => [hash, Number(value) || 0])),
    stallStreak: new Map(Object.entries(snapshot.stallStreak || {}).map(([hash, value]) => [hash, Number(value) || 0])),
    seasonHints: new Map(Object.entries(snapshot.seasonHints || {})),
    createdAt: Number(snapshot.createdAt) || Date.now(), isSettle: snapshot.isSettle === true,
    refusals: Math.max(0, Math.trunc(Number(snapshot.refusals) || 0)),
    adapterId: String(snapshot.adapterId || adapterId || ''),
  };
}

export function forgetLot(searchKey: string): void {
  forgetLotNative(searchKey);
  cache.forget(lotKey(searchKey));
}
