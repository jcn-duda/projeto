'use strict';

// Vaca Torrent (vaqueirofilmes.com) — perfil do resolver local.
const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
const { createServer: createHttpServer } = require('../http-server');
const {
  decodeEntities,
  escapeHtml,
  parseSize,
  attribute,
} = require('../text');
const {
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  isGenericListPost,
  buttonId,
  pickButton,
} = require('../matching');
const { createProfile } = require('../site-profile');
const {
  createResolverRouter, createHealthRoute, createSearchRoute, createResolveRoute,
} = require('../resolver-http');
const { tryLinksInOrder } = require('../release-format');
const {
  FALLBACK_SITE_SUFFIXES,
  ASSERT_ONLY_SUFFIXES,
  ALL_PROTECTOR_SUFFIXES,
  extractMetaRefresh,
  normalizeQuery,
  requestedSeasonFromQuery,
  normalizeQuality,
  normalizeSource,
  classifyAudio,
  episodeRules,
  extractEpisode,
  episodeStep,
  extractMagnet,
  createNextProtectedUrl,
  nextProtectedUrl: defaultNextProtectedUrl,
  parseSearchJson,
  filterSearchPosts,
  createParseDownloadLinks,
  parseDownloadLinks,
  extractMovieLinks,
  decodeDataU,
  seriesSeasonInternalUrl,
  parseSeasonInternal,
  filterSeasonCards,
  extractBatchTitle,
  cleanMarkTitle,
  releaseTitle,
  createVacaSearchPageHtml,
  scoreLink,
} = require('./vacatorrent-parsers');

const PORT = Number(process.env.PORT || 8704);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 10;
const MAX_POSTS = Number(process.env.MAX_POSTS || 3);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);

// --- Bootstrap comum (site-profile) ---
const bootstrap = createProfile({
  name: 'vacatorrent',
  port: PORT,
  selfUrlEnv: 'http://vacatorrent-resolver:8704',
  siteUrl: 'https://vaqueirofilmes.com',
  siteUrlEnv: 'VACATORRENT_URL',
  urlsCsv: process.env.VACATORRENT_URLS,
  fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
  extraProtectorSuffixes: ['systemtech.space'],
  assertOnlySuffixes: ASSERT_ONLY_SUFFIXES,
  concurrency: 3,
  decodeEntities,
});

const {
  reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
} = bootstrap;
const { ALLOWED_SUFFIXES, unwrapResolverUrl, mapLimit } = bootstrap;
const {
  assertAllowedUrl, isDetailHost, isProtectorHost, isAssertOnlyHost,
  isNetworkError, stripTags,
} = bootstrap;
const SELF_URL = bootstrap.selfUrl;

const nextProtectedUrl = createNextProtectedUrl({
  isProtectorHost,
  isAssertOnlyHost,
});

// --- Cache (núcleo resolvers/cache.js) ---
const inFlight = new Map();
const { values: postCache, cached: cachedPost } = createCache(100, { inFlight });
const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });
const { values: magnetCache, cached: cachedMagnet } = createCache(500, { inFlight });

siteSelector.onDomainChange(() => {
  postCache.clear();
  searchCache.clear();
  magnetCache.clear();
});

const searchPageHtml = createVacaSearchPageHtml({ selfUrl: SELF_URL });

// ---------------------------------------------------------------------------
// Coleta de fontes por obra (filme/série/batch).
// ---------------------------------------------------------------------------
async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

const NO_LINKS_SIGNAL = new Error('vacatorrent: sem link de download na página');

async function fetchMovieLinks(post) {
  const cacheKey = `movie:${post.url}`;
  try {
    return await cachedPost(cacheKey, POST_CACHE_MS, async () => {
      const pageHtml = await fetchText(post.url);
      const linksUrl = extractMovieLinks(pageHtml, post.url);
      if (!linksUrl) throw NO_LINKS_SIGNAL;
      const linksHtml = await fetchText(linksUrl);
      return parseDownloadLinks(linksHtml, linksUrl);
    });
  } catch (err) {
    if (err === NO_LINKS_SIGNAL) return [];
    throw err;
  }
}

async function fetchSeriesLinks(post, requestedSeason) {
  const seasonKey = requestedSeason ? String(requestedSeason[1]) : '';
  const cacheKey = `serie:${post.url}:${seasonKey}`;
  try {
    return await cachedPost(cacheKey, POST_CACHE_MS, async () => {
      const pageHtml = await fetchText(post.url);
      const internalUrl = seriesSeasonInternalUrl(pageHtml, post.url);
      if (!internalUrl) throw NO_LINKS_SIGNAL;
      const internalHtml = await fetchText(internalUrl);
      const cards = filterSeasonCards(parseSeasonInternal(internalHtml, internalUrl), requestedSeason);

      const out = [];
      for (const card of cards) {
        try {
          const cardHtml = await fetchText(card.url);
          if (card.isBatch) {
            const realTitle = extractBatchTitle(cardHtml);
            const links = parseDownloadLinks(cardHtml, card.url, {
              season: card.season,
              realTitle: realTitle || null,
            });
            out.push(...links);
          } else {
            const links = parseDownloadLinks(cardHtml, card.url, { season: card.season });
            out.push(...links);
          }
        } catch (err) {
          console.warn(`[vac] card ${card.url}: ${err.message}`);
        }
      }
      return out;
    });
  } catch (err) {
    if (err === NO_LINKS_SIGNAL) return [];
    throw err;
  }
}

