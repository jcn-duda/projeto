'use strict';

const {
  decodeEntities,
  escapeHtml,
  attribute,
  stripTags: stripTagsShared,
  extractMetaRefresh: sharedExtractMetaRefresh,
} = require('../text');
const {
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  buttonId,
} = require('../matching');
const { BASE_PROTECTOR_SUFFIXES, hasAllowedHost } = require('../protector');
const { parseExtraProtectors } = require('../runtime');
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');
const {
  createQualityRules,
  createSourceRules,
  VACA_SOURCE_MATCH_RE,
  createEpisodeRules,
  createEpisodeStep,
  createLinkCollector,
  createProtectorHrefResolver,
} = require('../release-rules');
const {
  UNKNOWN_SIZE,
  createReleaseTitle,
  createSearchPageHtml,
  createNormalizeQuery,
} = require('../release-format');

// Hosts históricos e de salto do protetor VacaTorrent.
const FALLBACK_SITE_SUFFIXES = ['vaqueirofilmes.com', 'vacatorrentmov.com'];
const ASSERT_ONLY_SUFFIXES = ['t.co', 'vacadb.org'];

const extraProtectors = parseExtraProtectors(process.env.EXTRA_ALLOWED_PROTECTORS);
const ALL_PROTECTOR_SUFFIXES = Array.from(new Set([
  ...BASE_PROTECTOR_SUFFIXES,
  'systemtech.space',
  ...extraProtectors,
]));

const defaultIsProtectorHost = (h) => hasAllowedHost(h, ALL_PROTECTOR_SUFFIXES);
const defaultIsAssertOnlyHost = (h) => hasAllowedHost(h, ASSERT_ONLY_SUFFIXES);

const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LOCATION|next_url|target_url|dest|target|link|url|next)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);
const extractMetaRefresh = (html) => sharedExtractMetaRefresh(html, decodeEntities);

// Query: o search_posts do WP é LIKE sobre o título SEM ano.
const normalizeQuery = createNormalizeQuery({ dropYear: true });

