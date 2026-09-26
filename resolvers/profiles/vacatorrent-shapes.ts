// Formas de filme/temporada e links internos do VacaTorrent, extraídos do
// vacatorrent-parsers.ts (que ficou no teto de 400) sem mudar API nem
// comportamento: o parsers reexporta tudo daqui e o profile segue importando
// do mesmo caminho.
import { attribute, decodeEntities, stripTags as stripTagsShared } from '../text.js';
import { normalizeSeasonValue } from '../matching.js';

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);

// Filme: página do post → link da página de botões (/movie-links/<id>/).
function extractMovieLinks(html: string | null | undefined, baseUrl?: string): string | null {
  const hrefMatch = /href=["']([^"']*\bmovie-links\b[^"']*)["']/i.exec(String(html || ''));
  const idMatch = /movie-links\/(\d+)/.exec(String(html || ''));
  const href = hrefMatch ? hrefMatch[1] : (idMatch ? `/movie-links/${idMatch[1]}/` : null);
  if (!href) return null;
  try { return new URL(href, baseUrl).href; } catch { return null; }
}

// Série: decoding de data-u (base64) e resolução de season-internal.
function decodeDataU(html: string | null | undefined): string | null {
  const attr = /data-u\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  if (!attr || !attr[1]) return null;
  try { return Buffer.from(attr[1], 'base64').toString('utf8').trim(); } catch { return null; }
}

function seriesSeasonInternalUrl(html: string | null | undefined, baseUrl?: string): string | null {
  const decoded = decodeDataU(html);
  if (decoded && /\bseason-internal\b/.test(decoded)) {
    try { return new URL(decoded, baseUrl).href; } catch {}
  }
  const href = /season-internal\/\?show=\d+/i.exec(String(html || ''));
  if (href) {
    try { return new URL(href[0], baseUrl).href; } catch {}
  }
  const shortlink = /\?p=(\d{4,})/i.exec(String(html || ''));
  if (shortlink) {
    try { return new URL(`/pt/season-internal/?show=${shortlink[1]}`, baseUrl).href; } catch {}
  }
  return null;
}

/** Card de temporada/batch da página season-internal. */
export interface VacaSeasonCard {
  url: string;
  isBatch: boolean;
  season: number | null;
  title: string;
}

function parseSeasonInternal(html: string, baseUrl?: string): VacaSeasonCard[] {
  const cards: VacaSeasonCard[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html))) {
    const classes = String(attribute(match[1], 'class') || '');
    const href = String(attribute(match[1], 'href') || '').trim();
    if (!href) continue;
    const isBatch = /\bsa-card-batch\b/.test(classes) || /\bbatch\b/.test(href);
    const isSeason = /\bsa-card\b/.test(classes) || /\btemporada-\d+\b/.test(href);
    if (!isBatch && !isSeason) continue;

    let resolved: string;
    try { resolved = new URL(href, baseUrl).href; } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const seasonMatch = /temporada-(\d+)/i.exec(resolved);
    let season: number | null = seasonMatch ? Number(seasonMatch[1]) : null;
    if (season != null && (!Number.isFinite(season) || season <= 0)) season = null;

    cards.push({
      url: resolved,
      isBatch,
      season,
      title: stripTags(match[2] || ''),
    });
  }
  return cards;
}

function filterSeasonCards(
  cards: VacaSeasonCard[],
  requestedSeason: RegExpMatchArray | readonly string[] | string | number | null | undefined,
): VacaSeasonCard[] {
  const wanted = normalizeSeasonValue(requestedSeason);
  if (wanted == null) return cards;
  return cards.filter((card) => card.season == null || card.season === wanted);
}

function extractBatchTitle(html: string | null | undefined): string | null {
  const m = /class=["'][^"']*\bbl-hero-title\b[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(String(html || ''));
  if (m) return stripTags(m[1]);
  const h = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i.exec(String(html || ''));
  return h ? stripTags(h[1]) : null;
}

export {
  extractMovieLinks,
  decodeDataU,
  seriesSeasonInternalUrl,
  parseSeasonInternal,
  filterSeasonCards,
  extractBatchTitle,
};
