const http = require('node:http');
const { createHash } = require('node:crypto');
const { parseExtraProtectors: runtimeParseExtraProtectors } = require('../runtime');
const { createSiteSelector: createSharedSiteSelector, isNetworkError: sharedIsNetworkError } = require('../site-selector');
const { createServer: createHttpServer } = require('../http-server');
const { assertAllowedUrl: sharedAssertAllowedUrl } = require('../protector');

const PORT = Number(process.env.PORT || 8703);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const CONCURRENCY = 3;
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SELF_URL = (process.env.SELF_URL || 'http://torrentdosfilmes-resolver:8703').replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || process.env.TORRENTDOSFILMES_URL || 'https://torrentdosfilmes-v2.xyz').replace(/\/$/, '');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

function parseExtraProtectors(envVal) {
  return runtimeParseExtraProtectors(envVal);
}

const FALLBACK_SITE_SUFFIXES = [
  'torrentdosfilmes-v2.xyz',
  'torrentdosfilmes.com',
  'torrentdosfilmes.net',
];

// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// TORRENTDOSFILMES_URLS) como candidatos ATIVOS, não só allowlist: quando a
// busca falha por erro de rede (DNS/conexão/timeout — HTTP de erro prova que
// o host respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o
// primeiro candidato que responda 2xx. O vencedor fica imune a novo probe
// por BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
function isNetworkError(err) {
  return sharedIsNetworkError(err);
}

// Mantém a superfície histórica do profile sem duplicar o seletor compartilhado.
const createSiteSelector = createSharedSiteSelector;

const siteSelector = createSharedSiteSelector('[torrentdosfilmes]', process.env.TORRENTDOSFILMES_URLS, SITE_URL, FALLBACK_SITE_SUFFIXES);
// Hosts de TODOS os candidatos são confiáveis desde o boot (vêm de env ou da
// lista de mirrors históricos): allowlist e isDetailHost já aceitam o domínio
// que o failover escolher, sem restart.
const CANDIDATE_HOSTS = siteSelector.hosts();

const BASE_PROTECTOR_SUFFIXES = [
  'systemads1.com',
  'systemads.net',
  'videosad.net',
  'canalfutebol.com',
];

const EXTRA_PROTECTORS = parseExtraProtectors(process.env.EXTRA_ALLOWED_PROTECTORS);

const ALL_PROTECTOR_SUFFIXES = Array.from(
  new Set([...BASE_PROTECTOR_SUFFIXES, ...EXTRA_PROTECTORS]),
);

const ALLOWED_SUFFIXES = Array.from(
  new Set([
    ...CANDIDATE_HOSTS,
    ...ALL_PROTECTOR_SUFFIXES,
  ]),
);

const postCache = new Map();
const inFlight = new Map();

// Troca de domínio invalida o que foi raspado do domínio antigo (chaves de
// cache são URLs absolutas); o inFlight segue vivo para não quebrar o
// coalescing das promises em andamento.
siteSelector.onDomainChange(() => {
  postCache.clear();
});

// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#0?38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#039;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(value = '') {
  return decodeEntities(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function assertAllowedUrl(value) {
  return sharedAssertAllowedUrl(value, ALLOWED_SUFFIXES);
}

function isDetailHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return CANDIDATE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isProtectorHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALL_PROTECTOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function attribute(attributes, name) {
  return String(attributes).match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || null;
}

function extractMagnet(html) {
  if (!html) return null;
  const str = String(html);

  // 1. Variáveis JavaScript explícitas (DEST_URL, DOWNLOAD_URL, url, link, target, dest, etc.)
  const jsVar = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+)["']/i,
  );
  if (jsVar) return decodeEntities(jsVar[1]);

  // 2. Redirecionamentos / atribuições de navegação JavaScript
  const jsNav = str.match(
    /(?:location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+)["']/i,
  );
  if (jsNav) return decodeEntities(jsNav[1]);

  // 3. Atributos HTML customizados (data-magnet, data-url, data-link, data-href)
  const attrMatch = str.match(
    /(?:data-magnet|data-url|data-link|data-href)\s*=\s*["'](magnet:\?[^"']+)["']/i,
  );
  if (attrMatch) return decodeEntities(attrMatch[1]);

  // 4. Regex direto de URI magnet no documento
  const rawMatch = str.match(/magnet:\?[^"'<>\s]+/i);
  if (rawMatch) return decodeEntities(rawMatch[0]);

  // 5. Magnet URL-encoded (ex.: magnet%3A%3Fxt%3Durn)
  const encodedMatch = str.match(/magnet%3A%3Fxt%3D[^"'<>\s&]+/i);
  if (encodedMatch) {
    try {
      const decoded = decodeURIComponent(encodedMatch[0]);
      if (decoded.startsWith('magnet:?')) return decodeEntities(decoded);
    } catch {}
  }

  return null;
}

function nextProtectedUrl(html, baseUrl) {
  if (!html) return null;
  const str = String(html);

  // 1. Variável JavaScript apontando para URL HTTP(S) de protetor permitido
  const jsMatch = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
  );
  if (jsMatch) {
    try {
      const u = new URL(decodeEntities(jsMatch[1]), baseUrl);
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 2. Busca genérica de URLs no corpo HTML apontando para domínios de protetor
  const escapedProtectors = ALL_PROTECTOR_SUFFIXES
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (escapedProtectors) {
    const re = new RegExp(`https?:\\/\\/[^"'<>\\s]*?(?:${escapedProtectors})[^"'<>\\s]*`, 'i');
    const match = str.match(re);
    if (match) {
      try {
        const u = new URL(decodeEntities(match[0]), baseUrl);
        if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
      } catch {}
    }
  }

  return null;
}

// Post de índice/lista que expande dezenas de opções de 1 KB e inunda o
// Manual Search (ex.: "Lista De Filmes – Ação, Terror, Aventura...").
// Conservadora de propósito: só casa quando o TÍTULO COMEÇA como um índice e
// nomeia uma categoria de mídia. "A Lista de Schindler" (começa com "a") ou
// um título que apenas contém "lista" no meio passam intactos.
function isGenericListPost(title = '') {
  if (!title) return false;
  const clean = String(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–\-—/|:&+,–.()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^(lista|listao|indice)/.test(clean)) return false;
  const categories = [
    'filme', 'filmes', 'serie', 'series', 'anime', 'animes', 'desenho', 'desenhos',
    'documentario', 'documentarios', 'temporada', 'temporadas', 'dorama', 'doramas',
    'jogo', 'jogos', 'musica', 'musicas', 'categoria', 'categorias', 'todo', 'todos',
    'toda', 'todas', 'tudo', 'geral', 'completa', 'completo',
  ].join('|');
  const match = clean.match(new RegExp(`^(lista|listao|indice)\\s+de\\s+(${categories})\\b(.*)$`));
  if (!match) return false;
  // "Lista de Filmes do Cliente" pode ser um título/curadoria específica;
  // um índice genérico costuma terminar na categoria ou continuar com uma
  // enumeração de gêneros, nunca com um qualificador possessivo.
  return !/^(?:do|da|dos|das|de)\b/.test(match[3].trim());
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

function parseSize(value) {
  const match = String(value || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const number = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase()];
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
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

async function fetchFollowingAllowed(value, referer) {
  if (String(value).startsWith('magnet:')) return decodeEntities(value);
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
      if (location.startsWith('magnet:')) return decodeEntities(location);
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`http_${response.status}`);
    const html = await response.text();
    const magnet = extractMagnet(html);
    if (magnet) return magnet;
    const next = nextProtectedUrl(html, current.href);
    if (next) {
      previousReferer = current.href;
      current = assertAllowedUrl(next);
      continue;
    }
    const refresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i);
    if (!refresh) throw new Error('no_magnet');
    previousReferer = current.href;
    current = assertAllowedUrl(new URL(decodeEntities(refresh[1]), current).href);
  }
  throw new Error('too_many_redirects');
}

async function getPostLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
  const cacheKey = post.href;

  const cached = postCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) postCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const response = await fetch(post, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const value = { post, links: parseDownloadLinks(await response.text()) };
    postCache.set(cacheKey, { value, expiresAt: Date.now() + POST_CACHE_MS });
    if (postCache.size > 100) postCache.delete(postCache.keys().next().value);
    return value;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

function scoreLink(link) {
  const audio = link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
  return audio + source + Number(link.quality || 0);
}

function buttonId(link) {
  return createHash('sha1').update(String(link?.url || '')).digest('hex').slice(0, 10);
}

function pickButton(links, index, hash, count) {
  if (hash) {
    const found = links.find((link) => buttonId(link) === hash);
    if (found) return found;
    if (count != null && links.length !== Number(count)) return null;
  }
  return links[index] ?? null;
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

async function mapLimit(items, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        output[index] = await fn(items[index]);
      } catch {
        output[index] = null;
      }
    }
  }));
  return output.filter(Boolean);
}

function escapeXml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function normalizeFilterText(s = '') {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripTrailingYears(tokens) {
  const out = tokens.slice();
  if (out.length >= 2 && /^\d{4}$/.test(out[out.length - 1])) out.pop();
  return out;
}

function computeWantedTokens(query) {
  const all = stripTrailingYears(normalizeFilterText(query).split(' ').filter(Boolean));
  const long = all.filter((w) => w.length > 2);
  return long.length >= 2 ? long : all;
}

function matchesResolverQuery(post, query) {
  const wanted = computeWantedTokens(query);
  if (wanted.length === 0) return true;
  const got = new Set(normalizeFilterText(post.title).split(' ').filter(Boolean));
  return wanted.filter((w) => got.has(w)).length / wanted.length >= 0.6;
}

function normalizeSeasonValue(value) {
  const n = Number(Array.isArray(value) ? value[1] : value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function matchesSeasonSeason(post, requestedSeason) {
  const wantedSeason = normalizeSeasonValue(requestedSeason);
  if (wantedSeason == null) return true;
  const season = post.title.match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
  return !season || Number(season[1] || season[2]) === wantedSeason;
}

function selectSearchPosts(sourceHtml, query, requestedSeason) {
  let posts = parsePosts(sourceHtml).filter((post) => matchesResolverQuery(post, query));
  if (requestedSeason) posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
  return posts.slice(0, MAX_POSTS);
}

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
function unwrapResolverUrl(value, seed = {}) {
  let url = value;
  let index = seed.index ?? null;
  let hash = seed.hash ?? null;
  let count = seed.count ?? null;
  for (let hop = 0; hop < 3; hop += 1) {
    let inner;
    try {
      inner = new URL(url, SELF_URL);
    } catch {
      break;
    }
    if (inner.pathname !== '/resolve' || !inner.searchParams.get('url')) break;
    url = inner.searchParams.get('url');
    index = inner.searchParams.get('i') ?? index;
    hash = inner.searchParams.get('h') ?? hash;
    count = inner.searchParams.get('n') ?? count;
  }
  return { url, index, hash, count };
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

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
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`torrentdosfilmes-resolver :${PORT} — torznab em /api, fonte ${siteSelector.url()} (failover: ${CANDIDATE_HOSTS.join(', ')})`);
  });
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
  siteSelector,
  createSiteSelector,
  isNetworkError,
  postCache,
  inFlight,
};
