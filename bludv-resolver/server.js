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

// --- Modo indexer Torznab ---
// SELF_URL é como o JACKETT alcança este serviço (nome DNS na rede Docker);
// os links de download do feed apontam pra cá e são resolvidos sob demanda.
const SELF_URL = (process.env.SELF_URL || 'http://bludv-resolver:8700').replace(/\/$/, '');
// O site troca de domínio com frequência; alinhar com o links: do cardigann.
const BLUDV_URL = (process.env.BLUDV_URL || 'https://bludvfilmes.xyz').replace(/\/$/, '');
const MAX_POSTS = Number(process.env.BLUDV_MAX_POSTS || 5);
const SEARCH_CONCURRENCY = 4;
// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';

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

/** "3.39 GB" / "897 MB" → bytes. */
function parseSize(text) {
  const m = String(text || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()];
  return Number.isFinite(value) ? Math.round(value * mult) : null;
}

async function fetchText(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}

/**
 * Percorre o post EM ORDEM DE DOCUMENTO mantendo a seção de áudio corrente
 * ("VERSÃO MKV DUAL ÁUDIO" / "VERSÃO MP4 DUBLADO" / "... LEGENDADO") e extrai
 * cada botão Magnet-Link com qualidade e tamanho ("BluRay 1080p (2.67 GB)").
 */
function parseDownloadLinks(html) {
  const links = [];
  let audio = 'desconhecido';
  let currentEpisode = null;
  let cursor = 0;

  const anchor = /<a\s+href="(https?:\/\/(?:systemads|videosad)[^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = anchor.exec(html))) {
    const segment = stripTags(html.slice(cursor, m.index)).toUpperCase();
    cursor = anchor.lastIndex;

    const marker = [...segment.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*)/g)].pop();
    if (marker) audio = /LEGENDAD/.test(marker[1]) ? 'legendado' : 'dublado';

    if (/TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA/i.test(segment)) {
      currentEpisode = null;
    } else {
      const epMatch = [...segment.matchAll(/(?:EPIS[ÓO]DIO|EP)\s*(\d{1,3})\b/gi)].pop();
      if (epMatch) {
        currentEpisode = Number(epMatch[1]);
      }
    }

    // Último "Np ... (tamanho)" antes do botão: o do próprio botão — o título do
    // post no topo cita "720p/1080p/4K" sem parêntese e não casa no padrão.
    // Entre a qualidade e o parêntese pode haver codec/HDR: "2160p x265 DV (24 GB)".
    const spec = [...segment.matchAll(/(?:(\d{3,4})\s*P|\b(4K)\b)[^()\n]{0,30}?\(([^)]*)\)/g)].pop();
    links.push({
      url: decodeEntities(m[1]),
      quality: spec ? (spec[1] ? Number(spec[1]) : 2160) : null,
      size: spec ? spec[3].trim() : null,
      audio,
      episode: currentEpisode,
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

async function getPostLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  const html = await fetchText(post);
  return { post, links: parseDownloadLinks(html) };
}

/** Legado do card Cardigann: resolve o MELHOR botão e devolve o magnet como texto. */
async function resolvePost(postUrl, prefs) {
  const { post, links } = await getPostLinks(postUrl);
  const best = pickBestLink(links, prefs);
  if (!best) throw new Error('no_protector');
  console.log(
    `[resolve] ${links.length} botão(ões) → ${best.quality || '?'}p ${best.audio} ${best.size || ''} ${post.pathname}`,
  );
  return fetchFollowingAllowed(best.url, post.href);
}

/** Modo Torznab: resolve o botão de índice fixo (o feed referencia botões por posição). */
async function resolveButton(postUrl, index) {
  const { post, links } = await getPostLinks(postUrl);
  const link = links[index];
  if (!link) throw new Error('no_such_button');
  console.log(`[dl] botão ${index} → ${link.quality || '?'}p ${link.audio} ${link.size || ''} ${post.pathname}`);
  return fetchFollowingAllowed(link.url, post.href);
}

// --- Indexer Torznab ---

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mesma saída da escapeXml: serve tanto para XML quanto para HTML (texto/atributo). */
function escapeHtml(value = '') {
  return escapeXml(value);
}
/** Cards da página de busca: div.post > div.title > a + bloco .content com
 * poster (img), "Título Original" e a data de .icon .infos. */
function parsePosts(html) {
  const posts = [];
  const re = /<div class="post">[\s\S]*?<div class="title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    // Janela do card: título + conteúdo + data ficam bem dentro de 4000 chars.
    const block = html.slice(m.index, m.index + 4000);
    const poster = block.match(/<img[^>]+src="([^"]+)"/);
    const original = block.match(/T[íi]tulo\s*Original:[^<\n]{0,60}(?:<[^>]+>\s*)?([^<\n]{2,80})/i);
    const date = block.match(/(\d{2}\/\d{2}\/\d{4})/);
    posts.push({
      url: decodeEntities(m[1]),
      title: stripTags(m[2]),
      date: date ? date[1] : null,
      poster: poster ? poster[1] : null,
      original: original ? original[1].trim() : null,
    });
  }
  return posts;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out.push(await fn(items[idx]));
      } catch (err) {
        out.push(null);
      }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

