import * as cache from '../utils/cache.js';
import { commitObraNative, forgetObraHashNative, readObraNative } from '../utils/autofetch-state-native.js';
import type { ObraEntry } from './autofetch-obra.js';

/** Leitura defensiva do registro persistido: formato estranho = vazio. */
export function readObraRecord(key: string): ObraEntry[] {
  if (!key) return [];
  const native = readObraNative(key);
  const raw = native == null ? cache.get(key) as { entries?: unknown } | null : { entries: native };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return [];
  const out: ObraEntry[] = [];
  for (const item of raw.entries) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const hash = String(e.hash || '').toLowerCase();
    if (!hash) continue;
    out.push({
      hash, pool: String(e.pool || ''),
      acceptedAt: Number.isFinite(Number(e.acceptedAt)) ? Number(e.acceptedAt) : 0,
      ...(e.title != null ? { title: String(e.title) } : {}),
      br: e.br === true, dubbed: e.dubbed === true,
      ...(e.id != null && e.id !== '' ? { id: String(e.id) } : {}),
      ...(e.quality != null && e.quality !== '' ? { quality: String(e.quality) } : {}),
      ...(e.overflow === true ? { overflow: true } : {}),
    });
  }
  return out;
}

export function commitObraRecordNative(key: string, entry: ObraEntry, ttl: number, now: number): boolean {
  return commitObraNative(key, entry, ttl, now);
}

export function forgetObraRecordHashNative(key: string, hash: string, ttl: number): boolean | undefined {
  return forgetObraHashNative(key, hash, ttl);
}
