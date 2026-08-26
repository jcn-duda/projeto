/**
 * Utilitários da sonda de disponibilidade no Real-Debrid e promoção de cache ⚡.
 */
import config from '../config.js';
import type { Stream } from '../../types/domain.js';
import * as held from '../debrid/protected.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import {
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  markDebridName,
} from '../utils/format.js';
import * as autofetch from './autofetch.js';
import * as rdLedger from '../debrid/rd-ledger.js';

export const recentMiss = new Map<string, number>();

function missKey(account: string, hash: string) {
  return `${account}:${hash}`;
}

export function wasRecentMiss(account: string, hash: string) {
  if (config.debrid.rdLedger.enabled && rdLedger.peek(hash) === 'miss') return true;
  const at = recentMiss.get(missKey(account, hash));
  if (at == null) return false;
  if (Date.now() - at > config.debrid.rdProbeMissTtlMs) {
    recentMiss.delete(missKey(account, hash));
    return false;
  }
  return true;
}

export function noteMiss(account: string, hash: string) {
  recentMiss.set(missKey(account, hash), Date.now());
  // Poda preguiçosa: o volume é baixo (teto/hora).
  if (recentMiss.size > 2000) {
    const cutoff = Date.now() - config.debrid.rdProbeMissTtlMs;
    for (const [k, at] of recentMiss) {
      if (at < cutoff) recentMiss.delete(k);
    }
  }
}

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
  const entry = cache.get(searchKey) as { streams?: Stream[]; partial?: boolean; debridKnown?: boolean } | undefined;
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

/**
 * Monta a lista de hashes a sondar: BR dublado → dublado global → top swarm.
 * Só entra o que ainda NÃO tem ⚡ (fora de `cached`), não está em hold/autofetch
 * e não errou a sonda há pouco.
 */
export function selectProbeCandidates(
  streams: Stream[],
  cached: Set<string>,
  account: string,
  limit: number,
  apiKey = '',
) {
  const max = Math.max(0, Math.trunc(limit) || 0);
  if (max === 0) return [] as string[];

  const cachedSet = new Set([...cached].map((h) => String(h).toLowerCase()));
  const skip = (hash: string) => {
    const h = hash.toLowerCase();
    if (cachedSet.has(h)) return true;
    if (held.isHeld(h, account)) return true;
    if (cache.get(autofetch.markerKey('realdebrid', account, h))) return true;
    // O ledger é por serviço: hit/blocked também não precisam de nova sonda.
    // Miss usa o backoff durável; com o kill-switch, wasRecentMiss preserva o
    // mapa por conta que existia antes desta fase.
    if (config.debrid.rdLedger.enabled && (rdLedger.isHit(h) || rdLedger.peek(h) === 'blocked')) return true;
    if (wasRecentMiss(account, h)) return true;
    if (apiKey && magnetdb.isBad('realdebrid', apiKey, h)) return true;
    return false;
  };

  const picked: string[] = [];
  const seen = new Set<string>();
  // Oversample: o autofetch segura hold nos melhores BR antes da sonda —
  // pedir só `max` fazia a lista inteira cair no skip e a sonda virar no-op.
  const poolLimit = Math.max(max * 4, max + 8);
  const push = (list: Stream[]) => {
    for (const s of list) {
      const h = String(s.infoHash || '').toLowerCase();
      if (!h || seen.has(h) || skip(h)) continue;
      seen.add(h);
      picked.push(h);
      if (picked.length >= max) return true;
    }
    return false;
  };

  if (push(pickBrDubbedCandidates(streams, cachedSet, poolLimit))) return picked;
  if (push(pickAnyDubbedCandidates(streams, cachedSet, poolLimit))) return picked;
  push(pickTopSeededCandidates(streams, cachedSet, poolLimit, { minSeeders: 1 }));
  return picked;
}
