// Apache Torrent (apachetorrents.com) — perfil do resolver local. Sétimo BR.
//
// O indexer stock C# do Jackett (id `apachetorrent`) ficou desalinhado do site:
// o Apache endureceu a busca com sessão + token por sessão + honeypot, e o
// parser C# ainda usa `?s=` e seletores velhos — devolve 0 releases. O motor
// Cardigann do Jackett NÃO consegue raspar um token por sessão e injetá-lo em
// cada busca (a wiki só expõe `.Query.*`/`.Keywords`/`.Config.*`), então a
// correção segue o padrão do repo: resolver local embutido (porta 8706) +
// definição Cardigann ponte `apachetorrent-cardigann`.
//
// Fluxo da busca (medido no site): GET / estabelece o cookie PHPSESSID e
// publica `input[name="token"]`; a busca que funciona é
// `GET /index.php?busca=<q>&token=<token>&hp_bot_check=` com o MESMO cookie —
// sem token, sem cookie ou token de outra sessão o site devolve 302 para a
// home. O token é reutilizável dentro da sessão, então 1 fetch de home por
// sessão e refresh só quando uma busca redireciona. Os magnets são DIRETOS no
// HTML do post (sem protetor de link), então NÃO há rota /resolve: o magnet é
// o próprio href da linha sintética, como no redetorrent.

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
  classifyAudio, extractSearchToken, parseSearchHtml, parsePostMagnets,
  isValidMagnetUri, qualityFromText,
  cleanPostTitle, releaseTitle, createApacheSearchPageHtml, apacheRssXml,
  stripTags, decodeEntities, escapeXml,
} from './apachetorrent-parsers.js';
import type { ApacheWork, ApacheLink } from './apachetorrent-parsers.js';

const DEFAULTS = {
  port: 8706,
  selfUrl: 'http://apachetorrent-resolver:8706',
  siteUrl: 'https://apachetorrents.com',
  timeoutMs: 15_000,
  // Teto de cards por busca: cada card vira um fetch de post (mapLimit 3), e a
  // fonte é index-only — o custo fica no colhedor, fora do prazo da resposta.
  maxPosts: 12,
  postCacheMs: 10 * 60_000,
  searchCacheMs: 5 * 60_000,
};
const META = {
  name: 'apachetorrent', siteEnv: 'APACHETORRENT_URL', defaults: DEFAULTS,
};

/** Sessão do buscador: cookie + token nascem juntos no GET da home. */
type ApacheSession = { cookie: string; token: string };

/** Item montado pelo perfil e consumido pelas duas renderizações. */
type ApacheItem = { post: ApacheWork; link: ApacheLink; index: number; count: number };

