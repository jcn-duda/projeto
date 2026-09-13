import { USER_AGENT } from '../runtime.js';
import { createServer as createHttpServer } from '../http-server.js';
import { createCache } from '../cache.js';
import { capsXml as sharedCapsXml } from '../torznab.js';
import type { ServerResponse } from 'node:http';
import {
  decodeEntitiesBasic, parseSize, escapeXml, extractMetaRefresh as sharedExtractMetaRefresh,
} from '../text.js';
import {
  normalizeFilterText, stripTrailingYears, computeWantedTokens, matchesResolverQuery,
  normalizeSeasonValue, matchesSeasonSeason, isGenericListPost, buttonId, pickButton,
} from '../matching.js';
import { createProfile } from '../site-profile.js';
import { buildProfileConfig } from '../env-config.js';
import type { ProfileOverrides } from '../env-config.js';
// Passo 5 do item 9: esqueleto de roteador HTTP comum — despacho por pathname
// + rotas padrão (/health, /resolve, /dl). /api e /search ficam no perfil
// (cache de busca próprio) e entram no mapa de rotas como handlers diretos.
import {
  createResolverRouter, createHealthRoute, createResolveRoute, createDlRoute,
} from '../resolver-http.js';
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
import { createMagnetExtractor, discoverNextUrl } from '../magnet-extract.js';
import {
  createReleaseTitle, createSearchPageHtml, createRssXml, createNormalizeQuery,
  tryLinksInOrder, magnetButtonCacheKey,
} from '../release-format.js';
import {
  parsePosts, createNerdDownloadLinks, parsePostDate, isValidDirectMagnet,
  cleanPostTitle, scoreLink, normalizeSource,
} from './nerdfilmes-parsers.js';
import type { ResolverPost } from '../types.js';

const DEFAULTS = {
  port: 8702,
  selfUrl: 'http://nerdfilmes-resolver:8702',
  siteUrl: 'https://www.filmesviatorrenthd.org',
  urlsCsv: undefined,
  timeoutMs: 15_000,
  maxHops: 6,
  maxPosts: 5,
  searchCacheMs: 2 * 60_000,
  postCacheMs: 10 * 60_000,
  magnetCacheMs: 30 * 60_000,
};
const META = {
  name: 'nerdfilmes', siteEnv: 'NERDFILMES_URL', urlsEnv: 'NERDFILMES_URLS',
  defaults: DEFAULTS,
};

const CONCURRENCY = 4;

// "Nome S01E01" → "Nome" — variante HISTÓRICA do nerd: SEM fronteiras \b no
// strip de SxxEyy (R-4: mudar para a variante com \b mudaria o resultado da
// busca; "S1m0ne" já era afetado antes e continua sendo).

const FALLBACK_SITE_SUFFIXES = [
  'xnerdfilmes.net', 'nerdfilmestorrent.com', 'nerdfilmestorrent.org',
  'nerdfilmestorrent.net', 'nerdviatorrents.net', 'filmesviatorrents.net',
  'filmesviatorrenthd.org',
];

// nerdviatorrents.net migrou para filmesviatorrents.net (301 permanente). Sem
// NERDFILMES_URL/SITE_URL no ambiente (o modo embutido não injeta nada), o
// default do profile é o que o resolver tenta primeiro — deixá-lo no domínio
// velho faz o redirect cair na allowlist e a fonte morrer em silêncio.
//
// E foi exatamente o que aconteceu de novo: filmesviatorrents.net passou a
// redirecionar 301 para filmesviatorrenthd.org (domínio DIFERENTE — `torrents`
// virou `torrenthd` e .net virou .org, não é variação de www). Medido em
// produção: o guard recusava o destino com `blocked_host:...filmesviatorrenthd
// .org`, o resolver devolvia 502, o Cardigann traduzia para BadGateway e o
// painel mostrava o indexer offline com ms medido — respondendo rápido, porque
// quem respondia era o próprio guard, antes de qualquer rede.
//
// O failover de domínio não cobre este caso: ele dispara por ERRO DE REDE, e
// aqui a recusa é nossa, antes do fetch. Por isso o domínio novo precisa entrar
// na lista acima (que é allowlist E lista de candidatos) e virar o default.