/**
 * Título da release: o do post menos a lista de qualidades ("720p/1080p/4K") —
 * quem manda é a qualidade do botão, senão tudo pareceria 4K pra quem consome.
 */
function releaseTitle(postTitle, link) {
  const clean = postTitle
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)\s*/gi, ' ')
    .replace(/\b\d{3,4}p(?:\s*\/\s*(?:\d{3,4}p|4K))+/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    // Palavras de vitrine do site: quem manda são os atributos do botão.
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const epPart = link.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const audioTag = link.audio === 'dublado' ? 'DUBLADO' : link.audio === 'legendado' ? 'LEGENDADO' : null;
  const tag = [link.quality ? `${link.quality}p` : null, audioTag]
    .filter(Boolean)
    .join(' ');
  const base = epPart ? `${clean} ${epPart}` : clean;
  return tag ? `${base} [${tag}]` : base;
}

function pubDate(date) {
  const m = String(date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date().toUTCString();
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).toUTCString();
}

/**
 * Página HTML sintética consumida pelo card Cardigann do Jackett: o motor
 * Cardigann é 1:1 com os resultados da busca, então cada BOTÃO do post vira
 * uma linha própria (qualidade/áudio/tamanho reais). O href do download já
 * carrega o índice exato do botão, resolvido por /resolve?i= no ato.
 */
