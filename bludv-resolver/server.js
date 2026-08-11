const http = require('node:http');

const PORT = Number(process.env.PORT || 8700);
const TIMEOUT_MS = 15_000;
const MAX_HOPS = 6;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';
const ALLOWED_SUFFIXES = [
  'bludvfilmes.xyz',
  'bludv.net',
  'bludv.xyz',
  'bludv.to',
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

function stripTags(value = '') {
  return decodeEntities(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Percorre o post EM ORDEM DE DOCUMENTO mantendo a seção de áudio corrente
 * ("VERSÃO MKV DUAL ÁUDIO" / "VERSÃO MP4 DUBLADO" / "... LEGENDADO") e extrai
 * cada botão Magnet-Link com qualidade e tamanho ("BluRay 1080p (2.67 GB)").
 * Pegar só o primeiro botão do post travaria o indexer na pior release.
 */
function parseDownloadLinks(html) {
  const links = [];
  let audio = 'desconhecido';
  let cursor = 0;

  const anchor = /<a\s+href="(https?:\/\/(?:systemads|videosad)[^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = anchor.exec(html))) {
    const segment = stripTags(html.slice(cursor, m.index)).toUpperCase();
    cursor = anchor.lastIndex;

    const marker = [...segment.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*)/g)].pop();
    if (marker) audio = /LEGENDAD/.test(marker[1]) ? 'legendado' : 'dublado';

    // Último "Np (tamanho)" antes do botão: o do próprio botão — o título do
    // post no topo cita "720p/1080p/4K" sem parêntese e não casa no padrão.
    const spec = [...segment.matchAll(/(\d{3,4})P\s*\(([^)]*)\)/g)].pop();
    links.push({
      url: decodeEntities(m[1]),
      quality: spec ? Number(spec[1]) : null,
      size: spec ? spec[2].trim() : null,
      audio,
    });
  }
  return links;
}

const AUDIO_RANK = { dublado: 0, desconhecido: 1, legendado: 2 };

/**
 * Escolhe o botão do post: dublado/dual primeiro, maior qualidade depois.
 * ?audio=legendado|dublado força a preferência; ?quality=1080p mira uma
 * qualidade específica (caindo na mais próxima disponível se não houver).
 */
function pickBestLink(links, { audio, quality } = {}) {
  // Sem preferência: dublado/dual > desconhecido > legendado. Com preferência
  // explícita, ela vem primeiro e as demais vão pro fim (não pode empatar).
  const rank = audio && AUDIO_RANK[audio] !== undefined
    ? { dublado: 2, desconhecido: 1, legendado: 2, [audio]: 0 }
    : AUDIO_RANK;
  // Cuidado: Number(null) === 0 passaria no isFinite e miraria a PIOR qualidade.
  const wanted = quality > 0 ? Number(quality) : null;

  return [...links].sort((a, b) => {
    const ar = (rank[a.audio] ?? 1) - (rank[b.audio] ?? 1);
    if (ar !== 0) return ar;
    if (wanted && a.quality && b.quality) {
      const qd = Math.abs(a.quality - wanted) - Math.abs(b.quality - wanted);
      if (qd !== 0) return qd;
    }
    return (b.quality || 0) - (a.quality || 0);
  })[0] || null;
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

async function resolvePost(postUrl, prefs) {
  const post = assertAllowedUrl(postUrl);
  const postResponse = await fetch(post, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!postResponse.ok) throw new Error(`http_${postResponse.status}`);

  const links = parseDownloadLinks(await postResponse.text());
  const best = pickBestLink(links, prefs);
  if (!best) throw new Error('no_protector');
  console.log(
    `[resolve] ${links.length} botão(ões) → ${best.quality || '?'}p ${best.audio} ${best.size || ''} ${post.pathname}`,
  );
  return fetchFollowingAllowed(best.url, post.href);
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/health') return reply(response, 200, 'ok');
    if (request.method !== 'GET' || url.pathname !== '/resolve') return reply(response, 404, 'not_found');

    const postUrl = url.searchParams.get('url');
    if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');

    const audio = url.searchParams.get('audio');
    const quality = url.searchParams.get('quality');
    if (audio && !['dublado', 'legendado', 'desconhecido'].includes(audio)) {
      return reply(response, 400, 'invalid_audio');
    }
    if (quality && !/^\d{3,4}p?$/.test(quality)) return reply(response, 400, 'invalid_quality');

    try {
      return reply(
        response,
        200,
        await resolvePost(postUrl, { audio, quality: quality ? parseInt(quality, 10) : null }),
      );
    } catch (error) {
      return reply(response, 502, error.message);
    }
  })
  .listen(PORT, '0.0.0.0');

module.exports = { parseDownloadLinks, pickBestLink };
