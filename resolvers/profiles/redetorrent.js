// Rede Torrent (www.redetorrent.xyz) — perfil do resolver local. Sexto BR:
// o site fica atrás de desafio Cloudflare (fetch direto 403), então o fetch
// reusa a mecânica FlareSolverr do bludv; os magnets, porém, são DIRETOS no
// HTML do post — não há protetor de link e NÃO há rota /resolve: o card
// Cardigann consome o magnet direto da página sintética (/search) ou do feed
// torznab (/api). Rotas mínimas: /health e /search; /api segue o padrão
// torznab dos irmãos e é o que os testes de card exercitam.

import { USER_AGENT } from '../runtime.js';
import { createCache } from '../cache.js';
import { createFlareFetcher, isCloudflareChallenge } from '../flare.js';
import { createServer as createHttpServer, reply } from '../http-server.js';
import {
  createResolverRouter, createHealthRoute, createSearchRoute, createApiRoute,
} from '../resolver-http.js';
import {
  normalizeFilterText, stripTrailingYears, computeWantedTokens,
  normalizeSeasonValue, isGenericListPost,
} from '../matching.js';
import { createProfile } from '../site-profile.js';
import { buildProfileConfig } from '../env-config.js';
import {
  FALLBACK_SITE_SUFFIXES, PROTECTOR_SUFFIXES,
  normalizeQuery, requestedSeasonFromQuery, classifyAudio,
  matchesSeasonSeason, matchesResolverQuery, normalizeQuality, normalizeSource,
  parseSearchHtml, extractMagnetHref, parsePostLinks,
  cleanPostTitle, releaseTitle, scoreLink, createRedeSearchPageHtml, rssXml,
  stripTags, decodeEntities, escapeXml,
} from './redetorrent-parsers.js';

const DEFAULTS = {
  port: 8705,
  selfUrl: 'http://redetorrent-resolver:8705',
  siteUrl: 'https://www.redetorrent.xyz',
  // Segundo host ativo do site (redetorrent.com): mirror histórico em
  // FALLBACK_SITE_SUFFIXES (candidato do seletor E allowlist explícita) e
  // default do csv quando REDETORRENT_URLS não é definido — a env definida
  // vence (o csv inteiro substitui este default).
  urlsCsv: 'https://redetorrent.com',
  timeoutMs: 15_000,
  maxPosts: 3,
  postCacheMs: 10 * 60_000,
  searchCacheMs: 5 * 60_000,
  flare: { solverUrl: 'http://127.0.0.1:8191', timeoutMs: 55_000, sessionTtlMs: 20 * 60_000 },
};
const META = {
  name: 'redetorrent', siteEnv: 'REDETORRENT_URL',
  urlsEnv: 'REDETORRENT_URLS', defaults: DEFAULTS,
};

