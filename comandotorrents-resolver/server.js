const http = require('node:http');

const PORT = Number(process.env.PORT || 8701);
const TIMEOUT_MS = 15_000;
const MAX_HOPS = 6;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';
const ALLOWED_SUFFIXES = [
  'comandotorrents.to',
  'systemads1.com',
  'systemads.net',
  'videosad.net',
  'canalfutebol.com',
];

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#0?38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#039;|&apos;/gi, "'");
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

function extractMagnet(html) {
  const match = String(html).match(/magnet:\?[^"'<>\s]+/i);
  return match ? decodeEntities(match[0]) : null;
}

function rankProtectedLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"']*(?:systemads|videosad)[^"']*)["'][^>]*>/gi;
  let match;
  let cursor = 0;

  while ((match = pattern.exec(html))) {
    const context = decodeEntities(html.slice(cursor, match.index)).replace(/<[^>]+>/g, ' ').toUpperCase();
    cursor = pattern.lastIndex;
    let score = 0;
    if (/DUBLAD|DUAL\s*ÁUDIO|PORTUGU[ÊE]S/.test(context)) score += 100;
    if (/LEGENDAD/.test(context)) score -= 100;
    if (/2160P|4K/.test(context)) score += 30;
    else if (/1080P/.test(context)) score += 20;
    else if (/720P/.test(context)) score += 10;
    links.push({ url: new URL(decodeEntities(match[1]), baseUrl).href, score, position: links.length });
  }

  return links.sort((a, b) => b.score - a.score || a.position - b.position);
}

async function fetchFollowingAllowed(url, referer) {
  let current = assertAllowedUrl(url);
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

    const refresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i);
    if (!refresh) throw new Error('no_magnet');
    previousReferer = current.href;
    current = assertAllowedUrl(new URL(decodeEntities(refresh[1]), current).href);
  }
  throw new Error('too_many_redirects');
}

async function resolvePost(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!post.hostname.endsWith('comandotorrents.to')) throw new Error('not_detail_page');
  const response = await fetch(post, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const links = rankProtectedLinks(await response.text(), post.href);
  if (links.length === 0) throw new Error('no_protector');

  let lastError;
  for (const link of links) {
    try {
      return await fetchFollowingAllowed(link.url, post.href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('no_magnet');
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/health') return reply(response, 200, 'ok');
    if (request.method !== 'GET' || url.pathname !== '/resolve') return reply(response, 404, 'not_found');
    const postUrl = url.searchParams.get('url');
    if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');
    try {
      return reply(response, 200, await resolvePost(postUrl));
    } catch (error) {
      return reply(response, 502, error.message);
    }
  })
  .listen(PORT, '0.0.0.0');
