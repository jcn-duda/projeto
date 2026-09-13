import {
  decodeEntities,
  escapeHtml,
  attribute,
  stripTags as stripTagsShared,
  extractMetaRefresh as sharedExtractMetaRefresh,
} from '../text.js';
import type { DecodeEntities } from '../text.js';
import {
  matchesResolverQuery,
  matchesSeasonSeason,
  buttonId,
} from '../matching.js';
import { BASE_PROTECTOR_SUFFIXES, hasAllowedHost } from '../protector.js';
import { createMagnetExtractor, discoverNextUrl } from '../magnet-extract.js';
import {
  createQualityRules,
  createSourceRules,
  VACA_SOURCE_MATCH_RE,
  createEpisodeRules,
  createEpisodeStep,
  createLinkCollector,
  createProtectorHrefResolver,
} from '../release-rules.js';
import type { LinkCollectorConfig } from '../release-rules.js';
import {
  UNKNOWN_SIZE,
  createReleaseTitle,
  createSearchPageHtml,
  createNormalizeQuery,
} from '../release-format.js';
import type { ReleaseTitleInput, ReleaseTitlePost } from '../release-format.js';
import type { ResolverLink, ResolverPost } from '../types.js';
import {
  extractMovieLinks,
  decodeDataU,
  seriesSeasonInternalUrl,
  parseSeasonInternal,
  filterSeasonCards,
  extractBatchTitle,
} from './vacatorrent-shapes.js';
export type { VacaSeasonCard } from './vacatorrent-shapes.js';

// Hosts históricos e de salto do protetor VacaTorrent.
const FALLBACK_SITE_SUFFIXES = ['vaqueirofilmes.com', 'vacatorrentmov.com'];
const ASSERT_ONLY_SUFFIXES = ['t.co', 'vacadb.org'];

// Import-safe: a lista do site é estática. EXTRA_ALLOWED_PROTECTORS entra pelo
// bootstrap do profile (injetado via isProtectorHost), não aqui.
const ALL_PROTECTOR_SUFFIXES = Array.from(new Set([
  ...BASE_PROTECTOR_SUFFIXES,
  'systemtech.space',
]));

const defaultIsProtectorHost = (h: string | null | undefined) => hasAllowedHost(h, ALL_PROTECTOR_SUFFIXES);
const defaultIsAssertOnlyHost = (h: string | null | undefined) => hasAllowedHost(h, ASSERT_ONLY_SUFFIXES);

const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LOCATION|next_url|target_url|dest|target|link|url|next)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);
const extractMetaRefresh = (html: string | null | undefined) => sharedExtractMetaRefresh(html, decodeEntities);

// Query: o search_posts do WP é LIKE sobre o título SEM ano.
const normalizeQuery = createNormalizeQuery({ dropYear: true });

