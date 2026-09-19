// HDR Torrents (hdrtorrents.net) — perfil do resolver local. Oitavo BR.
//
// O site tem a busca quebrada: qualquer endpoint (?s=, /pesquisa/, /index.php?busca=)
// devolve a homepage sem filtrar. Os magnets são DIRETOS no HTML do post
// (sem protetor de link), então NÃO há rota /resolve: o magnet é o próprio
// href da linha sintética, como no apachetorrent/redetorrent.
//
// Fluxo da busca: o resolver raspa as páginas de listagem (homepage +
// paginação /pagina/N/) para montar um catálogo em cache, casa a query contra
// esse catálogo, busca as páginas de conteúdo dos itens que casaram e extrai
// os magnets diretos. A listagem fica em cache por 30 min; a primeira busca
// fria custa o scraping (~5-15s), as seguintes são instantes.

import { USER_AGENT } from '../runtime.js';
import { createCache } from '../cache.js';
import { createServer as createHttpServer, reply } from '../http-server.js';
import {
  createResolverRouter, createHealthRoute, createSearchRoute, createApiRoute,
} from '../resolver-http.js';
import { matchesResolverQuery, matchesSeasonSeason } from '../matching.js';
import { createProfile } from '../site-profile.js';
import { buildProfileConfig } from '../env-config.js';
import type { ProfileOverrides } from '../env-config.js';
import {
  FALLBACK_SITE_SUFFIXES, normalizeQuery, requestedSeasonFromQuery,
  classifyAudio, parseListingHtml, parseContentMagnets,
  createHDRSearchPageHtml, hdrRssXml,
  stripTags, decodeEntities, escapeXml,
} from './hdrtorrents-parsers.js';
import type { HDRWork, HDRLink, HDRPageItem } from './hdrtorrents-parsers.js';

const DEFAULTS = {
  port: 8707,
  selfUrl: 'http://hdrtorrents-resolver:8707',
  siteUrl: 'https://hdrtorrents.net',
  timeoutMs: 15_000,
  // Teto de posts com match por busca: cada post vira um fetch de conteúdo
  // (mapLimit 3), e a fonte é index-only — o custo fica no colhedor, fora do
  // prazo da resposta.
  maxPosts: 5,
  // Teto de páginas de listagem raspadas por ciclo de cache. 20 páginas × 20
  // cards = 400 itens, suficiente para cobrir o catálogo corrente.
  maxListingPages: 20,
  postCacheMs: 10 * 60_000,
  searchCacheMs: 5 * 60_000,
  listingCacheMs: 30 * 60_000,
};
const META = {
  name: 'hdrtorrents', siteEnv: 'HDRTORRENTS_URL', defaults: DEFAULTS,
};

type HDRItem = { post: HDRWork; link: HDRLink; index: number; count: number };