/** Instância completa do perfil Rede Torrent; `overrides` vêm do ponto de entrada. */
function createResolver(overrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT, selfUrl: SELF_URL, siteUrl: SITE_URL, urlsCsv: URLS_CSV,
    timeoutMs: TIMEOUT_MS, maxPosts: MAX_POSTS, postCacheMs: POST_CACHE_MS,
    searchCacheMs: SEARCH_CACHE_MS, extraProtectors: EXTRA_PROTECTORS, flare: FLARE,
  } = config;

  const bootstrap = createProfile({
    name: 'redetorrent',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    // Os hosts de TODOS os candidatos já nascem na allowlist (CANDIDATE_HOSTS
    // do site-profile), então o mirror é detalhado válido sem restart.
    urlsCsv: URLS_CSV,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: [...PROTECTOR_SUFFIXES, ...EXTRA_PROTECTORS],
    networkErrorExtra: '|flare_',
    concurrency: 3,
    decodeEntities,
  });

  const { siteSelector, mapLimit, assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // --- FlareSolverr (Cloudflare) — mesma mecânica do bludv ---
  const flare = createFlareFetcher({
    solverUrl: FLARE.solverUrl,
    timeoutMs: FLARE.timeoutMs,
    sessionTtlMs: FLARE.sessionTtlMs,
    userAgent: USER_AGENT,
  });
  const { sessions: flareSessions, getFlareSession, buildFlareHeaders, fetchTextViaFlare } = flare;

  // --- Cache (núcleo resolvers/cache.js): busca e post. Não há cache de magnet
  // — não existe passo de resolução para cachear. ---
  const inFlight = new Map();
  const { values: postCache, cached: cachedPost } = createCache(200, { inFlight });
  const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });

  siteSelector.onDomainChange(() => {
    postCache.clear();
    searchCache.clear();
    flareSessions.clear();
  });

  // Seleção PRÓPRIA do perfil (o núcleo search-posts.js não conhece `type`):
  // com temporada pedida na query original (Sxx/SxxEyy), posts `type: 'Série'`
  // entram ANTES do corte MAX_POSTS — filmes que só compartilham o token
  // ("Cesium Fallout", "Missão: Impossível – Efeito Fallout") não podem expulsar
  // a série do corte de 3. O matching NÃO relaxa: mesma cadeia
  // matchesResolverQuery + matchesSeasonSeason; só a ORDEM muda, e somente
  // quando há temporada pedida (busca sem Sxx preserva a ordem do site).
  function selectSearchPosts(sourceHtml, query, requestedSeason) {
    // baseUrl REAL do seletor: href relativo do tema tem que sobreviver à
    // resolução (o HTML sintético e mudanças futuras do tema podem publicá-lo).
    let posts = parseSearchHtml(sourceHtml, siteSelector.url())
      .filter((post) => matchesResolverQuery(post, query));
    posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
    if (requestedSeason) {
      const series = posts.filter((post) => post.type === 'Série');
      const resto = posts.filter((post) => post.type !== 'Série');
      posts = [...series, ...resto];
    }
    return posts.slice(0, MAX_POSTS);
  }

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

  async function getPostLinks(postUrl) {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    return cachedPost(post.href, POST_CACHE_MS, async () => {
      const html = await fetchText(post.href);
      return { post, links: parsePostLinks(html, { url: post.href }) };
    });
  }

  async function postToItems(post, requestedSeason) {
    const { links } = await getPostLinks(post.url);
    return links
      .filter((link) => link.season == null
        || requestedSeason == null
        || link.season === Number(requestedSeason[1]))
      .map((link, index) => ({ post, link, index, count: links.length }));
  }

  async function searchPosts(query) {
    const requestedSeason = requestedSeasonFromQuery(query);
    const normalized = normalizeQuery(query);
    const cacheKey = `search:${String(query || '')}`;
    return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
      try {
        const html = await fetchText(assertAllowedUrl(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`));
        siteSelector.noteSuccess();
        const posts = selectSearchPosts(html, normalized, requestedSeason);
        const chunks = await mapLimit(posts, async (post) => {
          try {
            return await postToItems(post, requestedSeason);
          } catch (err) {
            console.warn(`[search] post sem magnets (${err.message})`);
            return [];
          }
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

  const searchPageHtml = createRedeSearchPageHtml();

  const handleRequest = createResolverRouter({
    reply,
    routes: {
      '/health': createHealthRoute({ reply }),
      '/api': createApiRoute({
        reply,
        capsXml: () => `<?xml version="1.0" encoding="UTF-8"?><caps><server version="1.0"/><searching><search available="yes"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>`,
        search: searchPosts,
        renderXml: (items, category) => rssXml(items, category),
        emptyXml: (category) => rssXml([], category),
      }),
      '/search': createSearchRoute({ reply, search: searchPosts, renderHtml: searchPageHtml }),
    },
  });

  function createServer() {
    return createHttpServer(handleRequest);
  }

  return {
    createServer, siteSelector, SELF_URL: SELF_URL_RESOLVED,
    createSiteSelector: bootstrap.createSiteSelector,
    parseSearchHtml, parsePostLinks, extractMagnetHref, selectSearchPosts,
    matchesResolverQuery, matchesSeasonSeason, normalizeQuery,
    requestedSeasonFromQuery, normalizeSeasonValue,
    normalizeQuality, normalizeSource, classifyAudio,
    cleanPostTitle, releaseTitle, createRedeSearchPageHtml, searchPageHtml, rssXml,
    assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError,
    searchPosts, scoreLink,
    stripTags, decodeEntities, escapeXml,
    normalizeFilterText, stripTrailingYears, computeWantedTokens, isGenericListPost,
    getFlareSession, buildFlareHeaders, fetchText, fetchTextViaFlare,
    postCache, searchCache, inFlight,
    serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
