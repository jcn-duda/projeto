/**
 * Ponte temporária dos estados v3 ainda consumidos pelo runner Node.
 * NativeKv é o caminho primário; os fallbacks no cache mantêm compatibilidade
 * com testes/instalações cujo `.node` ainda não exporta estas APIs.
 */
import { requireCore } from './rust-core.js';
import { nativeKv, type NativeKvNapi } from './native-kv.js';

type Core = ReturnType<typeof requireCore> & Partial<BrReadyCore>;
type Suppressed = { id: string; at: number; fails: number; nextAt: number };
/**
 * Portas da evidência de BR-ready (`autofetch:v3:er:<digest>`) no napi. O
 * contrato canônico mora no `rust-autofetch.ts`; fica declarado aqui porque é
 * a ponte quem o consome e o arquivo de tipos tem outro dono.
 */
type BrReadyCore = {
  autofetchV3BrReadyKey(digest: string): string;
  autofetchV3BrReadyRead(kv: NativeKvNapi, digest: string, nowMs: number): string | null;
  autofetchV3BrReadyWrite(kv: NativeKvNapi, digest: string, ttlSeconds: number, nowMs: number): void;
  autofetchV3BrReadyForget(kv: NativeKvNapi, digest: string): boolean;
};
type LotSnapshot = {
  hashes: string[];
  attempts: number;
  deadStreak: Record<string, number>;
  stallStreak: Record<string, number>;
  seasonHints: Record<string, { imdbId?: string | null; season?: number | null; episode?: number | null; isPack?: boolean }>;
  createdAt: number;
  isSettle: boolean;
  refusals: number;
  adapterId: string;
};

function core(): Core | null {
  try { return requireCore(); } catch { return null; }
}

function kv() {
  try { return nativeKv(); } catch { return null; }
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function brProbeNativeKey(work: { type: string; imdbId: string; season?: number | null; episode?: number | null }): string | undefined {
  const c = core();
  if (!c?.autofetchV3ProbeKey) return undefined;
  try { return c.autofetchV3ProbeKey(work.type, work.imdbId, work.season, work.episode); } catch { return undefined; }
}

export function readBrProbeNative(work: { type: string; imdbId: string; season?: number | null; episode?: number | null }, now = Date.now()) {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3ProbeRead || !handle) return undefined;
  try { return parse<{ state?: string; at?: number; leaseUntil?: number }>(c.autofetchV3ProbeRead(handle, work.type, work.imdbId, work.season, work.episode, now)); }
  catch { return undefined; }
}

export function writeBrProbeNative(work: { type: string; imdbId: string; season?: number | null; episode?: number | null }, record: unknown, ttl: number, now = Date.now()): boolean {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3ProbeWrite || !handle) return false;
  try { c.autofetchV3ProbeWrite(handle, work.type, work.imdbId, work.season, work.episode, JSON.stringify(record), ttl, now); return true; }
  catch { return false; }
}

export function readObraNative(key: string, now = Date.now()): unknown[] | null | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3ObraRead || !handle) return undefined;
  try {
    const raw = c.autofetchV3ObraRead(handle, key, now);
    if (raw == null) return null;
    const value = parse<unknown>(raw);
    return value == null ? null : Array.isArray(value) ? value : [];
  }
  catch { return undefined; }
}

export function listObraKeysNative(now = Date.now()): string[] | undefined {
  try { return kv()?.keys('autofetch:v3:o:', now); } catch { return undefined; }
}

export function commitObraNative(key: string, entry: unknown, ttl: number, now = Date.now()): boolean {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3ObraCommit || !handle) return false;
  try { return c.autofetchV3ObraCommit(handle, key, JSON.stringify(entry), ttl, now); }
  catch { return false; }
}

export function forgetObraHashNative(key: string, hash: string, ttl: number, now = Date.now()): boolean | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3ObraForgetHash || !handle) return undefined;
  try { return c.autofetchV3ObraForgetHash(handle, key, hash, ttl, now); }
  catch { return undefined; }
}

export function readSuppressedNative(adapter: string, account: string, hash: string, now = Date.now()): Suppressed | null | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3SuppressedRead || !handle) return undefined;
  try { return parse<Suppressed>(c.autofetchV3SuppressedRead(handle, adapter, account, hash, now)); }
  catch { return undefined; }
}