function requestedSeasonFromQuery(value: string | null | undefined): RegExpMatchArray | null {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

// Classificadores de qualidade/fonte (núcleo) e áudio PRÓPRIO da vaca.
const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules({ matchPattern: VACA_SOURCE_MATCH_RE });

function classifyAudio(context: string | null | undefined): 'dual' | 'dublado' | 'legendado' | null {
  const text = String(context || '').toUpperCase();
  const hasPt = /PORTUGU[ÊE]S|PORTUGUES/.test(text);
  const hasForeign = /INGL[ÊE]S|INGLES|ESPANHOL|JAPON[ÊE]S|COREANO|LEGENDAD|ORIGINAL/.test(text);
  return hasPt ? (hasForeign ? 'dual' : 'dublado') : hasForeign ? 'legendado' : null;
}

// Episódio/pack com regex específicos da vaca (\bbatch\b no pack, [.\-s]* na faixa).
const episodeRules = createEpisodeRules({
  packPattern: /\b(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|\bPACK\b|\bbatch\b)\b/i,
  rangePattern: /(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\-s]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b/i,
});
const extractEpisode = episodeRules.extractEpisode;
const episodeStep = createEpisodeStep({
  scope: 'anchor-writes',
  packRe: episodeRules.packPattern,
  rangeRe: episodeRules.rangePattern,
  epRe: episodeRules.episodePattern,
  extract: episodeRules.extractEpisode,
  packMatchAll: episodeRules.packPattern,
  tieBreak: true,
});

// extractMagnet com decodificação base64 no atributo data-link do gate-2 vacadb.
const extractMagnet = createMagnetExtractor({
  decodeEntities,
  encodedVariants: true,
  b64DataLink: true,
});

/** Opções da factory do nextProtectedUrl da vaca. */
export interface VacaNextProtectedUrlOptions {
  isProtectorHost?: (hostname: string) => boolean;
  isAssertOnlyHost?: (hostname: string) => boolean;
  decodeEntities?: DecodeEntities;
  protectorSuffixes?: string[];
  extractMetaRefresh?: (html: string | null | undefined) => string | null;
}

function createNextProtectedUrl(options: VacaNextProtectedUrlOptions = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const isAssertOnly = options.isAssertOnlyHost || defaultIsAssertOnlyHost;
  const decode = options.decodeEntities || decodeEntities;
  const suffixes = options.protectorSuffixes || ALL_PROTECTOR_SUFFIXES;
  const extractRefresh = options.extractMetaRefresh || extractMetaRefresh;

  const isDifferentUrl = (destHref: string | null | undefined, base: string | undefined): boolean => {
    if (!destHref) return false;
    if (!base) return true;
    const clean = (url: string) => String(url).replace(/#.*$/, '').replace(/\/+$/, '');
    return clean(destHref) !== clean(base);
  };

  return function nextProtectedUrl(html: string | null | undefined, baseUrl?: string): string | null {
    if (!html) return null;
    const str = String(html);

    // 1. const next = "<url>" / let / var / window.next = ...
    // Atribuição JS (`const/let/var`, `window.next` ou direta), não atributo
    // HTML: o lookbehind barra `data-next="…"`/`x-next="…"` e `meunext=`. Sem
    // ele um atributo isca apontando para host permitido VENCE o `next` real,
    // porque o laço devolve o primeiro destino válido que encontrar — e é este
    // ramo (o único além do assert) que aceita host assert-only.
    const nextRe = /(?:(?:const|let|var)\s+|window\.)?(?<![-\w])next\s*=\s*["'`]([^"'`]+)["'`]/gi;
    let nextMatch: RegExpExecArray | null;
    while ((nextMatch = nextRe.exec(str)) !== null) {
      try {
        const jsonUnescaped = String(nextMatch[1]).replace(/\\\//g, '/').replace(/\\"/g, '"');
        const u = new URL(decode(jsonUnescaped), baseUrl);
        if (/(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(u.hostname)) {
          const q = u.searchParams.get('q');
          if (q && q.trim()) {
            try {
              let target = decode(q.trim());
              if (/^https?%3A%2F%2F/i.test(target)) {
                try { target = decodeURIComponent(target); } catch {}
              }
              const dest = new URL(target, baseUrl);
              if ((isProtector(dest.hostname) || isAssertOnly(dest.hostname)) && isDifferentUrl(dest.href, baseUrl)) {
                return dest.href;
              }
            } catch {}
          }
        } else if ((isProtector(u.hostname) || isAssertOnly(u.hostname)) && isDifferentUrl(u.href, baseUrl)) {
          return u.href;
        }
      } catch {}
    }

    // 2. URL_ETAPA2 (gate-2 da vacadb.org).
    const etapa2Re = /URL_ETAPA2\s*=\s*["'`\`]([^"'`\`]+)["'`\`]/gi;
    let etapa2Match: RegExpExecArray | null;
    while ((etapa2Match = etapa2Re.exec(str)) !== null) {
      try {
        const jsonUnescaped = String(etapa2Match[1]).replace(/\\\//g, '/').replace(/\\"/g, '"');
        const u = new URL(decode(jsonUnescaped), baseUrl);
        if ((isProtector(u.hostname) || isAssertOnly(u.hostname)) && isDifferentUrl(u.href, baseUrl)) {
          return u.href;
        }
      } catch {}
    }

    // 3. Meta refresh.
    const refreshValue = extractRefresh(str);
    if (refreshValue) {
      try {
        const u = new URL(decode(refreshValue), baseUrl);
        if ((isProtector(u.hostname) || isAssertOnly(u.hostname)) && isDifferentUrl(u.href, baseUrl)) {
          return u.href;
        }
      } catch {}
    }

    // 4. Bloco genérico.
    const discovered = discoverNextUrl(str, baseUrl, {
      isProtectorHost: isProtector,
      decodeEntities: decode,
      protectorSuffixes: suffixes,
      jsVarPattern: JS_URL_VAR_RE,
    });
    if (discovered && isDifferentUrl(discovered, baseUrl)) return discovered;
    return null;
  };
}

const nextProtectedUrl = createNextProtectedUrl();

/** Obra da busca AJAX (search_posts) do VacaTorrent. */
export interface VacaWork {
  url: string;
  title: string;
  type: 'Filme' | 'Série';
  year: number | null;
  poster: string | null;
  idioma?: string | null;
  imdb?: string | null;
}

// Parse da busca AJAX (search_posts).
function parseSearchJson(text: string | null | undefined, baseUrl = 'https://vaqueirofilmes.com'): VacaWork[] {
  // `any` explícito: payload de terceiro (JSON de API) — a tipagem só existe
  // nos campos que este parser lê, abaixo.
  let parsed: any;
  try { parsed = JSON.parse(String(text)); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : (parsed?.results ?? parsed?.posts);
  if (!Array.isArray(arr)) return [];

  const posts: VacaWork[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    if (!raw) continue;
    const title = stripTags(String(raw.title || '')).trim();
    const link = raw.link || raw.url;
    if (!title || !link) continue;
    let resolved: string;
    try { resolved = new URL(String(link), baseUrl).href; } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const type: 'Filme' | 'Série' = /filme/i.test(String(raw.type || '')) ? 'Filme' : 'Série';
    let year: number | null = Number(raw.year);
    if (year == null || !Number.isFinite(year) || year < 1900 || year > 2100) year = null;

    posts.push({
      url: resolved, title, type, year,
      poster: raw.thumbnail ? decodeEntities(String(raw.thumbnail)) : null,
      idioma: raw.idioma ? String(raw.idioma) : null,
      imdb: raw.imdb ? String(raw.imdb) : null,
    });
  }
  return posts;
}

function filterSearchPosts(
  entries: VacaWork[],
  query: string,
  requestedSeason: RegExpMatchArray | readonly string[] | string | number | null | undefined,
  maxPosts = 3,
): VacaWork[] {
  const normalized = normalizeQuery(query);
  let posts = entries;
  if (normalized) posts = entries.filter((post) => matchesResolverQuery(post, normalized));
  if (requestedSeason) posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
  return posts.slice(0, maxPosts);
}

/** Opções da factory do coletor de links da vaca. */
export interface VacaParseDownloadLinksOptions {
  isProtectorHost?: (hostname: string) => boolean;
  decodeEntities?: DecodeEntities;
  stripTags?: (value: string) => string;
  attribute?: (tag: string | null | undefined, name: string, options?: { decode?: (value: string) => string }) => string | null;
}

function createParseDownloadLinks(options: VacaParseDownloadLinksOptions = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const decode = options.decodeEntities || decodeEntities;
  const strip = options.stripTags || stripTags;
  const attr = options.attribute || attribute;

  const cfg: LinkCollectorConfig = {
    anchorRe: /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    resolveHref: createProtectorHrefResolver({ isProtectorHost: isProtector, decodeEntities: decode, attribute: attr }),
    anchorTextOf: (match) => strip(match[2] || ''),
    stripTags: strip,
    decodeHtml: decode,
    initialAudio: null,
    audioFromSegment: classifyAudio,
    audioFromAnchor: classifyAudio,
    episodeStep,
    qualityFn: normalizeQuality,
    sourceFn: normalizeSource,
    extrasOf: (opts) => ({ season: opts.season ?? null, realTitle: opts.realTitle ?? null }),
  };
  return createLinkCollector(cfg);
}

const parseDownloadLinks = createParseDownloadLinks();

// Formas de filme/temporada (movie-links, data-u/season-internal, cards,
// batch title) vivem em `vacatorrent-shapes.ts` — extraídas para este módulo
// caber no teto de 400. São reexportadas abaixo para a API pública não mudar.

// Título da release.
function cleanMarkTitle(title: string | null | undefined = ''): string {
  return decodeEntities(String(title || ''))
    .replace(/\s*Vaca\s+Torrent\s*/gi, ' ')
    .replace(/\s*Download\s*/gi, ' ')
    .replace(/\s*Baixar\s*/gi, ' ')
    .replace(/\s*ver\s+online\s*/gi, ' ')
    .replace(/\s*(?:dublado|dublada|legendado|legendada)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const releaseTitle = createReleaseTitle({
  cleanTitle: cleanMarkTitle,
  titleOf: (post: ReleaseTitlePost, link: ReleaseTitleInput) =>
    link?.realTitle || (typeof post === 'string' ? post : post?.title) || '',
  audioTagOf: (link: ReleaseTitleInput) =>
    link?.audio === 'dublado' ? 'DUBLADO'
      : link?.audio === 'dual' ? 'DUAL'
        : link?.audio === 'legendado' ? 'LEGENDADO' : null,
  seasonOf: (post: ReleaseTitlePost, link: ReleaseTitleInput) => (!link?.realTitle && link?.season != null)
    ? `S${String(link.season).padStart(2, '0')}` : '',
  episodeOf: (post: ReleaseTitlePost, link: ReleaseTitleInput) => (!link?.realTitle && link?.episode != null)
    ? `E${String(link.episode).padStart(2, '0')}` : '',
  yearOf: (post: ReleaseTitlePost, link: ReleaseTitleInput) => (!link?.realTitle && typeof post === 'object' && post?.year) ? ` (${post.year})` : '',
});

/** Opções da factory da página sintética da vaca. */
export interface VacaSearchPageOptions {
  selfUrl?: string;
  escape?: (value: string | null | undefined) => string;
  releaseTitle?: (post: ReleaseTitlePost, link: ReleaseTitleInput, index?: number | null) => string;
}

function createVacaSearchPageHtml(options: VacaSearchPageOptions = {}) {
  const selfUrl = options.selfUrl || 'http://vacatorrent-resolver:8704';
  const escape = options.escape || escapeHtml;
  const relTitle = options.releaseTitle || releaseTitle;
  return createSearchPageHtml({
    selfUrl,
    escape,
    releaseTitle: relTitle,
    rowExtras: (post: ResolverPost) => (post.poster ? `<div class="poster"><img src="${escape(post.poster)}"></div>` : ''),
    descriptionOf: (post: ResolverPost) => post.title || '',
  });
}

const searchPageHtml = createVacaSearchPageHtml();

function scoreLink(link: ResolverLink): number {
  const audio = link.audio === 'dublado' || link.audio === 'dual' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
  return audio + source + Number(link.quality || 0);
}

export {
  FALLBACK_SITE_SUFFIXES, ASSERT_ONLY_SUFFIXES, ALL_PROTECTOR_SUFFIXES, JS_URL_VAR_RE,
  defaultIsProtectorHost, defaultIsAssertOnlyHost, stripTags, extractMetaRefresh,
  normalizeQuery, requestedSeasonFromQuery, normalizeQuality, normalizeSource,
  classifyAudio, episodeRules, extractEpisode, episodeStep, extractMagnet,
  createNextProtectedUrl, nextProtectedUrl, parseSearchJson, filterSearchPosts,
  createParseDownloadLinks, parseDownloadLinks, extractMovieLinks, decodeDataU,
  seriesSeasonInternalUrl, parseSeasonInternal, filterSeasonCards, extractBatchTitle,
  cleanMarkTitle, releaseTitle, createVacaSearchPageHtml, searchPageHtml, scoreLink,
};
