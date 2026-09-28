import { USER_AGENT } from '../runtime.js';
import { createCache } from '../cache.js';
import { createServer as createHttpServer } from '../http-server.js';
import {
  decodeEntitiesBasic,
  parseSize,
  escapeXml,
  extractMetaRefresh as sharedExtractMetaRefresh,
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
import type { ResolverLink, ResolverPost } from '../types.js';
// Parsers do site extraídos pela catraca de linhas (o profile mora com a rede e
// as rotas): lista de posts, limpeza de título e o coletor de botões.
import { cleanPostTitle, createTdfDownloadLinks, parsePosts } from './torrentdosfilmes-parsers.js';
// Laço de redirects com allowlist por salto — o mesmo `fetchFollowRedirects` que
// o vacatorrent usa no fetch direto do crawl (R-1: o assert canônico é o da
// factory, injetado pelo `site-profile`).
import { fetchFollowRedirects } from '../transport.js';
// Passo 5 do item 9: esqueleto de roteador HTTP comum — despacho por pathname
// + rotas padrão (/health, /search, /resolve, /dl, /api). Handlers próprios do
// perfil entram no mapa de rotas sem `if` na factory.
import {
  createResolverRouter, createHealthRoute, createSearchRoute, createResolveRoute,
  createDlRoute, createApiRoute,
} from '../resolver-http.js';
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
import { createMagnetExtractor, discoverNextUrl } from '../magnet-extract.js';
// Passo 4 do item 9: títulos/feeds/laço de fallback (release-format.js). A
// máquina de estados da âncora e o classificador de fonte do tdf (saída própria,
// replace de [. ] por '-') foram para `./torrentdosfilmes-parsers.js` — R-4.
import {
  createReleaseTitle, createSearchPageHtml, createRssXml, tryLinksInOrder,
} from '../release-format.js';
const DEFAULTS = {
  port: 8703, selfUrl: 'http://torrentdosfilmes-resolver:8703', siteUrl: 'https://torrentdosfilmes-v2.xyz',
  urlsCsv: undefined, timeoutMs: 15_000, maxHops: 6, maxPosts: 5, postCacheMs: 10 * 60_000,
};
const META = { name: 'torrentdosfilmes', siteEnv: 'TORRENTDOSFILMES_URL', urlsEnv: 'TORRENTDOSFILMES_URLS', defaults: DEFAULTS };

const FALLBACK_SITE_SUFFIXES = [
  'torrentdosfilmes-v2.xyz',
  'torrentdosfilmes.com',
  'torrentdosfilmes.net',
];

// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos seis perfis nasce aqui, por chamada — sem
// estado de módulo compartilhado.
//
// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// TORRENTDOSFILMES_URLS) como candidatos ATIVOS, não só allowlist: quando a
// busca falha por erro de rede (DNS/conexão/timeout — HTTP de erro prova que
// o host respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o
// primeiro candidato que responda 2xx. O vencedor fica imune a novo probe
// por BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.

/** Instância completa do perfil TorrentDosFilmes; `overrides` vêm do ponto de entrada. */
function createResolver(overrides: ProfileOverrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT = DEFAULTS.port, selfUrl: SELF_URL = DEFAULTS.selfUrl,
    siteUrl: SITE_URL = DEFAULTS.siteUrl, urlsCsv: URLS_CSV,
    timeoutMs: TIMEOUT_MS = DEFAULTS.timeoutMs, maxHops: MAX_HOPS = DEFAULTS.maxHops,
    maxPosts: MAX_POSTS = DEFAULTS.maxPosts, postCacheMs: POST_CACHE_MS = DEFAULTS.postCacheMs,
    extraProtectors: EXTRA_PROTECTORS,
  } = config;

  const decodeEntities = decodeEntitiesBasic;

  const bootstrap = createProfile({
    name: 'torrentdosfilmes',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    urlsCsv: URLS_CSV,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: EXTRA_PROTECTORS,
    concurrency: 3,
    decodeEntities,
  });

  const {
    reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
  } = bootstrap;
  const { ALL_PROTECTOR_SUFFIXES, ALLOWED_SUFFIXES, unwrapResolverUrl, mapLimit } = bootstrap;
  const {
    assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError, stripTags,
  } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // --- Cache (núcleo resolvers/cache.js) ---
  // TTL + coalescing + FIFO, escrevendo APENAS no sucesso (erro nunca entra no
  // mapa — contrato fixado pelo teste "postCache must not store errors"). Teto
  // 100 mantido do laço manual (fixado pelo teste de stress).
  const { values: postCache, inFlight, cached: cachedPost } = createCache(100);

  // Troca de domínio invalida o que foi raspado do domínio antigo (chaves de
  // cache são URLs absolutas); o inFlight segue vivo para não quebrar o
  // coalescing das promises em andamento.
  siteSelector.onDomainChange(() => {
    postCache.clear();
  });

  // Variante BÁSICA da factory: o passo encoded EXIGE `xt%3D` e para no `&` —
  // fixture do br-parsers.test.ts fixa isso; não troque por encodedVariants:true.
  const extractMagnet = createMagnetExtractor({ decodeEntities });

  // Lista de variáveis JS própria deste perfil (a rica casa a mais — R-6).
  const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

  function nextProtectedUrl(html: string | null | undefined, baseUrl?: string): string | null {
    if (!html) return null;
    // Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
    return discoverNextUrl(String(html), baseUrl, {
      isProtectorHost,
      decodeEntities,
      protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
      jsVarPattern: JS_URL_VAR_RE,
    });
  }

  // Lista de resultados da busca WordPress e o coletor de botões moram em
  // `./torrentdosfilmes-parsers.js` (extraídos pela catraca de linhas); o
  // profile injeta a allowlist e o decoder que são DELE.
  const parsePostsOf = (html: string): ResolverPost[] => parsePosts(html, stripTags, decodeEntities, siteSelector.url());
  const parseDownloadLinks = createTdfDownloadLinks({ isProtectorHost, stripTags, decodeEntities });

  /**
   * Fetch DIRETO, sem FlareSolverr — o caminho do CRAWL. O tdf responde 200 em
   * fetch simples (medido 2026-09-28: sitemap, busca e post, todos sem desafio),
   * então aqui não há o que resolver: o que existe é redirect com allowlist por
   * salto, e o `hooks.onRequest` (F3) que dá ao motor o custo REAL por hop
   * (o post + cada botão). A busca ao vivo segue no `fetch` de cima, intacta.
   */
  async function fetchTextDirect(url: string, accept = 'text/html,application/xhtml+xml', hooks?: { onRequest?: () => void }): Promise<string> {
    const response = await fetchFollowRedirects(url, {
      maxHops: MAX_HOPS,
      timeoutMs: TIMEOUT_MS,
      assertAllowedUrl,
      ...(hooks?.onRequest ? { onRequest: hooks.onRequest } : {}),
      headersFor: () => ({ 'User-Agent': USER_AGENT, Accept: accept }),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.text();
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
    return cachedPost(post.href, POST_CACHE_MS, async () => {
      const response = await fetch(post, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return { post, links: parseDownloadLinks(await response.text()) };
    });
  }

  function scoreLink(link: ResolverLink): number {
    const audio = link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
    const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
    return audio + source + Number(link.quality || 0);
  }

  async function resolveButton(postUrl: string, index: number, hash: string | null = null, count: string | null = null) {
    const { post, links } = await getPostLinks(postUrl);
    const link = pickButton(links, index, hash, count);
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  }

  async function resolveBest(postUrl: string) {
    const { post, links } = await getPostLinks(postUrl);
    return tryLinksInOrder(
      [...links].sort((a, b) => scoreLink(b) - scoreLink(a)),
      (link) => fetchFollowingAllowed(link.url, post.href),
    );
  }

  // Título da release via factory comum (defaults: tag com tamanho/`opção N`,
  // audioTag DUBLADO/LEGENDADO, sem strip de fonte; cleanPostTitle é a variante
  // curta deste perfil, que fica aqui).
  const releaseTitle = createReleaseTitle({ cleanTitle: cleanPostTitle });

  // Página compacta, sem poster nem data (rowExtras default vazio).
  const searchPageHtml = createSearchPageHtml({
    selfUrl: SELF_URL_RESOLVED,
    escape: escapeXml,
    releaseTitle,
  });

  // Feed compacto com <enclosure> — exclusividade do tdf (R-4).
  const rssXml = createRssXml({
    selfUrl: SELF_URL_RESOLVED,
    channelTitle: 'TorrentDosFilmes V2',
    titleOf: ({ post, link }) => releaseTitle(post, link),
    pubDateOf: () => new Date().toUTCString(),
    withEnclosure: true,
    compact: true,
  });

  function capsXml(): string {
    return '<?xml version="1.0"?><caps><server title="TorrentDosFilmes V2" version="1.0"/><limits max="100" default="100"/><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>';
  }

  const selectSearchPosts = bootstrap.makeSelectSearchPosts((html) => parsePostsOf(html), MAX_POSTS);

  // O download.before do cardigann encoda a href inteira no param url — e a
  // href já é um /resolve nosso, então o alvo real vem aninhado. Desempacota
  // quantos níveis vierem, carregando i/h/n do nível mais interno que os
  // declarar. `seed` são os params da requisição externa: chamada direta
  // (/resolve?url=<post>&i=0&h=..) não tem nível interno de onde ler.
  // Sem checar a origem: o host varia (`addon` embutido vs. nome do
  // container), e o alvo final passa por assertAllowedUrl de todo jeito.
  // (A variante com defaults do núcleo está no unwrapResolverUrl da factory.)

  // Busca WordPress com nota de saúde para o failover de domínio: sucesso zera
  // o streak; erro de rede (DNS/conexão/timeout) acumula e pode disparar o
  // probe. Comum aos dois modos (/api torznab e /search cardigann), que antes
  // repetiam o mesmo fetch inline.
  async function searchPosts(query: string, requestedSeason?: RegExpMatchArray | null) {
    const rawQuery = String(query || '');
    const season = requestedSeason ?? rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
    const normalized = rawQuery.replace(/\b[sS]\d{1,2}(?:[eE]\d{1,2})?\b/g, ' ').replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    try {
      // Query vazia (browse do cardigann, Test do Jackett) roda o MESMO
      // caminho: `/?s=` sem termo é o arquivo de posts recentes do WordPress
      // e o matchesResolverQuery passa tudo com query vazia.
      const search = await fetch(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!search.ok) throw new Error(`http_${search.status}`);
      siteSelector.noteSuccess();
      const posts = selectSearchPosts(await search.text(), normalized, season);
      const chunks = await mapLimit(posts, async (post) => {
        const { links } = await getPostLinks(post.url);
        return links.map((link, index) => ({ post, link, index, count: links.length }));
      });
      return { posts, items: chunks.flat() };
    } catch (err) {
      if (isNetworkError(err)) await siteSelector.noteFailure();
      throw err;
    }
  }

  // Adaptação das buscas para as rotas comuns: o searchPosts do tdf devolve
  // { posts, items } e o log do perfil acontece ENTRE a busca e a resposta —
  // a ordem (e o prefixo [search]/[api]) é preservada pelos adaptadores.
  async function searchForPage(query: string) {
    const { posts, items } = await searchPosts(query);
    console.log(`[search] ${posts.length} post(s) -> ${items.length} release(s)`);
    return items;
  }

  async function searchForApi(query: string) {
    const { posts, items } = await searchPosts(query);
    console.log(`[api] ${posts.length} post(s) -> ${items.length} release(s)`);
    return items;
  }

  // --- Rotas HTTP (esqueleto comum em resolver-http.js) ---
  // tdf expõe /api (torznab) e /dl além de /health, /search e /resolve. No
  // /resolve o índice inválido é erro EXPLÍCITO (invalid_index → 502) —
  // validateIndex:true, a variante do tdf/nerd, diferente de comando/vaca. O
  // feed vazio do /api espelha a categoria pedida (tvsearch → 5000).
  const handleRequest = createResolverRouter({
    reply,
    routes: {
      '/health': createHealthRoute({ reply }),
      '/api': createApiRoute({
        reply, capsXml,
        search: searchForApi,
        renderXml: (items, category) => rssXml(items, category),
        emptyXml: (category) => rssXml([], category),
      }),
      '/search': createSearchRoute({ reply, search: searchForPage, renderHtml: searchPageHtml }),
      '/resolve': createResolveRoute({ reply, unwrapResolverUrl, resolveBest, resolveButton, validateIndex: true }),
      '/dl': createDlRoute({ reply, resolveButton }),
    },
  });

  function createServer() {
    return createHttpServer(handleRequest);
  }

  return {
    createServer,
    // Exposto para o painel ler o domínio ATIVO (o failover troca em runtime).
    siteSelector,
    parsePosts: parsePostsOf,
    parseDownloadLinks,
    parseSize,
    releaseTitle,
    searchPageHtml,
    assertAllowedUrl,
    extractMagnet,
    nextProtectedUrl,
    isDetailHost,
    isProtectorHost,
    searchPosts,
    getPostLinks,
    resolveButton,
    buttonId,
    pickButton,
    unwrapResolverUrl,
    isGenericListPost,
    normalizeFilterText,
    stripTrailingYears,
    computeWantedTokens,
    matchesResolverQuery,
    normalizeSeasonValue,
    matchesSeasonSeason,
    selectSearchPosts,
    fetchFollowingAllowed,
    // Fetch DIRETO do crawl (sem Flare): mesma assinatura que o vacatorrent e o
    // nerdfilmes expõem, para o adaptador de raspagem contar o custo por hop.
    fetchTextDirect,
    createSiteSelector,
    isNetworkError,
    postCache,
    inFlight,
    serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
