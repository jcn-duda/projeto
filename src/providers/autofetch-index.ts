import type { Stream } from '../../types/domain.js';
import * as releaseIndex from '../utils/release-index.js';
import * as metrics from '../utils/metrics.js';

type AutofetchIndexCandidate = Partial<Stream> & {
  infoHash?: string;
  br?: boolean;
  dubbed?: boolean;
  lied?: boolean;
  quality?: string;
  seeders?: number;
  pool?: string;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
};

/** Fecha o ciclo Chupim → índice usando somente a evidência já classificada na
 * seleção. `source:autofetch` torna a release visível sem fingir cobertura. */
export function recordAutofetchRelease(
  imdbId: string | null | undefined,
  candidate: AutofetchIndexCandidate,
): number {
  const id = String(imdbId || '');
  const hash = String(candidate.infoHash || '').toLowerCase();
  if (!/^tt\d+$/.test(id) || !hash) return 0;
  // O pool de seeders é só fallback de swarm e não fecha o ciclo BR/dublado.
  // Persisti-lo mudaria a primeira resposta da obra por semanas sem benefício.
  if (!candidate.br && !candidate.dubbed && !candidate._br && !candidate._dubbed) {
    metrics.count('autofetch.index.skipped.no-dub');
    return 0;
  }
  const title = String(candidate.title || candidate.name || '').split('\n')[0].trim();
  const added = releaseIndex.record(id, {
    season: candidate.season,
    episode: candidate.episode,
  }, [{
    title,
    infoHash: hash,
    size: candidate._size,
    indexer: candidate._indexer || candidate._tracker || 'autofetch',
    isBr: candidate.br ?? Boolean(candidate._br),
    dubbed: candidate.dubbed ?? Boolean(candidate._dubbed),
    lied: Boolean(candidate.lied ?? candidate._lied),
    quality: candidate.quality || candidate._quality,
    seeders: candidate.seeders ?? candidate._seeders ?? 0,
  }], { source: 'autofetch' });
  metrics.count('autofetch.index.recorded', added);
  return added;
}