function searchPageHtml(items) {
  const rows = items
    .map(({ post, link, index }) => {
      const dl = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}`;
      // O tamanho do botão às vezes vem com lixo: "3.39 GB &#8211; MKV".
      // Sem tamanho o Jackett descarta a release ("No size provided"); o
      // sentinela satisfaz o Jackett e o addon o esconde (não inventa tamanho).
      const size = String(link.size || '').replace(/\s+&#?\w+;.*/i, '').trim() || UNKNOWN_SIZE;
      return `  <div class="release">
    <div class="title"><a href="${escapeHtml(dl)}">${escapeHtml(releaseTitle(post.title, link))}</a></div>
    <div class="size">${escapeHtml(size)}</div>
    ${post.date ? `<div class="date">${escapeHtml(post.date)}</div>` : ''}
    ${post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}" alt=""></div>` : ''}
    ${post.original ? `<div class="description">${escapeHtml(post.original)}</div>` : ''}
    <div class="seeders">1</div>
  </div>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>BLUDV (resolver)</title></head>
<body><div class="posts">
${rows}
</div></body></html>`;
}

function capsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="BLUDV (resolver)" version="1.0"/>
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
      const dl = `${SELF_URL}/dl?url=${encodeURIComponent(post.url)}&i=${index}`;
      const size = parseSize(link.size) || 0;
      return `    <item>
      <title>${escapeXml(releaseTitle(post.title, link))}</title>
      <guid isPermaLink="false">${escapeXml(dl)}</guid>
      <link>${escapeXml(dl)}</link>
      <comments>${escapeXml(post.url)}</comments>
      <pubDate>${pubDate(post.date)}</pubDate>
      <size>${size}</size>
      <description>${escapeXml(post.title)}</description>
      <category>${category}</category>
      <torznab:attr name="category" value="${category}"/>
      <torznab:attr name="size" value="${size}"/>
      <!-- O BLUDV não publica seeds; 1 neutro pra não ser descartado por filtros. -->
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
    <title>BLUDV (resolver)</title>
${body}
  </channel>
</rss>`;
}

async function handleApi(url, response) {
  const t = url.searchParams.get('t') || 'caps';
  if (t === 'caps') return reply(response, 200, capsXml(), 'application/xml; charset=utf-8');
  if (!['search', 'movie', 'tvsearch'].includes(t)) return reply(response, 400, 'unsupported_t');

  // "Nome S01E01" → "Nome"; o buscador WordPress engasga com ":" (vide o scraper
  // nativo do addon). Ano ajuda a relevância, então fica.
  const q = String(url.searchParams.get('q') || '')
    .replace(/[sS]\d{1,2}([eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return reply(response, 200, rssXml([], 2000), 'application/xml; charset=utf-8');

  const category = t === 'tvsearch' ? 5000 : 2000;
  try {
    const html = await fetchText(assertAllowedUrl(`${BLUDV_URL}/?s=${encodeURIComponent(q)}`));
    const posts = parsePosts(html).slice(0, MAX_POSTS);
    const chunks = await mapLimit(posts, SEARCH_CONCURRENCY, async (post) => {
      const { links } = await getPostLinks(post.url);
      return links.map((link, index) => ({ post, link, index }));
    });
    const items = chunks.flat();
    console.log(`[api] "${q}" → ${posts.length} post(s), ${items.length} release(s)`);
    return reply(response, 200, rssXml(items, category), 'application/xml; charset=utf-8');
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

async function handleDl(url, response) {
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

async function handleSearch(url, response) {
  // Mesma normalização do Torznab: "Nome S01E01" → "Nome", sem ":" no buscador.
  const q = String(url.searchParams.get('q') || '')
    .replace(/[sS]\d{1,2}([eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
  try {
    const html = await fetchText(assertAllowedUrl(`${BLUDV_URL}/?s=${encodeURIComponent(q)}`));
    const posts = parsePosts(html).slice(0, MAX_POSTS);
    const chunks = await mapLimit(posts, SEARCH_CONCURRENCY, async (post) => {
      const { links } = await getPostLinks(post.url);
      return links.map((link, index) => ({ post, link, index }));
    });
    const items = chunks.flat();
    console.log(`[search] "${q}" → ${posts.length} post(s), ${items.length} release(s)`);
    return reply(response, 200, searchPageHtml(items), 'text/html; charset=utf-8');
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

async function handleResolve(url, response) {
  let postUrl = url.searchParams.get('url');
  if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');
  let audio = url.searchParams.get('audio');
  let quality = url.searchParams.get('quality');
  let index = url.searchParams.get('i');

  // O download.before do Cardigann encoda a href inteira no param url
  // (ex.: http://bludv-resolver:8700/resolve?url=<post>&i=3); desempacota.
  let inner = null;
  try {
    inner = new URL(postUrl, SELF_URL);
  } catch {
    // URL inválida: deixa como está, o assertAllowedUrl rejeita lá na frente.
  }
  if (inner && (inner.pathname === '/resolve' || inner.pathname === '/dl')) {
    postUrl = inner.searchParams.get('url') || postUrl;
    audio = inner.searchParams.get('audio') || audio;
    quality = inner.searchParams.get('quality') || quality;
    index = inner.searchParams.get('i') || index;
  }

  if (audio && !['dublado', 'legendado', 'desconhecido'].includes(audio)) {
    return reply(response, 400, 'invalid_audio');
  }
  if (quality && !/^\d{3,4}p?$/.test(quality)) return reply(response, 400, 'invalid_quality');
  const hasIndex = index !== null && index !== undefined && index !== '';
  const wantedIndex = hasIndex ? Number(index) : -1;
  if (hasIndex && (!Number.isInteger(wantedIndex) || wantedIndex < 0)) {
    return reply(response, 400, 'invalid_index');
  }

  try {
    const magnet = hasIndex
      ? await resolveButton(postUrl, wantedIndex)
      : await resolvePost(postUrl, { audio, quality: quality ? parseInt(quality, 10) : null });
    return reply(response, 200, magnet);
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method !== 'GET') return reply(response, 404, 'not_found');
    if (url.pathname === '/health') return reply(response, 200, 'ok');
    if (url.pathname === '/api') return handleApi(url, response);
    if (url.pathname === '/dl') return handleDl(url, response);
    if (url.pathname === '/search') return handleSearch(url, response);
    if (url.pathname === '/resolve') return handleResolve(url, response);
    return reply(response, 404, 'not_found');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`bludv-resolver :${PORT} — torznab em /api, fonte ${BLUDV_URL}`);
  });

module.exports = { parseDownloadLinks, pickBestLink, parsePosts, parseSize, releaseTitle };
