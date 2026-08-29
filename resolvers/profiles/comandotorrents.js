const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
const { createServer: createHttpServer } = require('../http-server');
const {
  decodeEntities,
  escapeHtml,
  parseSize,
  attribute,
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
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');
// Passo 4 do item 9: classificadores, máquina de estados da âncora
// (release-rules.js) e títulos/feeds/laço de fallback (release-format.js).
const {
  createQualityRules, createSourceRules, createBrAudioHooks,
  createEpisodeRules, createEpisodeStep, createLinkCollector,
  createProtectorHrefResolver,
} = require('../release-rules');
const {
  cleanPostTitle, createReleaseTitle, createSearchPageHtml, createNormalizeQuery,
  tryLinksInOrder, magnetButtonCacheKey,
} = require('../release-format');

const PORT = Number(process.env.PORT || 8701);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);

const FALLBACK_SITE_SUFFIXES = [
  'comandotorrents.to',
  'comandotorrents.net',
  'comandotorrents.org',
];

// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos cinco perfis (leitura de env no require, seletor
// de failover, conjuntos de sufixos, trio de allowlist, wrappers cosméticos)
// nasce aqui, por chamada — sem estado de módulo compartilhado.
//
// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// COMANDOTORRENTS_URLS) como candidatos ATIVOS, não só allowlist: quando a
// busca falha por erro de rede (DNS/conexão/timeout — HTTP de erro prova que
// o host respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o
// primeiro candidato que responda 2xx. O vencedor fica imune a novo probe
// por BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
const bootstrap = createProfile({
  name: 'comandotorrents',
  port: PORT,
  selfUrlEnv: 'http://comandotorrents-resolver:8701',
  siteUrl: 'https://comandotorrents.to',
  siteUrlEnv: 'COMANDOTORRENTS_URL',
  urlsCsv: process.env.COMANDOTORRENTS_URLS,
  fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
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
const SELF_URL = bootstrap.selfUrl;

// --- Cache (núcleo resolvers/cache.js) ---
// TTL + coalescing + FIFO, escrevendo APENAS no sucesso (erro nunca entra no
// mapa — contrato fixado pelo teste "postCache must not store errors"). Os
// três mapas compartilham UM inFlight: é o shape que testes e harnesses
// consomem (limpam e contam `mod.inFlight` diretamente). Tetos mantidos dos
// laços manuais (fixados pelo teste de stress): post/search 100, magnet 500.
const inFlight = new Map();
const { values: postCache, cached: cachedPost } = createCache(100, { inFlight });
const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });
const { values: magnetCache, cached: cachedMagnet } = createCache(500, { inFlight });

// Troca de domínio invalida o que foi raspado do domínio antigo (chaves de
// cache são URLs absolutas); o inFlight segue vivo para não quebrar o
// coalescing das promises em andamento.
siteSelector.onDomainChange(() => {
  postCache.clear();
  searchCache.clear();
  magnetCache.clear();
});

// Padrões e extração de episódio/pack do núcleo (release-rules.js). Aqui o
// escopo é anchor-writes: a âncora ESCREVE no estado (diferente do bludv). O
// packMatchAll é o padrão CRU /i — o matchAll lança TypeError no ramo de
// desempate e isso é comportamento vivo preservado (não troque pelo clone /g).
const episodeRules = createEpisodeRules();
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

// Classificadores de qualidade/fonte e hooks de áudio compartilhados.
const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules();
const { audioFromSegment, audioFromAnchor } = createBrAudioHooks();

const normalizeQuery = createNormalizeQuery();

const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

// Variante RICA da factory: lista de variáveis ampliada, variante URL-encoded
// dentro das aspas, `data-download` e encoded sem exigir xt nem cortar no `&`.
const extractMagnet = createMagnetExtractor({ decodeEntities, encodedVariants: true });

// Lista de variáveis JS própria deste perfil (a básica casa a menos — R-6).
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|LINK_FINAL|TARGET_URL|DESTINO|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

