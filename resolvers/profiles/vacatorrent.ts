// Vaca Torrent (vaqueirofilmes.com) — perfil do resolver local. O site fica
// atrás de desafio Cloudflare (fetch direto 403), então o fetch reusa Flare.
import { USER_AGENT } from '../runtime.js';
import { createCache } from '../cache.js';
import { createFlareFetcher } from '../flare.js';
import { createServer as createHttpServer } from '../http-server.js';
import {
  decodeEntities,
  escapeHtml,
  parseSize,
  attribute,
} from '../text.js';
import {
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  isGenericListPost,
  buttonId,
  pickButton,
} from '../matching.js';
import { createProfile } from '../site-profile.js';
import { buildProfileConfig } from '../env-config.js';
import type { ProfileOverrides } from '../env-config.js';
import {
  createResolverRouter, createHealthRoute, createSearchRoute, createResolveRoute,
} from '../resolver-http.js';
import { tryLinksInOrder } from '../release-format.js';
import type { ResolverLink } from '../types.js';
import {
  FALLBACK_SITE_SUFFIXES,
  ASSERT_ONLY_SUFFIXES,
  extractMetaRefresh,
  normalizeQuery,
  requestedSeasonFromQuery,
  normalizeQuality,
  normalizeSource,
  classifyAudio,
  extractEpisode,
  extractMagnet,
  // Sem o `nextProtectedUrl` pronto do parsers as ele nasce com os
  // classificadores DEFAULT do módulo, e o que vale aqui são os do bootstrap
  // (isProtectorHost/isAssertOnlyHost do perfil) — ver a construção abaixo.
  createNextProtectedUrl,
  parseSearchJson,
  unwrapSearchJson,
  filterSearchPosts,
  createParseDownloadLinks,
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
} from './vacatorrent-parsers.js';
import type { VacaWork } from './vacatorrent-parsers.js';
import { createVacaContent } from './vacatorrent-content.js';
import type { VacaSearchItem } from './vacatorrent-content.js';

class IncompleteSearch extends Error {
  constructor(readonly items: VacaSearchItem[]) {
    super('vacatorrent: falha ao obter todos os posts');
  }
}

