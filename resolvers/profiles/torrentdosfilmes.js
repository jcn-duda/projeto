const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
const { createServer: createHttpServer } = require('../http-server');
const {
  decodeEntitiesBasic,
  parseSize,
  escapeXml,
  attribute,
  extractMetaRefresh: sharedExtractMetaRefresh,
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
// Passo 5 do item 9: esqueleto de roteador HTTP comum — despacho por pathname
// + rotas padrão (/health, /search, /resolve, /dl, /api). Handlers próprios do
// perfil entram no mapa de rotas sem `if` na factory.
const {
  createResolverRouter, createHealthRoute, createSearchRoute, createResolveRoute,
  createDlRoute, createApiRoute,
} = require('../resolver-http');
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');
// Passo 4 do item 9: máquina de estados da âncora (release-rules.js) e
// títulos/feeds/laço de fallback (release-format.js). O classificador de fonte
// do tdf tem normalização própria (replace de [. ] por '-') e fica AQUI (R-4).
const {
  createEpisodeStep, createLinkCollector, lastAudioMarker,
  NERD_AUDIO_RE, NERD_LEGENDADO_RE, NARROW_PACK_RESET_RE, NARROW_EPISODE_RE,
} = require('../release-rules');
const {
  createReleaseTitle, createSearchPageHtml, createRssXml, tryLinksInOrder,
} = require('../release-format');

const PORT = Number(process.env.PORT || 8703);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
// SELF_URL é como o JACKETT alcança este serviço; SITE_URL é o default do site.
const decodeEntities = decodeEntitiesBasic;

const FALLBACK_SITE_SUFFIXES = [
  'torrentdosfilmes-v2.xyz',
  'torrentdosfilmes.com',
  'torrentdosfilmes.net',
];

// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos cinco perfis (leitura de env no require, seletor
// de failover, conjuntos de sufixos, trio de allowlist, wrappers cosméticos)
// nasce aqui, por chamada — sem estado de módulo compartilhado.
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
const bootstrap = createProfile({
  name: 'torrentdosfilmes',
  port: PORT,
  selfUrlEnv: 'http://torrentdosfilmes-resolver:8703',
  siteUrl: 'https://torrentdosfilmes-v2.xyz',
  siteUrlEnv: 'TORRENTDOSFILMES_URL',
  urlsCsv: process.env.TORRENTDOSFILMES_URLS,
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

function nextProtectedUrl(html, baseUrl) {
  if (!html) return null;
  // Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
  return discoverNextUrl(String(html), baseUrl, {
    isProtectorHost,
    decodeEntities,
    protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
    jsVarPattern: JS_URL_VAR_RE,
  });
}

function parsePosts(html) {
  const posts = [];
  const title = /<div\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = title.exec(html))) {
    const url = attribute(match[1], 'href');
    if (!url) continue;
    const title = stripTags(attribute(match[1], 'title') || match[2]);
    if (isGenericListPost(title)) continue;
    posts.push({ url: new URL(decodeEntities(url), siteSelector.url()).href, title });
  }
  return [...new Map(posts.map((post) => [post.url, post])).values()];
}

function cleanPostTitle(title = '') {
  return String(title)
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)?\s*/gi, ' ')
    .replace(/\b(?:720p|1080p|2160p|4K)(?:\s*\/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Classificador de fonte do tdf: normalização PRÓPRIA (o token casado sai com
// [. ] trocado por '-', então "BLU RAY" vira "BLU-RAY" e "BLURAY" fica inteiro
// — diferença viva do perfil, R-4). Qualidade idem (\d{3,4}P / 4K nu).
const TDF_QUALITY_RE = /(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g;
const TDF_SOURCE_RE = /(REMUX|BLU[- ]?RAY|WEB[-. ]?DL|WEB[-. ]?RIP|HDTV|CAMRIP|CAM)/g;

function qualityOf(context) {
  const quality = [...context.matchAll(TDF_QUALITY_RE)].pop();
  return quality ? (quality[1] ? Number(quality[1]) : 2160) : null;
}

function sourceOf(context) {
  const source = [...context.matchAll(TDF_SOURCE_RE)].pop();
  return source ? source[1].replace(/[. ]/g, '-') : null;
}

/** Máquina de estados do núcleo (createLinkCollector) com escopo
 * segment-only: a âncora NUNCA interfere — nem áudio nem episódio dela tocam
 * o estado ou o botão. Falha de validação NUNCA avança o cursor. */
const episodeStep = createEpisodeStep({
  scope: 'segment-only',
  packRe: NARROW_PACK_RESET_RE,
  epRe: NARROW_EPISODE_RE,
});

const parseDownloadLinks = createLinkCollector({
  anchorRe: /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  resolveHref: (match) => {
    const rawHref = decodeEntities(match[1]);
    // startsWith case-SENSITIVE é o comportamento histórico do perfil.
    if (rawHref.startsWith('magnet:?')) return { url: rawHref };
    let u;
    try {
      u = new URL(rawHref);
    } catch {
      return { skip: true };
    }
    if (!isProtectorHost(u.hostname)) return { skip: true };
    return { url: rawHref };
  },
  anchorTextOf: (match) => stripTags(match[2]),
  stripTags,
  initialAudio: 'desconhecido',
  audioFromSegment: (segment) => lastAudioMarker(segment, NERD_AUDIO_RE, NERD_LEGENDADO_RE),
  episodeStep,
  qualityFn: qualityOf,
  sourceFn: sourceOf,
});

// O laço do protetor é UM só (transport); o perfil aporta apenas os parsers.
// O assertAllowedUrl injetado no laço é o da factory (que delega ao
// protector.js) — nunca uma checagem reimplementada aqui.
const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
  decodeEntities, extractMagnet, nextProtectedUrl,
  extractMetaRefresh: (html) => sharedExtractMetaRefresh(html, decodeEntities),
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
    return { post, links: parseDownloadLinks(await response.text()) };
  });
}

function scoreLink(link) {
  const audio = link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
  return audio + source + Number(link.quality || 0);
}

async function resolveButton(postUrl, index, hash, count) {
  const { post, links } = await getPostLinks(postUrl);
  const link = pickButton(links, index, hash, count);
  if (!link) throw new Error('no_such_button');
  return fetchFollowingAllowed(link.url, post.href);
}

async function resolveBest(postUrl) {
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
  selfUrl: SELF_URL,
  escape: escapeXml,
  releaseTitle,
});