function nextProtectedUrl(html, baseUrl) {
  if (!html) return null;
  const str = String(html);

  // 1. Meta refresh primeiro: é o salto mais comum dos protetores atuais.
  const refreshTarget = extractMetaRefresh(str);
  if (refreshTarget) {
    try {
      const u = new URL(refreshTarget, baseUrl);
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 2. Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
  return discoverNextUrl(str, baseUrl, {
    isProtectorHost,
    decodeEntities,
    protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
    jsVarPattern: JS_URL_VAR_RE,
  });
}

function parsePosts(html) {
  const posts = [];
  const seen = new Set();
  const article = /<article\b[^>]*class=["'][^"']*\bblog-view\b[^"']*["'][^>]*>([\s\S]*?)(?:<\/article>|(?=<article\b)|$)/gi;
  let match;
  while ((match = article.exec(html))) {
    const anchor = match[1].match(/<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = attribute(anchor[1], 'href');
    if (!url) continue;
    let resolvedUrl;
    try {
      resolvedUrl = new URL(decodeEntities(url), siteSelector.url()).href;
    } catch {
      continue;
    }
    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    const image = match[1].match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || null;
    const title = stripTags(attribute(anchor[1], 'title') || anchor[2]);
    if (isGenericListPost(title)) continue;
    posts.push({
      url: resolvedUrl,
      title,
      poster: image ? decodeEntities(image) : null,
    });
  }
  return posts;
}

// cleanPostTitle (7 passos) é o do núcleo (release-format.js) — idêntico ao
// do bludv; importado no topo e reexportado abaixo.

// Máquina de estados da âncora do núcleo (createLinkCollector): o HTML é
// decodificado ANTES do casamento (o site publica entidades nas âncoras) e o
// cursor AVANÇA nos descartes de URL/host (advance) — corte de segmento igual
// ao do laço original. Falha com href vazio não avança.
const parseDownloadLinks = createLinkCollector({
  anchorRe: /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
  resolveHref: createProtectorHrefResolver({ isProtectorHost, decodeEntities, attribute }),
  anchorTextOf: (match) => stripTags(match[2] || ''),
  stripTags,
  decodeHtml: decodeEntities,
  initialAudio: 'desconhecido',
  audioFromSegment,
  audioFromAnchor,
  episodeStep,
  qualityFn: normalizeQuality,
  sourceFn: normalizeSource,
});

// O laço do protetor é UM só (transport); o perfil aporta apenas os parsers.
// O assertAllowedUrl injetado no laço é o da factory (que delega ao
// protector.js) — nunca uma checagem reimplementada aqui.
const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
  decodeEntities, extractMagnet, nextProtectedUrl, extractMetaRefresh,
  maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
});

async function getPostLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
  return cachedPost(post.href, POST_CACHE_MS, async () => {
    const response = await fetch(post, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return { post, links: parseDownloadLinks(await response.text(), post.href) };
  });
}

function scoreLink(link) {
  return (link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000) + (link.quality || 0);
}

async function resolveBest(postUrl) {
  return cachedMagnet(`magnet:best:${postUrl}`, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    return tryLinksInOrder(
      [...links].sort((a, b) => scoreLink(b) - scoreLink(a)),
      (link) => fetchFollowingAllowed(link.url, post.href),
    );
  });
}

async function resolveButton(postUrl, index, hash, count) {
  const cacheKey = magnetButtonCacheKey(postUrl, index, hash);
  return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = Number.isInteger(index) && index >= 0 ? pickButton(links, index, hash, count) : null;
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  });
}

// Título da release via factory comum: stripSource (comando remove a fonte do
// título limpo) e tag com tamanho/`opção N` são os defaults certos aqui.
const releaseTitle = createReleaseTitle({
  cleanTitle: cleanPostTitle,
  stripSource: true,
});

// Página compacta com poster entre size e description (rowExtras).
const searchPageHtml = createSearchPageHtml({
  selfUrl: SELF_URL,
  escape: escapeHtml,
  releaseTitle,
  rowExtras: (post) => (post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}"></div>` : ''),
});


// `seed` são os params da requisição externa: chamada direta
// (/resolve?url=<post>&i=0&h=..) não tem nível aninhado de onde ler.
// (A variante com defaults do núcleo está no unwrapResolverUrl da factory.)

async function searchPosts(query) {
  const requestedSeason = String(query || '').match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const cacheKey = `search:${String(query || '')}`;

  return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
    try {
      const source = await fetch(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!source.ok) throw new Error(`http_${source.status}`);
      // Sucesso da busca zera o streak ANTES de raspar posts/protetores:
      // queda do protetor não conta como falha do domínio.
      siteSelector.noteSuccess();
      const posts = selectSearchPosts(await source.text(), normalized, requestedSeason);
      const chunks = await mapLimit(posts, async (post) => {
        try {
          const { links } = await getPostLinks(post.url);
          return links.map((link, index) => ({ post, link, index, count: links.length }));
        } catch (err) {
          console.warn(`[search] Falha ao obter links do post ${post.url}: ${err.message}`);
          return [];
        }
      });
      return chunks.flat();
    } catch (err) {
      // Só erro de rede (DNS/conexão/timeout) alimenta o failover: 0
      // resultados ou HTTP de erro não dizem nada sobre o domínio.
      if (isNetworkError(err)) await siteSelector.noteFailure();
      throw err;
    }
  });
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method !== 'GET') return reply(response, 404, 'not_found');
  if (url.pathname === '/health') return reply(response, 200, 'ok');
  if (url.pathname === '/search') {
    const rawQuery = url.searchParams.get('q');
    if (!rawQuery || !rawQuery.trim()) {
      return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
    }
    try {
      const items = await searchPosts(rawQuery);
      return reply(response, 200, searchPageHtml(items), 'text/html; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  if (url.pathname === '/resolve') {
    const value = url.searchParams.get('url');
    if (!value || value.length > 4096) return reply(response, 400, 'invalid_url');
    try {
      const unwrapped = unwrapResolverUrl(value, {
        index: url.searchParams.get('i'),
        hash: url.searchParams.get('h'),
        count: url.searchParams.get('n'),
      });
      const index = unwrapped.index == null ? null : Number(unwrapped.index);
      return reply(
        response,
        200,
        index == null ? await resolveBest(unwrapped.url) : await resolveButton(unwrapped.url, index, unwrapped.hash, unwrapped.count),
      );
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  return reply(response, 404, 'not_found');
}

function createServer() {
  return createHttpServer(handleRequest);
}

if (require.main === module) {
  bootstrap.serveMain(createServer);
}

module.exports = {
  createServer,
  // Exposto para o painel ler o domínio ATIVO (o failover troca em runtime).
  siteSelector,
  parsePosts,
  parseDownloadLinks,
  releaseTitle,
  searchPageHtml,
  assertAllowedUrl,
  extractMagnet,
  extractMetaRefresh,
  nextProtectedUrl,
  isDetailHost,
  isProtectorHost,
  getPostLinks,
  resolveBest,
  resolveButton,
  fetchFollowingAllowed,
  decodeEntities,
  extractEpisode,
  cleanPostTitle,
  isGenericListPost,
  parseSize,
  normalizeQuality,
  normalizeSource,
  normalizeQuery,
  buttonId,
  pickButton,
  unwrapResolverUrl,
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  selectSearchPosts,
  createSiteSelector,
  isNetworkError,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};
