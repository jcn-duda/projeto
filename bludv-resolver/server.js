const http = require('node:http');

const PORT = Number(process.env.PORT || 8700);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

// --- Modo indexer Torznab ---
// SELF_URL é como o JACKETT alcança este serviço (nome DNS na rede Docker);
// os links de download do feed apontam pra cá e são resolvidos sob demanda.
const SELF_URL = (process.env.SELF_URL || 'http://bludv-resolver:8700').replace(/\/$/, '');
// O site troca de domínio com frequência; alinhar com o links: do cardigann.
const SITE_URL = (process.env.SITE_URL || process.env.BLUDV_URL || 'https://bludvfilmes.xyz').replace(/\/$/, '');
const BLUDV_URL = SITE_URL;
const MAX_POSTS = Number(process.env.BLUDV_MAX_POSTS || 5);
const SEARCH_CONCURRENCY = 4;
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const MAX_CACHE_SIZE = 200;

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
  'bludvfilmes.xyz',
  'bludv.net',
  'bludv.xyz',
  'bludv.to',
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
const QUALITY_RE = /(?:(\d{3,4})\s*P|\b(4K)\b)/gi;

/** Maior qualidade declarada num texto ("BluRay 1080p" ou "720p/1080p/2160p"). */
function maxQualityFromText(text) {
  let best = null;
  for (const mm of String(text || '').matchAll(QUALITY_RE)) {
    const q = mm[1] ? Number(mm[1]) : 2160;
    if (best === null || q > best) best = q;
  }
  return best;
}

/** Hash btih válido: 40 hex ou 32 base32 (alfabeto A-Z2-7), case-insensitive. */
function isValidBtihHash(hash) {
  const h = String(hash || '').trim();
  return /^[0-9a-f]{40}$/i.test(h) || /^[a-z2-7]{32}$/i.test(h);
}

/**
 * Magnet direto só vale com parâmetro xt=urn:btih: de hash válido, em
 * QUALQUER posição da query. Sem btih — nem só btmh (urn:btmh: é SHA-256,
 * inadequado pra resolver por infoHash) — ou com btih malformado o link é
 * ignorado: o prefixo "magnet:" sozinho não basta.
 */
function isValidMagnetUri(value) {
  const str = String(value || '');
  if (!/^magnet:/i.test(str)) return false;
  const q = str.indexOf('?');
  const query = q === -1 ? '' : str.slice(q + 1);
  let found = false;
  for (const param of query.split('&')) {
    const m = param.match(/^xt\s*=\s*urn:btih:([^;&\s]+)/i);
    if (!m) continue;
    if (!isValidBtihHash(m[1])) return false;
    found = true;
  }
  return found;
}

function parseDownloadLinks(html) {
  const links = [];
  let audio = 'desconhecido';
  let currentEpisode = null;
  let cursor = 0;

  // O post novo (House of the Dragon S1) publica 57 botões com href magnet
  // direto, e o tema emite aspas simples e atributos antes do href. O padrão
  // aceita os dois protocolos e os dois tipos de aspas; só entra magnet com
  // btih válido, http(s) continua exigindo host de protetor permitido abaixo.
  const anchor = /<a\s+[^>]*?href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(html))) {
    // A URI decodificada É o download: o magnet resolve no cliente de torrent,
    // sem fetch — o href vira o url do botão direto.
    const href = decodeEntities(m[2].trim());
    // Magnet malformado, sem btih ou só com btmh cai no branch http e morre no
    // allowlist (hostname do magnet é vazio, nunca é protetor).
    const isMagnet = isValidMagnetUri(href);
    if (!isMagnet) {
      let u;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (!isProtectorHost(u.hostname)) continue;
    }

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
    // Entre a qualidade e o parêntese pode haver codec/HDR/áudio longos:
    // "2160p x265 DV HDR10+ DDP5.1 Atmos (24 GB)" — janela curta demais
    // solta o par e o tamanho vira sentinela "1 KB".
    const spec = [...segment.matchAll(/(?:(\d{3,4})\s*P|\b(4K)\b)[^()\n]{0,48}?\(([^)]*)\)/g)].pop();
    let quality = null;
    let size = null;
    if (spec) {
      quality = spec[1] ? Number(spec[1]) : 2160;
      size = spec[3].trim();
    } else {
      // Botão sem parêntese (o magnet direto não publica tamanho): a qualidade
      // vem do texto do próprio link ("720p"/"1080p"/"2160p") em vez do segmento.
      quality = maxQualityFromText(stripTags(m[3]));
    }

    links.push({
      url: href,
      quality,
      size,
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

  const hit = postCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  if (hit) {
    postCache.delete(cacheKey);
  }

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const task = (async () => {
    const html = await fetchText(post);
    const value = { post, links: parseDownloadLinks(html) };
    postCache.set(cacheKey, { value, expiresAt: Date.now() + POST_CACHE_MS });
    if (postCache.size > MAX_CACHE_SIZE) {
      const oldestKey = postCache.keys().next().value;
      postCache.delete(oldestKey);
    }
    return value;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
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
  const re = /<div class="post">[\s\S]*?<div class="title">\s*<a\s+[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
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
 * "Nome S01E01" → "Nome"; o buscador WordPress engasga com ":" (vide o scraper
 * nativo do addon). Ano ajuda a relevância, então fica.
 *
 * As fronteiras \\b são obrigatórias: sem elas o strip comia pedaço de título
 * com S+número dentro de palavra ("S1m0ne" virava "m0ne" e a busca zerava).
 * Usada pelos DOIS modos (Torznab e Cardigann) para não divergirem.
 */
function normalizeQuery(raw) {
  return String(raw || '')
    .replace(/\bS\d{1,2}(?:E\d{1,2})?\b/gi, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  const q = normalizeQuery(url.searchParams.get('q'));
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
  // Mesma normalização do Torznab — função única para os dois modos não derivarem.
  const q = normalizeQuery(url.searchParams.get('q'));
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

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method !== 'GET') return reply(response, 404, 'not_found');
    if (url.pathname === '/health') return reply(response, 200, 'ok');
    if (url.pathname === '/api') return handleApi(url, response);
    if (url.pathname === '/dl') return handleDl(url, response);
    if (url.pathname === '/search') return handleSearch(url, response);
    if (url.pathname === '/resolve') return handleResolve(url, response);
    return reply(response, 404, 'not_found');
  });
}

// Mesmo desenho do nerdfilmes: quem sobe o servidor é o processo principal ou o
// src/br-resolvers.js (que já chama createServer quando o módulo o exporta).
// Abrir a porta no require deixava o parser impossível de exercitar em teste
// sem tomar a 8700 de quem estivesse rodando.
if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`bludv-resolver :${PORT} — torznab em /api, fonte ${BLUDV_URL}`);
  });
}

module.exports = {
  createServer,
  parseDownloadLinks,
  pickBestLink,
  parsePosts,
  parseSize,
  releaseTitle,
  normalizeQuery,
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
