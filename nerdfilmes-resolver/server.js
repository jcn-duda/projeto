const http = require('node:http');

const PORT = Number(process.env.PORT || 8702);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const CONCURRENCY = 4;
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 2 * 60_000);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);
// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';
const SELF_URL = (process.env.SELF_URL || 'http://nerdfilmes-resolver:8702').replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || 'https://www.xnerdfilmes.net').replace(/\/$/, '');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

const ALLOWED_SUFFIXES = [
  'xnerdfilmes.net',
  'nerdfilmestorrent.com',
  'nerdfilmestorrent.org',
  'nerdfilmestorrent.net',
  'systemads1.com',
  'systemads.net',
  'videosad.net',
  'canalfutebol.com',
];

const cache = new Map();
const inFlight = new Map();

async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) cache.delete(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const task = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttl });
      if (cache.size > 500) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

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
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  const hostname = url.hostname.toLowerCase();
  const allowed = ALLOWED_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (!allowed) throw new Error('blocked_host');
  return url;
}

async function fetchText(value, referer) {
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

function attribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? decodeEntities(match[1]) : null;
}

function parseSize(text) {
  const match = String(text || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[
    match[2].toUpperCase()
  ];
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

function normalizeSource(value) {
  const source = String(value || '').toUpperCase().replace(/[. ]/g, '-');
  if (source.startsWith('BLU')) return 'BluRay';
  if (source.startsWith('WEB-DL')) return 'WEB-DL';
  if (source.startsWith('WEB-RIP')) return 'WEBRip';
  if (source === 'HDTV') return 'HDTV';
  return null;
}

/** Resultados da busca WordPress: article.col > .item > .image > a. */
function parsePosts(html) {
  const posts = [];
  const article = /<article\b[^>]*class=["'][^"']*\bcol\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = article.exec(html))) {
    const image = match[1].match(
      /<div\b[^>]*class=["'][^"']*\bimage\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    const anchor = image?.[1].match(/<a\b[^>]*>/i);
    const url = anchor ? attribute(anchor[0], 'href') : null;
    const title = anchor ? attribute(anchor[0], 'title') : null;
    if (url && title && !posts.some((post) => post.url === url)) {
      posts.push({ url, title: stripTags(title) });
    }
  }
  return posts;
}

/** Cada botão protegido representa uma qualidade/tamanho diferente. */
function parseDownloadLinks(html) {
  const links = [];
  const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  let cursor = 0;
  while ((match = anchor.exec(html))) {
    const tag = match[0].match(/<a\b[^>]*>/i)?.[0] || '';
    const href = attribute(tag, 'href');
    if (!href || !/(?:systemads|videosad)/i.test(href)) continue;
    const context = stripTags(html.slice(cursor, match.index)).slice(-700);
    cursor = anchor.lastIndex;
    const upper = context.toUpperCase();
    const qualities = [...upper.matchAll(/(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g)];
    const qualityHit = qualities.pop();
    const sizes = [...upper.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)];
    const sizeHit = sizes.pop();
    const audioHits = [...upper.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*)/g)];
    const audioHit = audioHits.pop();
    const sourceHit = [...upper.matchAll(/(WEB[-. ]?DL|WEB[-. ]?RIP|BLU[- ]?RAY|HDTV)/g)].pop();

    links.push({
      url: href,
      quality: qualityHit ? (qualityHit[1] ? Number(qualityHit[1]) : 2160) : null,
      size: sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null,
      audio: audioHit ? (/LEGENDAD/.test(audioHit[1]) ? 'legendado' : 'dublado') : 'desconhecido',
      source: sourceHit ? normalizeSource(sourceHit[1]) : null,
    });
  }
  return links;
}

function parsePostDate(html) {
  const meta = String(html).match(
    /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*>/i,
  );
  const content = meta ? attribute(meta[0], 'content') : null;
  const json = String(html).match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const date = new Date(content || json || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractMagnet(html) {
  const match = String(html).match(/magnet:\?[^"'<>\s]+/i);
  return match ? decodeEntities(match[0]) : null;
}

async function fetchFollowingAllowed(value, referer) {
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
    const html = await response.text();
    const magnet = extractMagnet(html);
    if (magnet) return magnet;
    const refresh = html.match(
      /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i,
    );
    if (!refresh) throw new Error('no_magnet');
    previousReferer = current.href;
    current = assertAllowedUrl(new URL(decodeEntities(refresh[1]), current).href);
  }
  throw new Error('too_many_redirects');
}

async function getPostLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!post.hostname.endsWith('xnerdfilmes.net')) throw new Error('not_detail_page');
  return cached(`post:${post.href}`, POST_CACHE_MS, async () => {
    const { html } = await fetchText(post.href);
    return { post, links: parseDownloadLinks(html), date: parsePostDate(html) };
  });
}

function scoreLink(link) {
  const audio = link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  return audio + Number(link.quality || 0);
}

async function resolveBest(postUrl) {
  return cached(`magnet:best:${postUrl}`, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const ordered = [...links].sort((a, b) => scoreLink(b) - scoreLink(a));
    let lastError;
    for (const link of ordered) {
      try {
        return await fetchFollowingAllowed(link.url, post.href);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no_protector');
  });
}

async function resolveButton(postUrl, index) {
  return cached(`magnet:${postUrl}:${index}`, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = links[index];
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  });
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        output[index] = await fn(items[index]);
      } catch (error) {
        output[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return output.filter(Boolean);
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function releaseTitle(postTitle, link, index = null) {
  const tags = [
    link.quality ? `${link.quality}p` : null,
    link.source,
    link.audio !== 'desconhecido' ? link.audio.toUpperCase() : null,
    link.size || (index == null ? null : `opção ${index + 1}`),
  ].filter(Boolean);
  return tags.length ? `${postTitle} [${tags.join(' ')}]` : postTitle;
}

function searchPageHtml(items) {
  const rows = items
    .map(({ post, link, index }) => {
      const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}`;
      // O Jackett descarta QUALQUER release sem tamanho ("No size provided"), e
      // "0 B" não casa o filtro de `size` do cardigann. UNKNOWN_SIZE satisfaz o
      // Jackett e o addon o esconde em vez de exibir um tamanho inventado.
      return `<div class="release"><div class="title"><a href="${escapeXml(download)}">${escapeXml(releaseTitle(post.title, link, index))}</a></div><div class="size">${escapeXml(link.size || UNKNOWN_SIZE)}</div>${post.date ? `<div class="date">${escapeXml(post.date)}</div>` : ''}<div class="description">${escapeXml(post.title)}</div><div class="seeders">1</div></div>`;
    })
    .join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}

function pubDate(post) {
  const explicit = new Date(post.date || '');
  if (!Number.isNaN(explicit.getTime())) return explicit.toUTCString();
  const year = String(post.title || '').match(/\b((?:19|20)\d{2})\b/)?.[1];
  return new Date(Date.UTC(Number(year || 2000), 0, 1)).toUTCString();
}

function capsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="NerdFilmesTorrent / XNerdFilmes" version="1.0"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,season,ep"/>
    <movie-search available="yes" supportedParams="q"/>
  </searching>
  <categories>
    <category id="2000" name="Movies"/>
    <category id="5000" name="TV"/>
  </categories>
</caps>`;
}

function rssXml(items, category) {
  const body = items
    .map(({ post, link, index }) => {
      const download = `${SELF_URL}/dl?url=${encodeURIComponent(post.url)}&i=${index}`;
      const size = parseSize(link.size) || 0;
      return `    <item>
      <title>${escapeXml(releaseTitle(post.title, link))}</title>
      <guid isPermaLink="false">${escapeXml(download)}</guid>
      <link>${escapeXml(download)}</link>
      <comments>${escapeXml(post.url)}</comments>
      <pubDate>${pubDate(post)}</pubDate>
      <size>${size}</size>
      <category>${category}</category>
      <torznab:attr name="category" value="${category}"/>
      <torznab:attr name="size" value="${size}"/>
      <torznab:attr name="seeders" value="1"/>
      <torznab:attr name="peers" value="1"/>
      <torznab:attr name="downloadvolumefactor" value="0"/>
      <torznab:attr name="uploadvolumefactor" value="1"/>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>NerdFilmesTorrent / XNerdFilmes</title>
${body}
  </channel>
</rss>`;
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

async function handleApi(url, response) {
  const type = url.searchParams.get('t') || 'caps';
  if (type === 'caps') return reply(response, 200, capsXml(), 'application/xml; charset=utf-8');
  if (!['search', 'movie', 'tvsearch'].includes(type)) return reply(response, 400, 'unsupported_t');
  const rawQuery = String(url.searchParams.get('q') || '');
  const requestedSeason = rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const query = rawQuery
    .replace(/[sS]\d{1,2}(?:[eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const category = type === 'tvsearch' ? 5000 : 2000;
  if (!query) return reply(response, 200, rssXml([], category), 'application/xml; charset=utf-8');

  try {
    const xml = await cached(`search:${type}:${rawQuery}`, SEARCH_CACHE_MS, async () => {
      const { html } = await fetchText(`${SITE_URL}/?s=${encodeURIComponent(query)}`);
      let posts = parsePosts(html).slice(0, MAX_POSTS);
      if (requestedSeason) {
        posts = posts.filter((post) => {
          const season = post.title.match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
          return !season || Number(season[1] || season[2]) === Number(requestedSeason[1]);
        });
      }
      const chunks = await mapLimit(posts, CONCURRENCY, async (post) => {
        const { links, date } = await getPostLinks(post.url);
        return links.map((link, index) => ({ post: { ...post, date }, link, index }));
      });
      const seen = new Set();
      const items = chunks.flat().filter(({ post, link }) => {
        const key = `${post.url}|${link.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      console.log(`[api] "${query}" → ${posts.length} post(s), ${items.length} release(s)`);
      return rssXml(items, category);
    });
    return reply(response, 200, xml, 'application/xml; charset=utf-8');
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

async function handleSearch(url, response) {
  const rawQuery = String(url.searchParams.get('q') || '');
  const requestedSeason = rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const query = rawQuery
    .replace(/[sS]\d{1,2}(?:[eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query) return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
  try {
    const html = await cached(`search-html:${rawQuery}`, SEARCH_CACHE_MS, async () => {
      const { html: source } = await fetchText(`${SITE_URL}/?s=${encodeURIComponent(query)}`);
      let posts = parsePosts(source).slice(0, MAX_POSTS);
      if (requestedSeason) {
        posts = posts.filter((post) => {
          const season = post.title.match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
          return !season || Number(season[1] || season[2]) === Number(requestedSeason[1]);
        });
      }
      const chunks = await mapLimit(posts, CONCURRENCY, async (post) => {
        const { links, date } = await getPostLinks(post.url);
        return links.map((link, index) => ({ post: { ...post, date }, link, index }));
      });
      const items = chunks.flat();
      console.log(`[search] "${query}" → ${posts.length} post(s), ${items.length} release(s)`);
      return searchPageHtml(items);
    });
    return reply(response, 200, html, 'text/html; charset=utf-8');
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method !== 'GET') return reply(response, 404, 'not_found');
    if (url.pathname === '/health') return reply(response, 200, 'ok');
    if (url.pathname === '/api') return handleApi(url, response);
    if (url.pathname === '/search') return handleSearch(url, response);
    if (url.pathname === '/resolve') {
      let postUrl = url.searchParams.get('url');
      if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');
      try {
        let index = url.searchParams.get('i');
        // O `download:` do cardigann prefixa /resolve num href que JÁ é
        // /resolve; desempacota quantos níveis vierem. Sem checar a origem: o
        // host varia (`addon` embutido vs. nome do container), e o alvo final
        // passa por assertAllowedUrl de todo jeito.
        for (let hop = 0; hop < 3; hop += 1) {
          let inner;
          try {
            inner = new URL(postUrl, SELF_URL);
          } catch {
            break;
          }
          if (inner.pathname !== '/resolve' || !inner.searchParams.get('url')) break;
          postUrl = inner.searchParams.get('url');
          index = inner.searchParams.get('i') ?? index;
        }
        const button = index == null ? null : Number(index);
        if (button != null && (!Number.isInteger(button) || button < 0)) throw new Error('invalid_index');
        return reply(response, 200, button == null ? await resolveBest(postUrl) : await resolveButton(postUrl, button));
      } catch (error) {
        return reply(response, 502, error.message);
      }
    }
    if (url.pathname === '/dl') {
      const postUrl = url.searchParams.get('url');
      const index = Number(url.searchParams.get('i'));
      if (!postUrl || postUrl.length > 4096 || !Number.isInteger(index) || index < 0) {
        return reply(response, 400, 'invalid_params');
      }
      try {
        const magnet = await resolveButton(postUrl, index);
        response.writeHead(302, { Location: magnet, 'Cache-Control': 'no-store' });
        return response.end();
      } catch (error) {
        return reply(response, 502, error.message);
      }
    }
    return reply(response, 404, 'not_found');
  });
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`nerdfilmes-resolver :${PORT} — torznab em /api, fonte ${SITE_URL}`);
  });
}

module.exports = {
  createServer,
  parsePosts,
  parseDownloadLinks,
  parsePostDate,
  parseSize,
  releaseTitle,
  pubDate,
  searchPageHtml,
};
