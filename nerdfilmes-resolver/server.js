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
const SITE_URL = (process.env.SITE_URL || process.env.NERDFILMES_URL || 'https://www.xnerdfilmes.net').replace(/\/$/, '');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

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
  'xnerdfilmes.net',
  'nerdfilmestorrent.com',
  'nerdfilmestorrent.org',
  'nerdfilmestorrent.net',
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

function isDetailHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (SITE_HOST && (host === SITE_HOST || host.endsWith(`.${SITE_HOST}`))) return true;
  return FALLBACK_SITE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isProtectorHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALL_PROTECTOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
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

function cleanPostTitle(title = '') {
  return String(title)
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)?\s*/gi, ' ')
    .replace(/\b(?:720p|1080p|2160p|4K)(?:\s*\/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cada botão protegido representa uma qualidade/tamanho diferente. */
function parseDownloadLinks(html) {
  const links = [];
  const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  let cursor = 0;
  let currentAudio = 'desconhecido';
  let currentEpisode = null;

  while ((match = anchor.exec(html))) {
    const tag = match[0].match(/<a\b[^>]*>/i)?.[0] || '';
    const rawHref = attribute(tag, 'href');
    if (!rawHref) continue;
    const href = decodeEntities(rawHref);
    let u;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (!isProtectorHost(u.hostname)) continue;
    const rawSegment = html.slice(cursor, match.index);
    const segment = stripTags(rawSegment).toUpperCase();
    const anchorText = stripTags(match[0]).toUpperCase();
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
    const qualities = [...context.matchAll(/(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g)];
    const qualityHit = qualities.pop();
    const sizes = [...context.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)];
    const sizeHit = sizes.pop();
    const sourceHit = [...context.matchAll(/(WEB[-. ]?DL|WEB[-. ]?RIP|BLU[- ]?RAY|HDTV)/g)].pop();

    links.push({
      url: href,
      quality: qualityHit ? (qualityHit[1] ? Number(qualityHit[1]) : 2160) : null,
      size: sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null,
      audio: currentAudio,
      episode: currentEpisode,
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
    const refresh = html.match(
      /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i,
    );
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
  const clean = cleanPostTitle(typeof postTitle === 'string' ? postTitle : postTitle?.title || '');
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
  assertAllowedUrl,
  extractMagnet,
  nextProtectedUrl,
  isDetailHost,
  isProtectorHost,
  getPostLinks,
  fetchFollowingAllowed,
  cache,
  inFlight,
};