/** Instância completa do perfil HDR Torrents; `overrides` vêm do ponto de entrada. */
function createResolver(overrides: ProfileOverrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT = DEFAULTS.port, selfUrl: SELF_URL = DEFAULTS.selfUrl,
    siteUrl: SITE_URL = DEFAULTS.siteUrl,
    timeoutMs: TIMEOUT_MS = DEFAULTS.timeoutMs,
    maxPosts: MAX_POSTS = DEFAULTS.maxPosts,
    postCacheMs: POST_CACHE_MS = DEFAULTS.postCacheMs,
    searchCacheMs: SEARCH_CACHE_MS = DEFAULTS.searchCacheMs,
    extraProtectors: EXTRA_PROTECTORS = [],
  } = config;
  // Knobs próprios do perfil (não fazem parte do ResolverConfig padrão):
  // usam o default estático, sem env override.
  const MAX_LISTING_PAGES = DEFAULTS.maxListingPages;
  const LISTING_CACHE_MS = DEFAULTS.listingCacheMs;

  const bootstrap = createProfile({
    name: 'hdrtorrents',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: [...EXTRA_PROTECTORS],
    concurrency: 3,
    decodeEntities,
  });

  const { siteSelector, mapLimit, assertAllowedUrl, isDetailHost, isNetworkError } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // Cache (núcleo resolvers/cache.js): listagem, busca e post.
  const inFlight = new Map<string, Promise<unknown>>();
  const { values: listingCache, cached: cachedListing } = createCache(10, { inFlight });
  const { values: postCache, cached: cachedPost } = createCache(200, { inFlight });
  const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });

  siteSelector.onDomainChange(() => {
    listingCache.clear();
    postCache.clear();
    searchCache.clear();
  });

  // ---------------------------------------------------------------------------
  // Listagem: raspa homepage + paginação, cache por 30 min.
  // ---------------------------------------------------------------------------
  async function fetchText(url: string): Promise<string> {
    const res = await fetch(assertAllowedUrl(url), {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.text();
  }

  async function fetchListingPage(pageNum: number): Promise<HDRWork[]> {
    const url = pageNum <= 1
      ? `${siteSelector.url()}/`
      : `${siteSelector.url()}/pagina/${pageNum}/`;
    const html = await fetchText(url);
    return parseListingHtml(html, siteSelector.url());
  }

  async function fetchAllListings(): Promise<HDRWork[]> {
    return cachedListing('all', LISTING_CACHE_MS, async () => {
      const all: HDRWork[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
        const items = await fetchListingPage(page);
        for (const item of items) {
          if (!seen.has(item.url)) {
            seen.add(item.url);
            all.push(item);
          }
        }
        // Página com menos de 10 cards (metade do normal) é fim do catálogo.
        if (items.length < 10) break;
      }
      return all;
    });
  }

  // ---------------------------------------------------------------------------
  // Busca: catálogo → match → conteúdo → magnets.
  // ---------------------------------------------------------------------------
  async function getContentMagnets(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    return cachedPost(post.href, POST_CACHE_MS, async () => {
      const html = await fetchText(post.href);
      return parseContentMagnets(html, post.href);
    });
  }

  async function postToItems(post: HDRWork): Promise<HDRItem[]> {
    const links = await getContentMagnets(post.url);
    return links.map((link, index) => ({ post, link, index, count: links.length }));
  }

  async function searchPosts(query: string) {
    const requestedSeason = requestedSeasonFromQuery(query);
    const normalized = normalizeQuery(query);
    const cacheKey = `search:${String(query || '')}`;
    return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
      try {
        const allItems = await fetchAllListings();
        siteSelector.noteSuccess();
        // Match contra o catálogo: tokens da query presentes no título (60%
        // de cobertura, mesmo threshold dos outros BR).
        let posts = allItems.filter((item) => matchesResolverQuery(item, normalized));
        if (requestedSeason) {
          posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
        }
        posts = posts.slice(0, MAX_POSTS);
        const chunks = await mapLimit(posts, async (post) => {
          try {
            return await postToItems(post);
          } catch (err) {
            console.warn(`[br] hdrtorrents: post sem magnets (${err.message})`);
            return [];
          }
        });
        const items = chunks.flat();
        console.log(`[br] hdrtorrents: "${normalized}" → ${posts.length} post(s), ${items.length} release(s)`);
        return items;
      } catch (err) {
        if (isNetworkError(err)) await siteSelector.noteFailure();
        throw err;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Resolve: magnet direto, sem protetor. O /resolve existe para o painel e
  // para compatibilidade, mas o Cardigann lê o magnet direto da página
  // sintética (sem download.before).
  // ---------------------------------------------------------------------------
  async function resolveBest(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    const links = await getContentMagnets(post.href);
    if (!links.length) throw new Error('no_magnets');
    return links[0].url;
  }

  async function resolveButton(postUrl: string, index: number) {
    const post = assertAllowedUrl(postUrl);
    const links = await getContentMagnets(post.href);
    if (index >= links.length) throw new Error('no_such_button');
    return links[index].url;
  }

  // ---------------------------------------------------------------------------
  // HTTP.
  // ---------------------------------------------------------------------------
  const searchPageHtml = createHDRSearchPageHtml();
  const renderHtml = (items: HDRItem[]) => searchPageHtml(items as HDRPageItem[]);

  const handleRequest = createResolverRouter({
    reply,
    routes: {
      '/health': createHealthRoute({ reply }),
      '/api': createApiRoute({
        reply,
        capsXml: () => `<?xml version="1.0" encoding="UTF-8"?><caps><server version="1.0"/><searching><search available="yes"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>`,
        search: searchPosts,
        renderXml: (items, category) => hdrRssXml(items as HDRPageItem[], category),
        emptyXml: (category) => hdrRssXml([], category),
      }),
      '/search': createSearchRoute({ reply, search: searchPosts, renderHtml }),
    },
  });

  function createServer() {
    return createHttpServer(handleRequest);
  }

  return {
    createServer, siteSelector, SELF_URL: SELF_URL_RESOLVED,
    createSiteSelector: bootstrap.createSiteSelector,
    parseListingHtml, parseContentMagnets,
    matchesResolverQuery, matchesSeasonSeason, normalizeQuery,
    requestedSeasonFromQuery, classifyAudio,
    stripTags, decodeEntities, escapeXml,
    assertAllowedUrl, isDetailHost, isNetworkError,
    searchPosts, fetchText, fetchAllListings, getContentMagnets,
    postCache, searchCache, listingCache, inFlight,
    serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
