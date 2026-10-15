import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import type { IndexEntry } from './release-index-types.js';

/** Remove a submissão que recebeu prova terminal de morte. Só entradas
 * `source:autofetch` são tocadas; evidência pública do mesmo hash permanece. */
export function forgetAutofetchHash(imdbId: string | null | undefined, hash: string): number {
  const id = String(imdbId || '');
  const wanted = String(hash || '').toLowerCase();
  if (!/^tt\d+$/.test(id) || !wanted) return 0;
  const base = `${prefix('idx')}${id}`;
  let removed = 0;
  for (const key of cache.keysMatching(base)) {
    if (key !== base && !key.startsWith(`${base}:`)) continue;
    const entry = cache.peek(key) as IndexEntry | null;
    if (!entry?.releases?.length) continue;
    const releases = entry.releases.filter((release) => {
      const drop = release.hash === wanted && release.source === 'autofetch';
      if (drop) removed += 1;
      return !drop;
    });
    if (releases.length === entry.releases.length) continue;
    const remainingSeconds = cache.peekRemaining(key) ?? 0;
    if (!releases.length || remainingSeconds <= 0) cache.forget(key);
    else cache.set(key, { ...entry, releases }, remainingSeconds);
  }
  return removed;
}