// Set-Cookie do fetch: o undici junta múltiplos cookies com vírgula, então a
// extração preferencial é o PHPSESSID por regex (o `Expires` dos outros
// cookies carrega vírgula e quebraria um split ingênuo). Sem PHPSESSID, cai
// para os pares name=value como fallback defensivo.
function extractSessionCookie(response: Response): string {
  const raw = String(response.headers.get('set-cookie') || '');
  const session = raw.match(/PHPSESSID=([^;\s,]+)/i);
  if (session) return `PHPSESSID=${session[1]}`;
  const pairs = raw.split(/,(?=[^;=]+=)|\n/)
    .map((chunk) => chunk.split(';')[0].trim())
    .filter((pair) => /^[^=;]+=/.test(pair));
  return pairs.join('; ');
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Instância completa do perfil Apache Torrent; `overrides` vêm do ponto de entrada. */
function createResolver(overrides: ProfileOverrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT = DEFAULTS.port, selfUrl: SELF_URL = DEFAULTS.selfUrl,
    siteUrl: SITE_URL = DEFAULTS.siteUrl,
    timeoutMs: TIMEOUT_MS = DEFAULTS.timeoutMs, maxPosts: MAX_POSTS = DEFAULTS.maxPosts,
    postCacheMs: POST_CACHE_MS = DEFAULTS.postCacheMs,
    searchCacheMs: SEARCH_CACHE_MS = DEFAULTS.searchCacheMs,
    extraProtectors: EXTRA_PROTECTORS = [],
  } = config;

  const bootstrap = createProfile({
    name: 'apachetorrent',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    // Os DOIS domínios já nascem candidatos (CANDIDATE_HOSTS do site-profile),
    // então o 301 do apex para o plural é seguido sem restart.
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: [...EXTRA_PROTECTORS],
    // Sessão expirada NÃO é falha de domínio: sem excluir `session_`, o
    // isNetworkError trataria o 302-para-home como queda do host e sondaria o
    // seletor à toa a cada busca.
    networkErrorExtra: '|session_',
    concurrency: 3,
    decodeEntities,
  });

  const { siteSelector, mapLimit, assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // Sessão por INSTÂNCIA (closure), nunca estado de módulo: o harness de
  // isolamento cria instâncias com config própria no mesmo processo.
  let session: ApacheSession | null = null;

  // Cache (núcleo resolvers/cache.js): busca e post. Não há cache de magnet —
  // não existe passo de resolução para cachear.
  const inFlight = new Map<string, Promise<unknown>>();
  const { values: postCache, cached: cachedPost } = createCache(200, { inFlight });
  const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });

  siteSelector.onDomainChange(() => {
    postCache.clear();
    searchCache.clear();
    // O cookie/token vale no host em que nasceu: trocar de domínio invalida os
    // dois (mesma razão do cf_clearance por host do bludv).
    session = null;
  });

  async function fetchHome(): Promise<{ html: string; cookie: string }> {
    const res = await fetch(assertAllowedUrl(`${siteSelector.url()}/`), {
      // O apex responde 301 para o plural: aqui o follow é desejado (é a
      // canonicalização do domínio, não a sessão).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return { html: await res.text(), cookie: extractSessionCookie(res) };
  }

  async function ensureSession(force = false): Promise<ApacheSession> {
    if (session && !force) return session;
    const { html, cookie } = await fetchHome();
    const token = extractSearchToken(html);
    if (!token || !cookie) throw new Error('session_failed');
    session = { cookie, token };
    return session;
  }

  function searchUrl(current: ApacheSession, query: string): string {
    // hp_bot_check vai VAZIO de propósito: é honeypot (bot preenche) e o site
    // devolve 302 quando ele vem com valor.
    return `${siteSelector.url()}/index.php?busca=${encodeURIComponent(query)}&token=${encodeURIComponent(current.token)}&hp_bot_check=`;
  }

  function requestUrl(current: ApacheSession, url: string): Promise<Response> {
    // redirect manual: o 302 para a home É a prova de sessão morta e precisa
    // ser distinguido da canonicalização de domínio.
    return fetch(assertAllowedUrl(url), {
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        Cookie: current.cookie,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function fetchSearchHtml(query: string): Promise<string> {
    let current = await ensureSession();
    let res = await requestUrl(current, searchUrl(current, query));
    let refreshedSession = false;
    // Até 2 resoluções de redirect: 301 de canonicalização do domínio (mantém
    // a busca no Location) ou 302 de sessão morta (manda para a home). Na
    // segunda, renova a sessão e retenta UMA vez; se ainda redirecionar, 502.
    for (let attempt = 0; attempt < 2 && isRedirectStatus(res.status); attempt += 1) {
      const location = String(res.headers.get('location') || '');
      if (location && /busca=/i.test(location)) {
        res = await requestUrl(current, new URL(location, siteSelector.url()).href);
      } else {
        if (refreshedSession) break;
        refreshedSession = true;
        current = await ensureSession(true);
        res = await requestUrl(current, searchUrl(current, query));
      }
    }
    if (isRedirectStatus(res.status)) throw new Error('session_rejected');
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.text();
  }

  async function fetchText(url: string): Promise<string> {
    // O post é público (magnet direto no HTML): sem cookie, sem protetor.
    const res = await fetch(assertAllowedUrl(url), {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.text();
  }

  async function getPostMagnets(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    return cachedPost(post.href, POST_CACHE_MS, async () => {
      const html = await fetchText(post.href);
      return { post, links: parsePostMagnets(html, post.href) };
    });
  }

  async function postToItems(post: ApacheWork): Promise<ApacheItem[]> {
    const { links } = await getPostMagnets(post.url);
    return links.map((link, index) => ({ post, link, index, count: links.length }));
  }

  // Seleção PRÓPRIA do perfil: o pré-filtro conservador corta os "parecidos"
  // do buscador (buscar "Coringa" devolve "Corina, Uma Babá Perfeita",
  // "Corinthians"...) antes de pagar o fetch de cada post, e a temporada pedida
  // (quando houver) filtra em cima disso.
  function selectSearchPosts(sourceHtml: string, query: string, requestedSeason: RegExpMatchArray | null): ApacheWork[] {
    let posts = parseSearchHtml(sourceHtml, siteSelector.url())
      .filter((post) => matchesResolverQuery(post, query));
    if (requestedSeason) posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
    return posts.slice(0, MAX_POSTS);
  }

  async function searchPosts(query: string) {
    const requestedSeason = requestedSeasonFromQuery(query);
    const normalized = normalizeQuery(query);
    const cacheKey = `search:${String(query || '')}`;
    return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
      try {
        const html = await fetchSearchHtml(normalized);
        siteSelector.noteSuccess();
        const posts = selectSearchPosts(html, normalized, requestedSeason);
        const chunks = await mapLimit(posts, async (post) => {
          try {
            return await postToItems(post);
          } catch (err) {
            console.warn(`[br] apachetorrent: post sem magnets (${err.message})`);
            return [];
          }
        });
        const items = chunks.flat();
        console.log(`[br] apachetorrent: "${normalized}" → ${posts.length} post(s), ${items.length} release(s)`);
        return items;
      } catch (err) {
        if (isNetworkError(err)) await siteSelector.noteFailure();
        throw err;
      }
    });
  }

  const searchPageHtml = createApacheSearchPageHtml();
  const renderHtml = (items: ApacheItem[]) => searchPageHtml(items);

  const handleRequest = createResolverRouter({
    reply,
    routes: {
      '/health': createHealthRoute({ reply }),
      '/api': createApiRoute({
        reply,
        capsXml: () => `<?xml version="1.0" encoding="UTF-8"?><caps><server version="1.0"/><searching><search available="yes"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>`,
        search: searchPosts,
        renderXml: (items, category) => apacheRssXml(items, category),
        emptyXml: (category) => apacheRssXml([], category),
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
    parseSearchHtml, parsePostMagnets, extractSearchToken, selectSearchPosts,
    matchesResolverQuery, matchesSeasonSeason, normalizeQuery,
    requestedSeasonFromQuery, classifyAudio, qualityFromText,
    cleanPostTitle, releaseTitle, createApacheSearchPageHtml, apacheRssXml,
    isValidMagnetUri, stripTags, decodeEntities, escapeXml,
    assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError,
    searchPosts, fetchSearchHtml, fetchText, getPostMagnets,
    postCache, searchCache, inFlight,
    serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