function requestedSeasonFromQuery(value) {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

// Classificadores de qualidade/fonte (núcleo) e áudio PRÓPRIO da vaca.
const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules({ matchPattern: VACA_SOURCE_MATCH_RE });

function classifyAudio(context) {
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

function createNextProtectedUrl(options = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const isAssertOnly = options.isAssertOnlyHost || defaultIsAssertOnlyHost;
  const decode = options.decodeEntities || decodeEntities;
  const suffixes = options.protectorSuffixes || ALL_PROTECTOR_SUFFIXES;
  const extractRefresh = options.extractMetaRefresh || extractMetaRefresh;

  const isDifferentUrl = (destHref, base) => {
    if (!destHref) return false;
    if (!base) return true;
    const clean = (url) => String(url).replace(/#.*$/, '').replace(/\/+$/, '');
    return clean(destHref) !== clean(base);
  };

  return function nextProtectedUrl(html, baseUrl) {
    if (!html) return null;
    const str = String(html);

    // 1. const next = "<url>" / let / var / window.next = ...
    // Atribuição JS (`const/let/var`, `window.next` ou direta), não atributo
    // HTML: o lookbehind barra `data-next="…"`/`x-next="…"` e `meunext=`. Sem
    // ele um atributo isca apontando para host permitido VENCE o `next` real,
    // porque o laço devolve o primeiro destino válido que encontrar — e é este
    // ramo (o único além do assert) que aceita host assert-only.
    const nextRe = /(?:(?:const|let|var)\s+|window\.)?(?<![-\w])next\s*=\s*["'`]([^"'`]+)["'`]/gi;
    let nextMatch;
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
    let etapa2Match;
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

// Parse da busca AJAX (search_posts).
function parseSearchJson(text, baseUrl = 'https://vaqueirofilmes.com') {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : (parsed?.results ?? parsed?.posts);
  if (!Array.isArray(arr)) return [];

  const posts = [];
  const seen = new Set();
  for (const raw of arr) {
    if (!raw) continue;
    const title = stripTags(String(raw.title || '')).trim();
    const link = raw.link || raw.url;
    if (!title || !link) continue;
    let resolved;
    try { resolved = new URL(String(link), baseUrl).href; } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const type = /filme/i.test(String(raw.type || '')) ? 'Filme' : 'Série';
    let year = Number(raw.year);
    if (!Number.isFinite(year) || year < 1900 || year > 2100) year = null;

    posts.push({
      url: resolved, title, type, year,
      poster: raw.thumbnail ? decodeEntities(String(raw.thumbnail)) : null,
      idioma: raw.idioma ? String(raw.idioma) : null,
      imdb: raw.imdb ? String(raw.imdb) : null,
    });
  }
  return posts;
}

function filterSearchPosts(entries, query, requestedSeason, maxPosts = 3) {
  const normalized = normalizeQuery(query);
  let posts = entries;
  if (normalized) posts = entries.filter((post) => matchesResolverQuery(post, normalized));
  if (requestedSeason) posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
  return posts.slice(0, maxPosts);
}

function createParseDownloadLinks(options = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const decode = options.decodeEntities || decodeEntities;
  const strip = options.stripTags || stripTags;
  const attr = options.attribute || attribute;

  return createLinkCollector({
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
  });
}

const parseDownloadLinks = createParseDownloadLinks();

// Filme: página do post → link da página de botões (/movie-links/<id>/).
function extractMovieLinks(html, baseUrl) {
  const hrefMatch = /href=["']([^"']*\bmovie-links\b[^"']*)["']/i.exec(String(html || ''));
  const idMatch = /movie-links\/(\d+)/.exec(String(html || ''));
  const href = hrefMatch ? hrefMatch[1] : (idMatch ? `/movie-links/${idMatch[1]}/` : null);
  if (!href) return null;
  try { return new URL(href, baseUrl).href; } catch { return null; }
}

// Série: decoding de data-u (base64) e resolução de season-internal.
function decodeDataU(html) {
  const attr = /data-u\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  if (!attr || !attr[1]) return null;
  try { return Buffer.from(attr[1], 'base64').toString('utf8').trim(); } catch { return null; }
}

function seriesSeasonInternalUrl(html, baseUrl) {
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

function parseSeasonInternal(html, baseUrl) {
  const cards = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const classes = String(attribute(match[1], 'class') || '');
    const href = String(attribute(match[1], 'href') || '').trim();
    if (!href) continue;
    const isBatch = /\bsa-card-batch\b/.test(classes) || /\bbatch\b/.test(href);
    const isSeason = /\bsa-card\b/.test(classes) || /\btemporada-\d+\b/.test(href);
    if (!isBatch && !isSeason) continue;

    let resolved;
    try { resolved = new URL(href, baseUrl).href; } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const seasonMatch = /temporada-(\d+)/i.exec(resolved);
    let season = seasonMatch ? Number(seasonMatch[1]) : null;
    if (!Number.isFinite(season) || season <= 0) season = null;

    cards.push({
      url: resolved,
      isBatch,
      season,
      title: stripTags(match[2] || ''),
    });
  }
  return cards;
}

function filterSeasonCards(cards, requestedSeason) {
  const wanted = normalizeSeasonValue(requestedSeason);
  if (wanted == null) return cards;
  return cards.filter((card) => card.season == null || card.season === wanted);
}

function extractBatchTitle(html) {
  const m = /class=["'][^"']*\bbl-hero-title\b[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(String(html || ''));
  if (m) return stripTags(m[1]);
  const h = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i.exec(String(html || ''));
  return h ? stripTags(h[1]) : null;
}

// Título da release.
function cleanMarkTitle(title = '') {
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
  titleOf: (post, link) => link?.realTitle || (typeof post === 'string' ? post : post?.title) || '',
  audioTagOf: (link) =>
    link?.audio === 'dublado' ? 'DUBLADO'
      : link?.audio === 'dual' ? 'DUAL'
        : link?.audio === 'legendado' ? 'LEGENDADO' : null,
  seasonOf: (post, link) => (!link?.realTitle && link?.season != null)
    ? `S${String(link.season).padStart(2, '0')}` : '',
  episodeOf: (post, link) => (!link?.realTitle && link?.episode != null)
    ? `E${String(link.episode).padStart(2, '0')}` : '',
  yearOf: (post, link) => (!link?.realTitle && post?.year) ? ` (${post.year})` : '',
});

function createVacaSearchPageHtml(options = {}) {
  const selfUrl = options.selfUrl || 'http://vacatorrent-resolver:8704';
  const escape = options.escape || escapeHtml;
  const relTitle = options.releaseTitle || releaseTitle;
  return createSearchPageHtml({
    selfUrl,
    escape,
    releaseTitle: relTitle,
    rowExtras: (post) => (post.poster ? `<div class="poster"><img src="${escape(post.poster)}"></div>` : ''),
    descriptionOf: (post) => post.title || '',
  });
}

const searchPageHtml = createVacaSearchPageHtml();

function scoreLink(link) {
  const audio = link.audio === 'dublado' || link.audio === 'dual' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
  return audio + source + Number(link.quality || 0);
}

module.exports = {
  FALLBACK_SITE_SUFFIXES, ASSERT_ONLY_SUFFIXES, ALL_PROTECTOR_SUFFIXES, JS_URL_VAR_RE,
  defaultIsProtectorHost, defaultIsAssertOnlyHost, stripTags, extractMetaRefresh,
  normalizeQuery, requestedSeasonFromQuery, normalizeQuality, normalizeSource,
  classifyAudio, episodeRules, extractEpisode, episodeStep, extractMagnet,
  createNextProtectedUrl, nextProtectedUrl, parseSearchJson, filterSearchPosts,
  createParseDownloadLinks, parseDownloadLinks, extractMovieLinks, decodeDataU,
  seriesSeasonInternalUrl, parseSeasonInternal, filterSeasonCards, extractBatchTitle,
  cleanMarkTitle, releaseTitle, createVacaSearchPageHtml, searchPageHtml, scoreLink,
};
