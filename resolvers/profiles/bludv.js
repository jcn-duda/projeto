const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
const { createFlareFetcher, isCloudflareChallenge } = require('../flare');
const { createServer: createHttpServer } = require('../http-server');
const {
  createResolverRouter, createHealthRoute, createSearchRoute,
  createDlRoute, createApiRoute,
} = require('../resolver-http');
const {
  decodeEntities,
  parseSize,
  extractMetaRefresh,
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
const { tryLinksInOrder, magnetButtonCacheKey } = require('../release-format');
const { buildProfileConfig } = require('../env-config');
const {
  // Sem ALL_PROTECTOR_SUFFIXES daqui de propósito: a lista estática do
  // parsers lê a env EXTRA_PROTECTORS (que ninguém documenta nem define). A
  // que vale é a do bootstrap, com EXTRA_ALLOWED_PROTECTORS — ver linha 79.
  MAX_CARD_WINDOW, AUDIO_RANK, JS_URL_VAR_RE,
  brAudioHooks, audioFromSegment, audioFromAnchor,
  qualityRules, normalizeQuality, sourceRules, normalizeSource,
  episodeRules, extractEpisode, episodeStep,
  isValidBtihHash, isValidMagnetUri, extractMagnet,
  createNextProtectedUrl, nextProtectedUrl: defaultNextProtectedUrl,
  createParseDownloadLinks, sortLinks, pickBestLink, scoreLink,
  cleanPostTitle, releaseTitle, parsePostDate, pubDate,
  normalizeQuery, createParsePosts, createSearchPageHtml,
  capsXml, createBludvRssXml,
} = require('./bludv-parsers');

// Defaults ESTÁTICOS do perfil (sem env). O env do operador é lido por
// buildProfileConfig em tempo de chamada; o que é constante do site mora aqui.
const DEFAULTS = {
  port: 8700,
  selfUrl: 'http://bludv-resolver:8700',
  siteUrl: 'https://bludvfilmes.xyz',
  urlsCsv: undefined,
  timeoutMs: 15_000,
  maxHops: 6,
  maxPosts: 5,
  postCacheMs: 10 * 60_000,
  searchCacheMs: 5 * 60_000,
  magnetCacheMs: 30 * 60_000,
  maxResolveAttempts: 5,
  flare: { solverUrl: 'http://127.0.0.1:8191', timeoutMs: 55_000, sessionTtlMs: 20 * 60_000 },
};
const META = {
  name: 'bludv', siteEnv: 'BLUDV_URL', urlsEnv: 'BLUDV_URLS',
  maxPostsEnv: 'BLUDV_MAX_POSTS', defaults: DEFAULTS,
};

const FALLBACK_SITE_SUFFIXES = [
  'bludvfilmes.xyz',
  'bludvfilmes1.xyz',
  'bludv.net',
  'bludv.xyz',
  'bludv.to',
];

/** Instância completa do perfil BLUDV; `overrides` vêm do ponto de entrada. */
function createResolver(overrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT, selfUrl: SELF_URL, siteUrl: SITE_URL, urlsCsv: URLS_CSV,
    timeoutMs: TIMEOUT_MS, maxHops: MAX_HOPS, maxPosts: MAX_POSTS,
    postCacheMs: POST_CACHE_MS, searchCacheMs: SEARCH_CACHE_MS,
    magnetCacheMs: MAGNET_CACHE_MS, maxResolveAttempts: MAX_RESOLVE_ATTEMPTS,
    extraProtectors: EXTRA_PROTECTORS, flare: FLARE,
  } = config;

  const MAX_CACHE_SIZE = 200;
  const MAX_SEARCH_CACHE_SIZE = 100;
  const MAX_MAGNET_CACHE_SIZE = 500;

  const bootstrap = createProfile({
    name: 'bludv',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    urlsCsv: URLS_CSV,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: EXTRA_PROTECTORS,
    networkErrorExtra: '|flare_',
    concurrency: 4,
    unwrapOptions: {
      paths: ['/resolve', '/dl'],
      fields: { index: 'i', hash: 'h', count: 'n', audio: 'audio', quality: 'quality' },
    },
    decodeEntities,
  });

  const {
    reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
    ALL_PROTECTOR_SUFFIXES: DYNAMIC_PROTECTOR_SUFFIXES,
    ALLOWED_SUFFIXES, unwrapResolverUrl,
    assertAllowedUrl, isDetailHost, isProtectorHost,
    isNetworkError, stripTags,
  } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // --- FlareSolverr (Cloudflare) ---
  const flare = createFlareFetcher({
    solverUrl: FLARE.solverUrl,
    timeoutMs: FLARE.timeoutMs,
    sessionTtlMs: FLARE.sessionTtlMs,
    userAgent: USER_AGENT,
  });
  const { sessions: flareSessions, getFlareSession, buildFlareHeaders, fetchTextViaFlare } = flare;

  // --- Cache (núcleo resolvers/cache.js) ---
  const inFlight = new Map();
  const { values: postCache, cached: cachedPost } = createCache(MAX_CACHE_SIZE, { inFlight });
  const { values: searchCache, cached: cachedSearch } = createCache(MAX_SEARCH_CACHE_SIZE, { inFlight });
  const { values: magnetCache, cached: cachedMagnet } = createCache(MAX_MAGNET_CACHE_SIZE, { inFlight });

  siteSelector.onDomainChange(() => {
    postCache.clear();
    searchCache.clear();
    magnetCache.clear();
    flareSessions.clear();
  });

  const nextProtectedUrl = createNextProtectedUrl({
    isProtectorHost,
    protectorSuffixes: DYNAMIC_PROTECTOR_SUFFIXES,
  });

  async function fetchText(url, referer) {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: buildFlareHeaders(url, referer),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) {
      const body = await res.text();
      if (isCloudflareChallenge(res, body)) {
        return fetchTextViaFlare(url, referer);
      }
      throw new Error(`http_403`);
    }
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.text();
  }

  const parseDownloadLinks = createParseDownloadLinks({
    isProtectorHost,
    stripTags,
    decodeEntities,
  });

  const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
    decodeEntities, extractMagnet, nextProtectedUrl, extractMetaRefresh,
    maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
  });

  async function getPostLinks(postUrl) {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    return cachedPost(post.href, POST_CACHE_MS, async () => {
      const html = await fetchText(post);
      return { post, links: parseDownloadLinks(html) };
    });
  }

  async function resolvePost(postUrl, prefs = {}) {
    const cacheKey = `magnet:best:${postUrl}:${prefs.audio || ''}:${prefs.quality || ''}`;
    const hit = magnetCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) console.log(`[cache] hit magnet(best) ${postUrl}`);

    return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
      const { post, links } = await getPostLinks(postUrl);
      const sorted = sortLinks(links, prefs).slice(0, MAX_RESOLVE_ATTEMPTS);
      if (!sorted.length) throw new Error('no_protector');
      console.log(
        `[resolve] ${links.length} botão(ões), tentando ${sorted.length} em ordem de preferência ${post.pathname}`,
      );
      return tryLinksInOrder(sorted, (link) => fetchFollowingAllowed(link.url, post.href), {
        onError: (link, error) =>
          console.warn(`[resolve] botão ${link.quality || '?'}p falhou (${error.message}); tentando o próximo`),
      });
    });
  }

  async function resolveButton(postUrl, index, hash, count) {
    const cacheKey = magnetButtonCacheKey(postUrl, index, hash);
    const hit = magnetCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) console.log(`[cache] hit magnet botão ${index} ${postUrl}`);

    return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
      const { post, links } = await getPostLinks(postUrl);
      const link = pickButton(links, index, hash, count);
      if (!link) throw new Error('no_such_button');
      console.log(`[dl] botão ${index} → ${link.quality || '?'}p ${link.audio} ${link.size || ''} ${post.pathname}`);
      return fetchFollowingAllowed(link.url, post.href);
    });
  }

  const parsePosts = createParsePosts({
    siteSelector,
    stripTags,
    decodeEntities,
    isGenericListPost,
  });

  const mapLimit = (items, fn) => bootstrap.mapLimit(items, fn, {
    onError: (err) => console.warn(`[search] post sem botões (${err.message})`),
  });

  const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

  async function searchPosts(query) {
    const requestedSeason = String(query || '').match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
    const normalized = normalizeQuery(query);
    const cacheKey = `search:${String(query || '')}`;
    const hit = searchCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) console.log(`[cache] hit search "${normalized}"`);

    return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
      try {
        const html = await fetchText(assertAllowedUrl(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`));
        siteSelector.noteSuccess();
        const posts = selectSearchPosts(html, normalized, requestedSeason);
        const chunks = await mapLimit(posts, async (post) => {
          const { links } = await getPostLinks(post.url);
          return links.map((link, index) => ({ post, link, index, count: links.length }));
        });
        const items = chunks.flat();
        console.log(`[search] "${normalized}" → ${posts.length} post(s), ${items.length} release(s)`);
        return items;
      } catch (err) {
        if (isNetworkError(err)) await siteSelector.noteFailure();
        throw err;
      }
    });
  }

  const searchPageHtml = createSearchPageHtml({
    selfUrl: () => SELF_URL_RESOLVED,
    titleOf: releaseTitle,
  });

  const rssXml = createBludvRssXml({ selfUrl: SELF_URL_RESOLVED });

  async function handleResolve(url, response) {
    let postUrl = url.searchParams.get('url');
    if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');
    const unwrapped = unwrapResolverUrl(postUrl, {
      audio: url.searchParams.get('audio'),
      quality: url.searchParams.get('quality'),
      index: url.searchParams.get('i'),
      hash: url.searchParams.get('h'),
      count: url.searchParams.get('n'),
    });
    postUrl = unwrapped.url;
    const { index, hash, count, audio, quality } = unwrapped;

    if (audio && !['dublado', 'legendado', 'desconhecido'].includes(audio)) {
      return reply(response, 400, 'invalid_audio');
    }
    if (quality && !/^\d{3,4}p?$/.test(quality)) return reply(response, 400, 'invalid_quality');
    const hasIndex = index !== null && index !== undefined && index !== '';
    const wantedIndex = hasIndex ? Number(index) : -1;
    if (hasIndex && (!Number.isInteger(wantedIndex) || wantedIndex < 0)) {
      return reply(response, 400, 'invalid_index');
    }

    try {
      const magnet = hasIndex
        ? await resolveButton(postUrl, wantedIndex, hash, count)
        : await resolvePost(postUrl, { audio, quality: quality ? parseInt(quality, 10) : null });
      return reply(response, 200, magnet);
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }

  const handleRequest = createResolverRouter({
    reply,
    routes: {
      '/health': createHealthRoute({ reply }),
      '/api': createApiRoute({
        reply, capsXml,
        search: searchPosts,
        renderXml: (items, category) => rssXml(items, category),
        emptyXml: () => rssXml([], 2000),
      }),
      '/dl': createDlRoute({ reply, resolveButton }),
      '/search': createSearchRoute({ reply, search: searchPosts, renderHtml: searchPageHtml }),
      '/resolve': handleResolve,
    },
  });

  function createServer() {
    return createHttpServer(handleRequest);
  }

  return {
    createServer, siteSelector, parseDownloadLinks, pickBestLink, sortLinks,
    parsePosts, parseSize, releaseTitle, cleanPostTitle, normalizeQuery,
    buttonId, pickButton, unwrapResolverUrl, isGenericListPost,
    normalizeFilterText, stripTrailingYears, computeWantedTokens,
    matchesResolverQuery, normalizeSeasonValue, matchesSeasonSeason,
    selectSearchPosts, searchPageHtml, assertAllowedUrl, extractMagnet,
    extractMetaRefresh, extractEpisode, nextProtectedUrl, decodeEntities,
    normalizeQuality, normalizeSource, isDetailHost, isProtectorHost,
    getPostLinks, resolvePost, resolveButton, searchPosts,
    fetchFollowingAllowed, createSiteSelector, isNetworkError,
    getFlareSession, buildFlareHeaders, fetchText, fetchTextViaFlare,
    postCache, searchCache, magnetCache, inFlight,
    // Exportações adicionais de compatibilidade
    scoreLink, pubDate, parsePostDate, episodeRules, episodeStep,
    qualityRules, sourceRules, brAudioHooks, isValidBtihHash, isValidMagnetUri,
    serveMain: bootstrap.serveMain,
    defaultNextProtectedUrl, MAX_CARD_WINDOW, AUDIO_RANK, JS_URL_VAR_RE,
  };
}

module.exports = { createResolver, DEFAULTS, META };
