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
import { parseTitleSeasonEpisode } from '../utils/episode-matching.js';
import config from '../config.js';

function namesEpisode(r: RawItem, title: string, episode: number): boolean {
  return [title, magnetDisplayName(r) || ''].some((t) => parseTitleSeasonEpisode(t).episodes.includes(episode));
}

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
  airDate?: string | null,
  now = Date.now(),
): { kept: RawItem[]; dropped: RawItem[] } {
  let raw = items;
  // Episódio que ainda não foi ao ar: pack da temporada ou série completa
  // publicado ANTES dele não pode contê-lo. Medido em Lanterns S01E08
  // (2026-09-30, estreia 05/10): o pack "Lanterns.S01.2160p" pronto na conta
  // entrava com ⚡ e o play morria no EpisodePickError. Só fica a release que
  // NOMEIA o episódio (vazamento existe). A margem (SEARCH_UNAIRED_MARGIN_MS,
  // 24h) cobre fuso e a estreia no streaming antes da TV.
  const airAt = Date.parse(String(airDate || ''));
  const margin = config.search.unairedMarginMs;
  const unaired = margin > 0 && Number.isFinite(airAt) && airAt - now > margin;
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
    if (unaired && !namesEpisode(r, title, episode)) {
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
