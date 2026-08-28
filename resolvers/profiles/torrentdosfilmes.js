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
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');

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

// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';

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

function parseDownloadLinks(html) {
  const links = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let cursor = 0;
  let currentAudio = 'desconhecido';
  let currentEpisode = null;

  while ((match = anchor.exec(html))) {
    const rawHref = decodeEntities(match[1]);
    const isMagnet = rawHref.startsWith('magnet:?');
    if (!isMagnet) {
      let u;
      try {
        u = new URL(rawHref);
      } catch {
        continue;
      }
      if (!isProtectorHost(u.hostname)) continue;
    }

    const rawSegment = html.slice(cursor, match.index);
    const segment = stripTags(rawSegment).toUpperCase();
    const anchorText = stripTags(match[2]).toUpperCase();
    cursor = anchor.lastIndex;

    const audioMarker = [...segment.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*|PORTUGU[ÊE]S)/g)].pop();
    if (audioMarker) {
      currentAudio = /LEGENDAD/.test(audioMarker[1]) ? 'legendado' : 'dublado';
    }

    if (/TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA/i.test(segment)) {
      currentEpisode = null;
    } else {
      const epMatch = [...segment.matchAll(/(?:EPIS[ÓO]DIO|EP)\s*(\d{1,3})\b/gi)].pop();
      if (epMatch) {
        currentEpisode = Number(epMatch[1]);
      }
    }

    const context = `${segment} ${anchorText}`;
    const quality = [...context.matchAll(/(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g)].pop();
    const size = [...context.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)].pop();
    const source = [...context.matchAll(/(REMUX|BLU[- ]?RAY|WEB[-. ]?DL|WEB[-. ]?RIP|HDTV|CAMRIP|CAM)/g)].pop();

    links.push({
      url: rawHref,
      quality: quality ? (quality[1] ? Number(quality[1]) : 2160) : null,
      size: size ? `${size[1]} ${size[2]}` : null,
      audio: currentAudio,
      episode: currentEpisode,
      source: source ? source[1].replace(/[. ]/g, '-') : null,
    });
  }
  return links;
}

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
  let lastError;
  for (const link of [...links].sort((a, b) => scoreLink(b) - scoreLink(a))) {
    try {
      return await fetchFollowingAllowed(link.url, post.href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('no_magnet');
}

function releaseTitle(post, link, index = null) {
  const postTitle = typeof post === 'string' ? post : post?.title || '';
  const clean = cleanPostTitle(postTitle);
  const epPart = link.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const audioTag = link.audio === 'dublado' ? 'DUBLADO' : link.audio === 'legendado' ? 'LEGENDADO' : null;
  const tags = [
    link.quality ? `${link.quality}p` : null,
    link.source,
    audioTag,
    link.size || (index == null ? null : `opção ${index + 1}`),
  ].filter(Boolean);

  const base = epPart ? `${clean} ${epPart}` : clean;
  return tags.length ? `${base} [${tags.join(' ')}]` : base;
}

const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

function searchPageHtml(items) {
  const rows = items.map(({ post, link, index, count }) => {
    const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
    // O Jackett descarta QUALQUER release sem tamanho ("No size provided"), e
    // "0 B" não casa o filtro de `size` do cardigann — era assim que os posts de
    // pack (que não publicam tamanho por botão) perdiam ~50 releases de uma vez.
    // UNKNOWN_SIZE é o sentinela: satisfaz o Jackett e o addon o esconde em vez
    // de exibir um tamanho inventado.
    return `<div class="release"><div class="title"><a href="${escapeXml(download)}">${escapeXml(releaseTitle(post, link, index))}</a></div><div class="size">${escapeXml(link.size || UNKNOWN_SIZE)}</div><div class="description">${escapeXml(post.title)}</div><div class="seeders">1</div></div>`;
  }).join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}

function capsXml() {
  return '<?xml version="1.0"?><caps><server title="TorrentDosFilmes V2" version="1.0"/><limits max="100" default="100"/><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>';
}

function rssXml(items, category) {
  const body = items.map(({ post, link, index, count }) => {
    const download = `${SELF_URL}/dl?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
    const size = parseSize(link.size) || 0;
    return `<item><title>${escapeXml(releaseTitle(post, link))}</title><guid isPermaLink="false">${escapeXml(download)}</guid><link>${escapeXml(download)}</link><comments>${escapeXml(post.url)}</comments><pubDate>${new Date().toUTCString()}</pubDate><size>${size}</size><category>${category}</category><enclosure url="${escapeXml(download)}" type="application/x-bittorrent" length="${size}"/><torznab:attr name="category" value="${category}"/><torznab:attr name="size" value="${size}"/><torznab:attr name="seeders" value="1"/><torznab:attr name="peers" value="1"/><torznab:attr name="downloadvolumefactor" value="0"/><torznab:attr name="uploadvolumefactor" value="1"/></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>TorrentDosFilmes V2</title>${body}</channel></rss>`;
}

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

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method !== 'GET') return reply(response, 404, 'not_found');
  if (url.pathname === '/health') return reply(response, 200, 'ok');
  if (url.pathname === '/api') {
    const type = url.searchParams.get('t') || 'caps';
    if (type === 'caps') return reply(response, 200, capsXml(), 'application/xml; charset=utf-8');
    if (!['search', 'movie', 'tvsearch'].includes(type)) return reply(response, 400, 'unsupported_t');
    const query = String(url.searchParams.get('q') || '');
    const category = type === 'tvsearch' ? 5000 : 2000;
    if (!query.trim()) return reply(response, 200, rssXml([], category), 'application/xml; charset=utf-8');
    try {
      const { posts, items } = await searchPosts(query);
      console.log(`[api] ${posts.length} post(s) -> ${items.length} release(s)`);
      return reply(response, 200, rssXml(items, category), 'application/xml; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  if (url.pathname === '/search') {
    const query = String(url.searchParams.get('q') || '');
    if (!query.trim()) return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
    try {
      const { posts, items } = await searchPosts(query);
      console.log(`[search] ${posts.length} post(s) -> ${items.length} release(s)`);
      return reply(response, 200, searchPageHtml(items), 'text/html; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  if (url.pathname === '/resolve') {
    let postUrl = url.searchParams.get('url');
    if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');
    try {
      const unwrapped = unwrapResolverUrl(postUrl, {
        index: url.searchParams.get('i'),
        hash: url.searchParams.get('h'),
        count: url.searchParams.get('n'),
      });
      postUrl = unwrapped.url;
      const { index, hash, count } = unwrapped;
      const button = index == null ? null : Number(index);
      if (button != null && (!Number.isInteger(button) || button < 0)) throw new Error('invalid_index');
      if (button == null) return reply(response, 200, await resolveBest(postUrl));
      return reply(response, 200, await resolveButton(postUrl, button, hash, count));
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  if (url.pathname === '/dl') {
    const postUrl = url.searchParams.get('url');
    const index = Number(url.searchParams.get('i'));
    if (!postUrl || postUrl.length > 4096 || !Number.isInteger(index) || index < 0) return reply(response, 400, 'invalid_params');
    try {
      response.writeHead(302, { Location: await resolveButton(postUrl, index, url.searchParams.get('h'), url.searchParams.get('n')), 'Cache-Control': 'no-store' });
      return response.end();
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  return reply(response, 404, 'not_found');
}

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