export function noteSuppressedNative(adapter: string, account: string, hash: string, id: string, ttl: number, now = Date.now()): boolean | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3SuppressedNote || !handle) return undefined;
  try { return c.autofetchV3SuppressedNote(handle, adapter, account, hash, id, ttl, now); }
  catch { return undefined; }
}

export function retrySuppressedNative(adapter: string, account: string, hash: string, ttl: number, now = Date.now()): 'missing' | 'scheduled' | 'given-up' | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3SuppressedRetry || !handle) return undefined;
  try { return c.autofetchV3SuppressedRetry(handle, adapter, account, hash, ttl, now); }
  catch { return undefined; }
}

export function forgetSuppressedNative(adapter: string, account: string, hash: string): boolean | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3SuppressedForget || !handle) return undefined;
  try { return c.autofetchV3SuppressedForget(handle, adapter, account, hash); }
  catch { return undefined; }
}

export function listSuppressedKeysNative(now = Date.now()): string[] | undefined {
  try { return kv()?.keys('autofetch:v3:sup:', now); } catch { return undefined; }
}

export function remainingNative(key: string, now = Date.now()): number | null | undefined {
  try { const handle = kv(); return handle ? handle.remainingSeconds(key, now) : undefined; } catch { return undefined; }
}

export function readLotNative(searchKey: string, now = Date.now()): LotSnapshot | null | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3LotRead || !handle) return undefined;
  try { return parse<LotSnapshot>(c.autofetchV3LotRead(handle, searchKey, now)); }
  catch { return undefined; }
}

export function writeLotNative(searchKey: string, snapshot: LotSnapshot, ttl: number, now = Date.now()): boolean {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3LotWrite || !handle) return false;
  try { c.autofetchV3LotWrite(handle, searchKey, JSON.stringify(snapshot), ttl, now); return true; }
  catch { return false; }
}

export function forgetLotNative(searchKey: string): boolean | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3LotForget || !handle) return undefined;
  try { return c.autofetchV3LotForget(handle, searchKey); } catch { return undefined; }
}

export function lotNativeKey(searchKey: string): string | undefined {
  const c = core();
  if (!c?.autofetchV3LotKey) return undefined;
  try { return c.autofetchV3LotKey(searchKey); } catch { return undefined; }
}

export function setKvNative(key: string, value: unknown, ttlSeconds: number, now = Date.now()): boolean {
  try { const handle = kv(); if (!handle) return false; handle.setJson(key, JSON.stringify(value), ttlSeconds, now); return true; }
  catch { return false; }
}

/**
 * BR-ready (`autofetch:v3:er:<digest>`): prova, por OBRA, que um BR ficou ready
 * — é o que permite um fallback que fica pronto DEPOIS reavaliar a evicção.
 * O prefixo é RUST_OWNED: fora daqui só a varredura nativa (`kvKeys`) o alcança.
 */
export function brReadyNativeKey(digest: string): string | undefined {
  const c = core();
  if (!c?.autofetchV3BrReadyKey) return undefined;
  try { return c.autofetchV3BrReadyKey(digest); } catch { return undefined; }
}

/** Registro `{ at }` vivo; `null` = ausente/vencido, `undefined` = ponte fora. */
export function readBrReadyNative(digest: string, now = Date.now()): { at?: number } | null | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3BrReadyRead || !handle) return undefined;
  try { return parse<{ at?: number }>(c.autofetchV3BrReadyRead(handle, digest, now)); }
  catch { return undefined; }
}

/** Grava a evidência no KV nativo; `false` = sem núcleo/handle (nada foi feito). */
export function noteBrReadyNative(digest: string, ttl: number, now = Date.now()): boolean {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3BrReadyWrite || !handle) return false;
  try { c.autofetchV3BrReadyWrite(handle, digest, Math.max(1, Math.trunc(ttl) || 0), now); return true; }
  catch { return false; }
}

/** Apaga a evidência; `false`/`undefined` = não havia nada ou ponte fora. */
export function forgetBrReadyNative(digest: string): boolean | undefined {
  const c = core(); const handle = kv();
  if (!c?.autofetchV3BrReadyForget || !handle) return undefined;
  try { return c.autofetchV3BrReadyForget(handle, digest); } catch { return undefined; }
}
