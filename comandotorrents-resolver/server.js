const http = require('node:http');

const PORT = Number(process.env.PORT || 8701);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const CONCURRENCY = 3;
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SELF_URL = (process.env.SELF_URL || 'http://comandotorrents-resolver:8701').replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || process.env.COMANDOTORRENTS_URL || 'https://comandotorrents.to').replace(/\/$/, '');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

function parseHost(urlString) {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parseExtraProtectors(envVal) {
  if (!envVal || !String(envVal).trim()) return [];
  return String(envVal)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const SITE_HOST = parseHost(SITE_URL);
const FALLBACK_SITE_SUFFIXES = [
  'comandotorrents.to',
  'comandotorrents.net',
  'comandotorrents.org',
];

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
    ...(SITE_HOST ? [SITE_HOST] : []),
    ...FALLBACK_SITE_SUFFIXES,
    ...ALL_PROTECTOR_SUFFIXES,
  ]),
);

const postCache = new Map();
const inFlight = new Map();

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

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attribute(tag, name) {
  return String(tag).match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || null;
}

function assertAllowedUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new Error('blocked_host');
  }
  return url;
}

function isDetailHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (SITE_HOST && (host === SITE_HOST || host.endsWith(`.${SITE_HOST}`))) return true;
  return FALLBACK_SITE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isProtectorHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALL_PROTECTOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function normalizeQuery(value) {
  return String(value || '')
    .replace(/[sS]\d{1,2}(?:[eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function parsePosts(html) {
  const posts = [];
  const article = /<article\b[^>]*class=["'][^"']*\bblog-view\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = article.exec(html))) {
    const anchor = match[1].match(/<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = attribute(anchor[1], 'href');
    if (!url) continue;
    const image = match[1].match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || null;
    posts.push({
      url: new URL(decodeEntities(url), SITE_URL).href,
      title: stripTags(attribute(anchor[1], 'title') || anchor[2]),
      poster: image && decodeEntities(image),
    });
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

function parseDownloadLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let cursor = 0;
  let currentAudio = 'desconhecido';
  let currentEpisode = null;

  while ((match = pattern.exec(html))) {
    const rawHref = decodeEntities(match[1]);
    let resolvedUrl;
    try {
      resolvedUrl = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }

    let targetHost = resolvedUrl.hostname;
    const toParam = resolvedUrl.searchParams.get('to');
    if (toParam) {
      try {
        targetHost = new URL(decodeEntities(toParam)).hostname;
      } catch {}
    }
    if (!isProtectorHost(targetHost)) continue;

    const rawSegment = html.slice(cursor, match.index);
    const segment = stripTags(rawSegment).toUpperCase();
    const anchorText = stripTags(match[2] || '').toUpperCase();
    cursor = pattern.lastIndex;

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
      url: resolvedUrl.href,
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
    if (refresh) {
      const refreshTarget = decodeEntities(refresh[1]);
      if (refreshTarget.startsWith('magnet:')) return refreshTarget;
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(refreshTarget, current).href);
      continue;
    }

    throw new Error('no_magnet');
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
    const value = { post, links: parseDownloadLinks(await response.text(), post.href) };
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
  return (link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000) + (link.quality || 0);
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

async function resolveButton(postUrl, index) {
  const { post, links } = await getPostLinks(postUrl);
  if (!Number.isInteger(index) || index < 0 || !links[index]) throw new Error('no_such_button');
  return fetchFollowingAllowed(links[index].url, post.href);
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

function searchPageHtml(items) {
  const rows = items.map(({ post, link, index }) => {
    const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}`;
    // O Jackett descarta QUALQUER release sem tamanho ("No size provided"), e
    // "0 B" não casa o filtro de `size` do cardigann — era assim que os posts de
    // pack (que não publicam tamanho por botão) perdiam releases em lote.
    // UNKNOWN_SIZE satisfaz o Jackett e o addon o esconde em vez de exibir um
    // tamanho inventado.
    return `<div class="release"><div class="title"><a href="${escapeHtml(download)}">${escapeHtml(releaseTitle(post, link, index))}</a></div><div class="size">${escapeHtml(link.size || UNKNOWN_SIZE)}</div>${post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}"></div>` : ''}<div class="description">${escapeHtml(post.title)}</div><div class="seeders">1</div></div>`;
  }).join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

/**
 * O `download:` do cardigann prefixa /resolve num href que JÁ é /resolve;
 * desempacota quantos níveis vierem. Sem checar a origem: o host varia (`addon`
 * embutido vs. nome do container), e o alvo final passa por assertAllowedUrl.
 */
function unwrapResolverUrl(value) {
  let url = value;
  let index = null;
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
  }
  return { url, index };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method !== 'GET') return reply(response, 404, 'not_found');
  if (url.pathname === '/health') return reply(response, 200, 'ok');
  if (url.pathname === '/search') {
    const query = normalizeQuery(url.searchParams.get('q'));
    if (!query) return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
    try {
      const source = await fetch(`${SITE_URL}/?s=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!source.ok) throw new Error(`http_${source.status}`);
      const posts = parsePosts(await source.text()).slice(0, MAX_POSTS);
      const chunks = await mapLimit(posts, async (post) => {
        const { links } = await getPostLinks(post.url);
        return links.map((link, index) => ({ post, link, index }));
      });
      const items = chunks.flat();
      console.log(`[search] ${posts.length} post(s) -> ${items.length} release(s)`);
      return reply(response, 200, searchPageHtml(items), 'text/html; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  if (url.pathname === '/resolve') {
    const value = url.searchParams.get('url');
    if (!value || value.length > 4096) return reply(response, 400, 'invalid_url');
    try {
      const unwrapped = unwrapResolverUrl(value);
      const index = unwrapped.index == null ? null : Number(unwrapped.index);
      return reply(
        response,
        200,
        index == null ? await resolveBest(unwrapped.url) : await resolveButton(unwrapped.url, index),
      );
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  return reply(response, 404, 'not_found');
}

function createServer() {
  return http.createServer(handleRequest);
}

// Quem sobe o servidor é o processo principal ou o src/br-resolvers.js, que já
// chama createServer quando o módulo o exporta. Abrir a porta no require
// deixava o parser impossível de exercitar em teste sem tomar a 8701.
if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0');
}

module.exports = {
  createServer,
  parsePosts,
  parseDownloadLinks,
  releaseTitle,
  searchPageHtml,
  assertAllowedUrl,
  extractMagnet,
  nextProtectedUrl,
  isDetailHost,
  isProtectorHost,
  getPostLinks,
  fetchFollowingAllowed,
  postCache,
  inFlight,
};