// Feed compacto com <enclosure> — exclusividade do tdf (R-4).
const rssXml = createRssXml({
  selfUrl: SELF_URL,
  channelTitle: 'TorrentDosFilmes V2',
  titleOf: ({ post, link }) => releaseTitle(post, link),
  pubDateOf: () => new Date().toUTCString(),
  withEnclosure: true,
  compact: true,
});

function capsXml() {
  return '<?xml version="1.0"?><caps><server title="TorrentDosFilmes V2" version="1.0"/><limits max="100" default="100"/><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>';
}

const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

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
async function searchPosts(query, requestedSeason) {
  const rawQuery = String(query || '');
  const season = requestedSeason ?? rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const normalized = rawQuery.replace(/\b[sS]\d{1,2}(?:[eE]\d{1,2})?\b/g, ' ').replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return { posts: [], items: [] };
  try {
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
async function searchForPage(query) {
  const { posts, items } = await searchPosts(query);
  console.log(`[search] ${posts.length} post(s) -> ${items.length} release(s)`);
  return items;
}

async function searchForApi(query) {
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

// Quem sobe o servidor é o processo principal ou o src/br-resolvers.js, que já
// chama createServer quando o módulo o exporta. Abrir a porta no require
// deixava o parser impossível de exercitar em teste sem tomar a 8703.
if (require.main === module) {
  bootstrap.serveMain(createServer);
}

module.exports = {
  createServer,
  // Exposto para o painel ler o domínio ATIVO (o failover troca em runtime).
  siteSelector,
  parsePosts,
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
  createSiteSelector,
  isNetworkError,
  postCache,
  inFlight,
};
