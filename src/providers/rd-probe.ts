/**
 * Promoção de cache ⚡ do Real-Debrid nas listas de streams já cacheadas.
 */
import config from '../config.js';
import type { Stream } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import { markDebridName } from '../utils/format.js';

/** Extrai infoHash de uma URL /resolve/... gravada na lista cacheada. */
export function hashFromResolveUrl(url: string): string | null {
  const m = String(url || '').match(/\/resolve\/([a-fA-F0-9]{40})\b/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Reescreve nomes [RD download] → [RD⚡] na entrada streams:v6 atual.
 * Devolve quantos itens promoveu; 0 se não havia cache.
 */
export function promoteCachedBolts(searchKey: string, instantHashes: string[]): number {
  // peek: só LÊ — a varredura de toda a lista de streams não pode contar
  // cache.hit.streams nem promover o LRU para cada título sem match. A promoção
  // de verdade acontece no set() abaixo, com o TTL preservado via peekRemaining.
  const entry = cache.peek(searchKey) as { streams?: Stream[]; partial?: boolean; debridKnown?: boolean } | undefined;
  if (!entry || !Array.isArray(entry.streams) || instantHashes.length === 0) return 0;
  const want = new Set(instantHashes.map((h) => h.toLowerCase()));
  let promoted = 0;
  const streams = entry.streams.map((s) => {
    const hash = hashFromResolveUrl(String((s as any).url || ''));
    if (!hash || !want.has(hash)) return s;
    const raw = String(s.name || '');
    if (raw.includes('\u26a1')) return s;
    const without = raw.replace(/^\[[^\]]+\]\s*/, '');
    promoted += 1;
    return { ...s, name: markDebridName(without, 'RD', true) };
  });
  if (!promoted) return 0;
  const remainingMs = cache.peekRemaining(searchKey);
  const ttlSeconds = remainingMs != null && remainingMs > 0
    ? Math.max(1, Math.ceil(remainingMs / 1000))
    : config.cacheTtl;
  cache.set(searchKey, { ...entry, streams }, ttlSeconds);
  return promoted;
}

/**
 * Itera todas as entradas streams:v6 ativas no L1 e reescreve as que contenham o hash confirmado.
 * Devolve quantos streams foram promovidos ao todo.
 */
export function promoteCachedBoltsAcrossStreams(instantHashes: string[]): number {
  if (!instantHashes || !instantHashes.length) return 0;
  const streamKeys = cache.keysMatching(prefix('streams'));
  let totalPromoted = 0;
  for (const key of streamKeys) {
    totalPromoted += promoteCachedBolts(key, instantHashes);
  }
  return totalPromoted;
}