async function postToItems(post, requestedSeason) {
  const links = post.type === 'Série'
    ? await fetchSeriesLinks(post, requestedSeason)
    : await fetchMovieLinks(post);
  return links.map((link, index) => ({ post, link, index, count: links.length }));
}

// ---------------------------------------------------------------------------
// Busca: AJAX JSON → obras → fontes.
// ---------------------------------------------------------------------------
async function searchPosts(query) {
  const cacheKey = `search:${String(query || '')}`;
  return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
    const requestedSeason = requestedSeasonFromQuery(query);
    const normalized = normalizeQuery(query);
    const browse = !normalized;
    const term = browse ? 'de' : normalized;

    const ajaxUrl = `${siteSelector.url()}/wp-admin/admin-ajax.php?action=search_posts&s=${encodeURIComponent(term)}&lang=pt-BR`;
    const text = await fetchText(ajaxUrl, 'application/json, text/html, */*');
    siteSelector.noteSuccess();

    const posts = filterSearchPosts(
      parseSearchJson(text, siteSelector.url()),
      browse ? '' : normalized,
      requestedSeason,
      MAX_POSTS,
    );
    const chunks = await mapLimit(posts, async (post) => {
      try {
        return await postToItems(post, requestedSeason);
      } catch (err) {
        console.warn(`[search] Falha ao obter links do post ${post.url}: ${err.message}`);
        return [];
      }
    });
    return chunks.flat();
  });
}

// ---------------------------------------------------------------------------
// Resolve: segue o protetor até o magnet.
// ---------------------------------------------------------------------------
const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
  decodeEntities, extractMagnet, nextProtectedUrl,
  extractMetaRefresh: (html) => extractMetaRefresh(html, decodeEntities),
  maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
  cookieJar: { seed: { 'vacadb.org': { enc_liberado: '1', enc_etapa1_visto: '1' } } },
});

async function collectLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
  const movie = { url: post.href, title: '', type: 'Filme', year: null, poster: null };
  let links = [];
  try { links = await fetchMovieLinks(movie); } catch {}
  if (!links.length) {
    const serie = { url: post.href, title: '', type: 'Série', year: null, poster: null };
    try { links = await fetchSeriesLinks(serie, null); } catch {}
  }
  return links;
}

async function resolveBest(postUrl) {
  const post = assertAllowedUrl(postUrl);
  return cachedMagnet(`best:${post.href}`, MAGNET_CACHE_MS, async () => {
    const links = await collectLinks(post.href);
    return tryLinksInOrder(
      [...links].sort((a, b) => scoreLink(b) - scoreLink(a)),
      (link) => fetchFollowingAllowed(link.url, post.href),
    );
  });
}

async function resolveButton(postUrl, index, hash, count) {
  const post = assertAllowedUrl(postUrl);
  const cacheKey = `magnet:${post.href}:${index}:${hash || ''}`;
  return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
    const links = await collectLinks(post.href);
    const link = pickButton(links, index, hash, count);
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  });
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------
const handleRequest = createResolverRouter({
  reply,
  routes: {
    '/health': createHealthRoute({ reply }),
    '/search': createSearchRoute({ reply, search: searchPosts, renderHtml: searchPageHtml }),
    '/resolve': createResolveRoute({ reply, unwrapResolverUrl, resolveBest, resolveButton }),
  },
});

function createServer() {
  return createHttpServer(handleRequest);
}

if (require.main === module) {
  bootstrap.serveMain(createServer);
}

module.exports = {
  createServer,
  siteSelector,
  parseSearchJson: (text, baseUrl) => parseSearchJson(text, baseUrl || siteSelector.url()),
  filterSearchPosts: (entries, query, season) => filterSearchPosts(entries, query, season, MAX_POSTS),
  parseDownloadLinks,
  extractMovieLinks,
  parseSeasonInternal,
  filterSeasonCards,
  extractBatchTitle,
  decodeDataU,
  seriesSeasonInternalUrl,
  searchPageHtml,
  releaseTitle,
  assertAllowedUrl,
  extractMagnet,
  nextProtectedUrl,
  extractMetaRefresh: (html) => extractMetaRefresh(html, decodeEntities),
  isDetailHost,
  isProtectorHost,
  isAssertOnlyHost,
  normalizeQuery,
  requestedSeasonFromQuery,
  normalizeSeasonValue,
  normalizeQuality,
  normalizeSource,
  classifyAudio,
  extractEpisode,
  cleanMarkTitle,
  searchPosts,
  fetchMovieLinks,
  fetchSeriesLinks,
  postToItems,
  fetchFollowingAllowed,
  resolveBest,
  resolveButton,
  buttonId,
  pickButton,
  unwrapResolverUrl,
  matchesResolverQuery,
  matchesSeasonSeason,
  createSiteSelector,
  isNetworkError,
  parseSize,
  decodeEntities,
  stripTags,
  escapeHtml,
  attribute,
  stripTrailingYears,
  computeWantedTokens,
  normalizeFilterText,
  isGenericListPost,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};