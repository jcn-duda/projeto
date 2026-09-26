import type { RawItem } from '../../types/domain.js';
import {
  matchesEpisode,
  matchesGlobalSeriesNoMarker,
  magnetSeasonContradicts,
  normalizeTitle,
  extractInfoHash,
} from '../utils/format.js';
import { magnetDisplayName } from '../utils/title-normalization.js';
import { bankRowsForMediaSource } from '../utils/release-index-media.js';

/**
 * Corta episódio/temporada errados. Índice entrega só hash (sem URI): sem dn=
 * o corte era fail-open e o pack Apache "4ª Temporada" com magnet S04E03
 * passava em S4E1. Enriquece em lote a partir do banco vivo — clone local.
 */
export function filterSeriesEpisodeRaw(
  items: RawItem[],
  season: number,
  episode: number,
  seriesUniverse: string[],
): { kept: RawItem[]; dropped: RawItem[] } {
  let raw = items;
  const needBank = raw.flatMap((r) => {
    if (magnetDisplayName(r)) return [];
    const hash = String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();
    return hash ? [{ item: r, hash }] : [];
  });
  const bankByHash = bankRowsForMediaSource(needBank);
  if (bankByHash.size) {
    raw = raw.map((r) => {
      if (magnetDisplayName(r)) return r;
      const hash = String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();
      const uri = hash ? bankByHash.get(hash)?.uri : null;
      return uri ? { ...r, magnet: uri } : r;
    });
  }
  const kept: RawItem[] = [];
  const dropped: RawItem[] = [];
  for (const r of raw) {
    const title = r.title || r.Title || '';
    if (!matchesEpisode(title, { season, episode })) {
      dropped.push(r);
      continue;
    }
    if (magnetSeasonContradicts(r, season, episode)) {
      dropped.push(r);
      continue;
    }
    if (r.fromAccount || r.isBr) {
      kept.push(r);
      continue;
    }
    if (matchesGlobalSeriesNoMarker(title, normalizeTitle(title).split(' ').filter(Boolean), seriesUniverse)) {
      kept.push(r);
    } else {
      dropped.push(r);
    }
  }
  return { kept, dropped };
}