/** Instância completa do perfil NerdFilmes; `overrides` vêm do ponto de entrada. */
function createResolver(overrides: ProfileOverrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT = DEFAULTS.port, selfUrl: SELF_URL = DEFAULTS.selfUrl,
    siteUrl: SITE_URL = DEFAULTS.siteUrl, urlsCsv: URLS_CSV,
    timeoutMs: TIMEOUT_MS = DEFAULTS.timeoutMs, maxHops: MAX_HOPS = DEFAULTS.maxHops,
    maxPosts: MAX_POSTS = DEFAULTS.maxPosts,
    searchCacheMs: SEARCH_CACHE_MS = DEFAULTS.searchCacheMs,
    postCacheMs: POST_CACHE_MS = DEFAULTS.postCacheMs,
    magnetCacheMs: MAGNET_CACHE_MS = DEFAULTS.magnetCacheMs,
    extraProtectors: EXTRA_PROTECTORS,
  } = config;

  const decodeEntities = decodeEntitiesBasic;
  const normalizeQuery = createNormalizeQuery({ boundary: false });

  // --- Bootstrap comum (site-profile) ---
  // Toda a montagem repetida nos seis perfis nasce aqui, por chamada — sem
  // estado de módulo compartilhado.
  const bootstrap = createProfile({
    name: 'nerdfilmes',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    urlsCsv: URLS_CSV,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: EXTRA_PROTECTORS,
    // O host rejeitado viaja na mensagem: sem ele o sintoma é "0 resultados" e
    // a causa (redirect para domínio fora da allowlist) só aparece auditando.
    blockedHostDetail: true,
    concurrency: CONCURRENCY,
    decodeEntities,
  });

  const {
    reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
    ALL_PROTECTOR_SUFFIXES, ALLOWED_SUFFIXES, unwrapResolverUrl,
    assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError, stripTags,
  } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // parseDownloadLinks POR INSTÂNCIA: a lista de protetores vem do bootstrap
  // desta instância (base + EXTRA_ALLOWED_PROTECTORS/override), não do
  // singleton de módulo do parsers. Duas instâncias com `extraProtectors`
  // distintos reconhecem conjuntos distintos de protetor.
  const parseDownloadLinks = createNerdDownloadLinks({ isProtectorHost });

  const { values: cache, inFlight, cached: cachedCore } = createCache(500);

  // Troca de domínio invalida o que foi raspado do domínio antigo (chaves de
  // cache são URLs absolutas); o inFlight segue vivo para não quebrar o
  // coalescing das promises em andamento.
  siteSelector.onDomainChange(() => {
    cache.clear();
  });

  async function cached<R>(key: string, ttl: number, loader: () => R | Promise<R>): Promise<R> {
    return cachedCore(key, ttl, loader);
  }

  // Variante BÁSICA da factory: o passo encoded EXIGE `xt%3D` e para no `&` —
  // fixture do br-parsers.test.ts fixa isso; não troque por encodedVariants:true.
  const extractMagnet = createMagnetExtractor({ decodeEntities });

  // Lista de variáveis JS própria deste perfil (a rica casa a mais — R-6).
  const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

  function nextProtectedUrl(html: string | null | undefined, baseUrl?: string): string | null {
    if (!html) return null;
    // Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
    return discoverNextUrl(String(html), baseUrl, {
      isProtectorHost, decodeEntities,
      protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
      jsVarPattern: JS_URL_VAR_RE,
    });
  }

  async function fetchText(value: string, referer?: string): Promise<{ html: string; url: string }> {
    let current = assertAllowedUrl(value);
    let previousReferer = referer;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const response = await fetch(current, {
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          ...(previousReferer ? { Referer: previousReferer } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('missing_redirect');
        previousReferer = current.href;
        current = assertAllowedUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) throw new Error(`http_${response.status}`);
      return { html: await response.text(), url: current.href };
    }
    throw new Error('too_many_redirects');
  }

  // O laço do protetor é UM só (transport); o perfil aporta apenas os parsers.
  // O assertAllowedUrl injetado no laço é o da factory (que delega ao
  // protector.js) — nunca uma checagem reimplementada aqui.
  const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
    decodeEntities, extractMagnet, nextProtectedUrl,
    extractMetaRefresh: (html) => sharedExtractMetaRefresh(html, decodeEntities),
    maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
  });

  async function getPostLinks(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    return cached(`post:${post.href}`, POST_CACHE_MS, async () => {
      const { html } = await fetchText(post.href);
      return { post, links: parseDownloadLinks(html), date: parsePostDate(html) };
    });
  }

  async function resolveBest(postUrl: string) {
    return cached(`magnet:best:${postUrl}`, MAGNET_CACHE_MS, async () => {
      const { post, links } = await getPostLinks(postUrl);
      const ordered = [...links].sort((a, b) => scoreLink(b) - scoreLink(a));
      return tryLinksInOrder(ordered, (link) => fetchFollowingAllowed(link.url, post.href), {
        emptyError: 'no_protector',
      });
    });
  }

  async function resolveButton(postUrl: string, index: number, hash: string | null = null, count: string | null = null) {
    return cached(magnetButtonCacheKey(postUrl, index, hash), MAGNET_CACHE_MS, async () => {
      const { post, links } = await getPostLinks(postUrl);
      const link = pickButton(links, index, hash, count);
      if (!link) throw new Error('no_such_button');
      return fetchFollowingAllowed(link.url, post.href);
    });
  }

  // Mantém a assinatura histórica de 3 argumentos: o searchPipeline passa o
  // limite junto na chamada.
  const mapLimit = <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) =>
    bootstrap.mapLimit(items, fn, { limit });

  /**
   * Seleção pura de posts: parsePosts -> matchesResolverQuery (título) -> filtro
   * de temporada corrente -> slice(MAX_POSTS). A temporada entra ANTES do corte
   * para não perder a temporada pedida quando 5 posts errados vêm primeiro — do
   * contrário o slice(MAX_POSTS) jogava fora exatamente a do usuário.
   */
  const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

  /**
   * Pipeline comum aos dois caminhos (/api e /search) para não deixar drift:
   * ambiguidades vêm antes das decisões que o addon toma depois. A seleção é o
   * passo <b>antes</b> da parte cara; só se pagam protetores de link nos posts
   * que passaram. Devolve { posts, items } para o chamador formatar.
   */
  async function searchPipeline(sourceHtml: string, query: string, requestedSeason: RegExpMatchArray | null) {
    const posts = selectSearchPosts(sourceHtml, query, requestedSeason);
    const chunks = await mapLimit(posts, CONCURRENCY, async (post: ResolverPost) => {
      const { links, date } = await getPostLinks(post.url);
      return links.map((link, index) => ({ post: { ...post, date }, link, index, count: links.length }));
    });
    return { posts, items: chunks.flat() };
  }

  // Título da release via factory comum: o nerd usa os defaults (tag com
  // tamanho/`opção N`, audioTag DUBLADO/LEGENDADO, sem strip de fonte).
  const releaseTitle = createReleaseTitle({ cleanTitle: cleanPostTitle });

  // Página compacta com a data do post entre size e description (rowExtras);
  // o nerd escreve a página com escapeXml (mesmo algoritmo do escapeHtml hoje).
  const searchPageHtml = createSearchPageHtml({
    selfUrl: SELF_URL_RESOLVED,
    escape: escapeXml,
    releaseTitle,
    rowExtras: (post) => (post.date ? `<div class="date">${escapeXml(post.date)}</div>` : ''),
  });

  function pubDate(post: { date?: string | null; title?: string | null }): string {
    const explicit = new Date(post.date || '');
    if (!Number.isNaN(explicit.getTime())) return explicit.toUTCString();
    const year = String(post.title || '').match(/\b((?:19|20)\d{2})\b/)?.[1];
    return new Date(Date.UTC(Number(year || 2000), 0, 1)).toUTCString();
  }

  function capsXml(): string {
    return sharedCapsXml('NerdFilmesTorrent / XNerdFilmes');
  }

  // Feed multilinha sem description nem <enclosure> — defaults da factory comum.
  const rssXml = createRssXml({
    selfUrl: SELF_URL_RESOLVED,
    channelTitle: 'NerdFilmesTorrent / XNerdFilmes',
    titleOf: ({ post, link }) => releaseTitle(post.title, link),
    pubDateOf: ({ post }) => pubDate(post),
  });

  // Busca WordPress com nota de saúde para o failover de domínio: sucesso zera
  // o streak; erro de rede (DNS/conexão/timeout) acumula e pode disparar o
  // probe. Comum aos dois modos (/api torznab e /search cardigann).
  async function fetchSearchHtml(query: string): Promise<string> {
    try {
      const { html } = await fetchText(`${siteSelector.url()}/?s=${encodeURIComponent(query)}`);
      siteSelector.noteSuccess();
      return html;
    } catch (err) {
      if (isNetworkError(err)) await siteSelector.noteFailure();
      // Redirect permanente para domínio fora da allowlist vira fonte morta
      // silenciosa (o failover só reage a erro de rede). O warn distinto —
      // citando o host rejeitado — é o que impede a próxima descoberta tardia.
      else if (String(err.message || err).startsWith('blocked_host')) {
        console.warn(`[nerdfilmes] busca em ${siteSelector.url()} bloqueada: ${err.message} — domínio novo fora da allowlist?`);
      }
      throw err;
    }
  }

  async function handleApi(url: URL, response: ServerResponse) {
    const type = url.searchParams.get('t') || 'caps';
    if (type === 'caps') return reply(response, 200, capsXml(), 'application/xml; charset=utf-8');
    if (!['search', 'movie', 'tvsearch'].includes(type)) return reply(response, 400, 'unsupported_t');
    const rawQuery = String(url.searchParams.get('q') || '');
    const requestedSeason = rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
    const query = normalizeQuery(rawQuery);
    const category = type === 'tvsearch' ? 5000 : 2000;
    if (!query) return reply(response, 200, rssXml([], category), 'application/xml; charset=utf-8');

    try {
      const xml = await cached(`search:${type}:${rawQuery}`, SEARCH_CACHE_MS, async () => {
        const html = await fetchSearchHtml(query);
        const { posts, items } = await searchPipeline(html, query, requestedSeason);
        const seen = new Set<string>();
        const filtered = items.filter(({ post, link }) => {
          const key = `${post.url}|${link.url}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        console.log(`[api] "${query}" → ${posts.length} post(s), ${filtered.length} release(s)`);
        return rssXml(filtered, category);
      });
      return reply(response, 200, xml, 'application/xml; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }

  async function handleSearch(url: URL, response: ServerResponse) {
    const rawQuery = String(url.searchParams.get('q') || '');
    const requestedSeason = rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
    const query = normalizeQuery(rawQuery);
    // Sem atalho de query vazia: o browse do cardigann (Test do Jackett) roda o
    // MESMO caminho — `/?s=` sem termo é o arquivo de posts recentes do
    // WordPress e o matchesResolverQuery passa tudo com query vazia. (O /api
    // torznab mantém o feed vazio na query vazia — semântica de RSS.)
    try {
      const html = await cached(`search-html:${rawQuery}`, SEARCH_CACHE_MS, async () => {
        const source = await fetchSearchHtml(query);
        const { posts, items } = await searchPipeline(source, query, requestedSeason);
        console.log(`[search] "${query}" → ${posts.length} post(s), ${items.length} release(s)`);
        return searchPageHtml(items);
      });
      return reply(response, 200, html, 'text/html; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }

  // --- Rotas HTTP (esqueleto comum em resolver-http.js) ---
  // /api e /search têm cache próprio (chaves `search:${type}:` e `search-html:`
  // distintas) e ficam AQUI; /resolve e /dl são as rotas padrão — o resolve do
  // nerd valida índice (invalid_index → 502), variante validateIndex:true.
  function createServer() {
    return createHttpServer(createResolverRouter({
      reply,
      routes: {
        '/health': createHealthRoute({ reply }),
        '/api': handleApi,
        '/search': handleSearch,
        '/resolve': createResolveRoute({ reply, unwrapResolverUrl, resolveBest, resolveButton, validateIndex: true }),
        '/dl': createDlRoute({ reply, resolveButton }),
      },
    }));
  }

  return {
    createServer, parsePosts, parseDownloadLinks, parsePostDate, parseSize,
    releaseTitle, pubDate, searchPageHtml, assertAllowedUrl, extractMagnet,
    nextProtectedUrl, isDetailHost, isProtectorHost, isValidDirectMagnet,
    getPostLinks, fetchFollowingAllowed, siteSelector, createSiteSelector,
    isNetworkError, normalizeFilterText, stripTrailingYears, computeWantedTokens,
    matchesResolverQuery, normalizeSeasonValue, matchesSeasonSeason,
    selectSearchPosts, buttonId, pickButton, unwrapResolverUrl,
    isGenericListPost, cleanPostTitle, normalizeSource, scoreLink,
    cache, inFlight, serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