// Evidência de desafio, não só o nome Cloudflare/um título de filme no corpo.
function isVacaChallenge(body: string, headers?: Headers): boolean {
  if (headers?.get('cf-mitigated') === 'challenge') return true;
  if (/^[\[{]/.test(body.trim())) return false;
  return /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/cdn-cgi\/challenge-platform\/(?![^"']*\/jsd\/)/i.test(body)
    || /\b_cf_chl_opt\s*=/.test(body)
    || (/Just a moment|Checking your browser/i.test(body) && /challenges\.cloudflare\.com/i.test(body));
}

const DEFAULTS = {
  port: 8704,
  selfUrl: 'http://vacatorrent-resolver:8704',
  siteUrl: 'https://vaqueirofilmes.com',
  urlsCsv: undefined,
  timeoutMs: 15_000,
  maxHops: 10,
  maxPosts: 3,
  postCacheMs: 10 * 60_000,
  searchCacheMs: 5 * 60_000,
  magnetCacheMs: 30 * 60_000,
  flare: { solverUrl: 'http://127.0.0.1:8191', timeoutMs: 55_000, sessionTtlMs: 20 * 60_000 },
};
const META = {
  name: 'vacatorrent', siteEnv: 'VACATORRENT_URL',
  urlsEnv: 'VACATORRENT_URLS', defaults: DEFAULTS,
};

const VACA_EXTRA_PROTECTORS = ['systemtech.space'];

/** Instância completa do perfil Vaca Torrent; `overrides` vêm do ponto de entrada. */
function createResolver(overrides: ProfileOverrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT = DEFAULTS.port, selfUrl: SELF_URL = DEFAULTS.selfUrl,
    siteUrl: SITE_URL = DEFAULTS.siteUrl, urlsCsv: URLS_CSV,
    timeoutMs: TIMEOUT_MS = DEFAULTS.timeoutMs, maxHops: MAX_HOPS = DEFAULTS.maxHops,
    maxPosts: MAX_POSTS = DEFAULTS.maxPosts,
    postCacheMs: POST_CACHE_MS = DEFAULTS.postCacheMs,
    searchCacheMs: SEARCH_CACHE_MS = DEFAULTS.searchCacheMs,
    magnetCacheMs: MAGNET_CACHE_MS = DEFAULTS.magnetCacheMs,
    extraProtectors: EXTRA_PROTECTORS, flare: FLARE = DEFAULTS.flare,
  } = config;

  // --- Bootstrap comum (site-profile) ---
  const bootstrap = createProfile({
    name: 'vacatorrent',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    urlsCsv: URLS_CSV,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: [...VACA_EXTRA_PROTECTORS, ...EXTRA_PROTECTORS],
    assertOnlySuffixes: ASSERT_ONLY_SUFFIXES,
    networkErrorExtra: '|flare_',
    concurrency: 3,
    decodeEntities,
  });

  const {
    reply, siteSelector, createSiteSelector,
  } = bootstrap;
  const { unwrapResolverUrl, mapLimit } = bootstrap;
  const {
    assertAllowedUrl, isDetailHost, isProtectorHost, isAssertOnlyHost,
    isNetworkError, stripTags,
  } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // --- FlareSolverr (Cloudflare) — mesma mecânica do bludv/redetorrent ---
  const flare = createFlareFetcher({
    solverUrl: FLARE.solverUrl,
    timeoutMs: FLARE.timeoutMs,
    sessionTtlMs: FLARE.sessionTtlMs,
    userAgent: USER_AGENT,
  });
  const { sessions: flareSessions, getFlareSession, buildFlareHeaders, fetchTextViaFlare } = flare;

  const nextProtectedUrl = createNextProtectedUrl({
    isProtectorHost,
    isAssertOnlyHost,
  });

  // parseDownloadLinks do perfil: injeta o isProtectorHost do bootstrap (base +
  // systemtech + EXTRA_ALLOWED_PROTECTORS), e não a lista estática do parsers.
  const parseDownloadLinks = createParseDownloadLinks({ isProtectorHost });

  // --- Cache (núcleo resolvers/cache.js) ---
  const inFlight = new Map<string, Promise<unknown>>();
  const { values: postCache, cached: cachedPost } = createCache(100, { inFlight });
  const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });
  const { values: magnetCache, cached: cachedMagnet } = createCache(500, { inFlight });

  siteSelector.onDomainChange(() => {
    postCache.clear();
    searchCache.clear();
    magnetCache.clear();
    flareSessions.clear();
  });

  const searchPageHtml = createVacaSearchPageHtml({ selfUrl: SELF_URL_RESOLVED });

  // ---------------------------------------------------------------------------
  // Coleta de fontes por obra (filme/série/batch).
  // ---------------------------------------------------------------------------
  // Accept customizável: a busca AJAX pede application/json (ver searchPosts).
  async function fetchText(url: string, accept = 'text/html,application/xhtml+xml'): Promise<string> {
    const headers = { ...buildFlareHeaders(url), Accept: accept };
    const res = await fetch(url, {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body = await res.text();
    if ((res.ok || res.status === 403 || res.status === 503) && isVacaChallenge(body, res.headers)) {
      body = await fetchTextViaFlare(url);
      if (isVacaChallenge(body)) {
        // O núcleo memoriza a sessão antes de devolver o HTML. Não reutilizar
        // cookies de uma solução que ainda é o desafio, nem tentar em laço.
        flareSessions.clear();
        throw new Error('vacatorrent: desafio Cloudflare não resolvido');
      }
    } else if (!res.ok) throw new Error(`http_${res.status}`);
    if (/<body\b[^>]*\bid\s*=\s*["']error-page["']|<(?:div|p)\b[^>]*\bclass\s*=\s*["'][^"']*\bwp-die-message\b/i.test(body)) {
      throw new Error('vacatorrent: página de erro do WordPress');
    }
    return accept.includes('application/json') ? unwrapSearchJson(body) : body;
  }

  const { fetchMovieLinks, fetchSeriesLinks, postToItems } = createVacaContent({
    cachedPost, postCacheMs: POST_CACHE_MS, fetchText, parseDownloadLinks,
  });

  // ---------------------------------------------------------------------------
  // Busca: AJAX JSON → obras → fontes.
  // ---------------------------------------------------------------------------
  async function searchPosts(query: string) {
    const cacheKey = `search:${String(query || '')}`;
    return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
      const requestedSeason = requestedSeasonFromQuery(query);
      const normalized = normalizeQuery(query);
      const browse = !normalized;
      const term = browse ? 'de' : normalized;

      const ajaxUrl = `${siteSelector.url()}/wp-admin/admin-ajax.php?action=search_posts&s=${encodeURIComponent(term)}&lang=pt-BR`;
      const text = await fetchText(ajaxUrl, 'application/json, text/html, */*');
      const entries = parseSearchJson(text, siteSelector.url());
      siteSelector.noteSuccess();

      const posts = filterSearchPosts(
        entries,
        browse ? '' : normalized,
        requestedSeason,
        MAX_POSTS,
      );
      let incomplete = false;
      const chunks = await mapLimit(posts, async (post) => {
        try {
          return await postToItems(post, requestedSeason, () => { incomplete = true; });
        } catch (err) {
          incomplete = true;
          console.warn(`[search] Falha ao obter links do post ${post.url}: ${err.message}`);
          return [];
        }
      });
      const items = chunks.flat();
      // O cache grava qualquer retorno; só a rejeição impede congelar parcial.
      if (incomplete) throw new IncompleteSearch(items);
      return items;
    }).catch((err) => {
      if (err instanceof IncompleteSearch && err.items.length) return err.items;
      throw err;
    });
  }

  // ---------------------------------------------------------------------------
  // Resolve: segue o protetor até o magnet.
  // ---------------------------------------------------------------------------
  const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
    decodeEntities, extractMagnet, nextProtectedUrl,
    extractMetaRefresh,
    maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
    cookieJar: { seed: { 'vacadb.org': { enc_liberado: '1', enc_etapa1_visto: '1' } } },
  });

  async function collectLinks(postUrl: string): Promise<ResolverLink[]> {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    const movie: VacaWork = { url: post.href, title: '', type: 'Filme', year: null, poster: null };
    let links: ResolverLink[] = [];
    try { links = await fetchMovieLinks(movie); } catch {}
    if (!links.length) {
      const serie: VacaWork = { url: post.href, title: '', type: 'Série', year: null, poster: null };
      try { links = await fetchSeriesLinks(serie, null); } catch {}
    }
    return links;
  }

  async function resolveBest(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    return cachedMagnet(`best:${post.href}`, MAGNET_CACHE_MS, async () => {
      const links = await collectLinks(post.href);
      return tryLinksInOrder(
        [...links].sort((a, b) => scoreLink(b) - scoreLink(a)),
        (link) => fetchFollowingAllowed(link.url, post.href),
      );
    });
  }

  async function resolveButton(postUrl: string, index: number, hash: string | null = null, count: string | null = null) {
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

  return {
    createServer,
    siteSelector,
    parseSearchJson: (text: string | null | undefined, baseUrl?: string) => parseSearchJson(text, baseUrl || siteSelector.url()),
    filterSearchPosts: (entries: VacaWork[], query: string, season: RegExpMatchArray | readonly string[] | string | number | null | undefined) => filterSearchPosts(entries, query, season, MAX_POSTS),
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
    extractMetaRefresh,
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
    getFlareSession, buildFlareHeaders, fetchText, fetchTextViaFlare,
    postCache,
    searchCache,
    magnetCache,
    inFlight,
    serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
