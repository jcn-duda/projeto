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
// Busca repete muito (o Stremio refaz a consulta); 5 min evitam re-raspar o
// site a cada retry. Magnet é imutável por definição; 30 min poupam a cadeia
// do protetor inteira a cada play do mesmo botão.
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);
const MAX_CACHE_SIZE = 200;
const MAX_SEARCH_CACHE_SIZE = 100;
const MAX_MAGNET_CACHE_SIZE = 500;
// Teto do fallback do resolvePost. Sem ele, um post com dezenas de botões e o
// protetor fora do ar tenta TODOS a TIMEOUT_MS cada — o Jackett já desistiu em
// JACKETT_DOWNLOAD_TIMEOUT_MS (8s) e a task seguia viva no inFlight.
const MAX_RESOLVE_ATTEMPTS = Number(process.env.MAX_RESOLVE_ATTEMPTS || 5);
// Janela do card na página de busca. Os 4000 fixos truncavam card longo; sem
// teto, o ÚLTIMO card ia até o fim do documento e herdaria img/data do rodapé.
const MAX_CARD_WINDOW = 8000;

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
const searchCache = new Map();
const magnetCache = new Map();
const inFlight = new Map();

// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';

// Faixa "Episódios 01 ao 10" é PACK: quem casa por episódio no addon precisa
// ver episode null, não o 10 (senão vira um episódio de temporada inteira).
const PACK_RESET_PATTERN = /\b(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|\bPACK\b)\b/i;
// Clone global: matchAll exige a flag /g e o original é /i apenas (test()).
const PACK_RESET_PATTERN_G = new RegExp(PACK_RESET_PATTERN.source, 'gi');
const EPISODE_RANGE_PATTERN = /(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\s-]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b/i;
const EPISODE_PATTERN = /(?:EPIS[ÓO]DIO|EP|CAP[ÍI]TULO|CAP)[.\s-]*(\d{1,3})\b|\bS\d{1,2}E(\d{1,3})\b|\bE(\d{1,3})\b|\b\d{1,2}X(\d{1,3})\b/gi;

function extractEpisode(text) {
  if (!text) return null;
  if (EPISODE_RANGE_PATTERN.test(text)) return null;
  const matches = [...String(text).matchAll(EPISODE_PATTERN)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const num = Number(last[1] || last[2] || last[3] || last[4]);
  return Number.isFinite(num) ? num : null;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

// Genérico: hex, decimal e tabela de nomes. O decode antigo de 4 regras deixava
// &#8211;/&hellip; vazarem crus pro Jackett (e pro título da release).
function decodeEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
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

// Decodifica o valor se vier URL-encoded; protetores publicam o magnet nos dois
// formatos (e misturados: %3A na estrutura e & literal entre parâmetros).
function decodeMaybeEncoded(val) {
  if (/^magnet%3A%3F/i.test(val)) {
    try {
      val = decodeURIComponent(val);
    } catch {}
  }
  if (val.startsWith('magnet:?')) return decodeEntities(val);
  return null;
}

function extractMagnet(html) {
  if (!html) return null;
  const str = String(html);

  // 1. Variáveis JavaScript explícitas (DEST_URL, DOWNLOAD_URL, MAGNET_URL,
  // LINK_DOWNLOAD, URL_DOWNLOAD, DOWNLOAD, REDIRECT_URL, NEXT_URL, LINK_FINAL,
  // TARGET_URL, DESTINO, etc.) — com variante URL-encoded dentro das aspas.
  const jsVar = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (jsVar) {
    const magnet = decodeMaybeEncoded(jsVar[1]);
    if (magnet) return magnet;
  }

  // 2. Redirecionamentos / atribuições de navegação JavaScript
  const jsNav = str.match(
    /(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (jsNav) {
    const magnet = decodeMaybeEncoded(jsNav[1]);
    if (magnet) return magnet;
  }

  // 3. Atributos HTML customizados (data-magnet, data-url, data-link,
  // data-href, data-download)
  const attrMatch = str.match(
    /(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (attrMatch) {
    const magnet = decodeMaybeEncoded(attrMatch[1]);
    if (magnet) return magnet;
  }

  // 4. Regex direto de URI magnet no documento
  const rawMatch = str.match(/magnet:\?[^"'<>\s]+/i);
  if (rawMatch) return decodeEntities(rawMatch[0]);

  // 5. Magnet URL-encoded: sem exigir xt como primeiro parâmetro e sem cortar
  // no & (o padrão antigo perdia dn/tr — e magnets com dn antes do xt sumiam).
  const encodedMatch = str.match(/magnet%3A%3F[^"'<>\s]+/i);
  if (encodedMatch) {
    try {
      const decoded = decodeURIComponent(encodedMatch[0]);
      if (decoded.startsWith('magnet:?')) return decodeEntities(decoded);
    } catch {}
  }

  return null;
}

// Meta refresh aparece em três sabores nos protetores: content entre aspas
// duplas, entre aspas simples e sem aspas; url= com aspas aninhadas ou não.
// O regex inline antigo exigia content entre aspas e url= sem aspas — só
// cobria um dos casos.
function extractMetaRefresh(html) {
  if (!html) return null;
  const metaTags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const isRefresh = /\bhttp-equiv\s*=\s*["']?refresh["']?/i.test(tag);
    if (!isRefresh) continue;
    const contentMatch = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!contentMatch) continue;
    const rawContent = contentMatch[1] ?? contentMatch[2] ?? contentMatch[3] ?? '';
    const content = decodeEntities(rawContent);
    const urlMatch = content.match(/\burl\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);
    if (urlMatch) {
      let target = (urlMatch[1] || urlMatch[2] || urlMatch[3] || '').trim();
      target = target.replace(/^['"]|['"]$/g, '');
      if (target) return decodeEntities(target);
    }
  }
  return null;
}

function nextProtectedUrl(html, baseUrl) {
  if (!html) return null;
  const str = String(html);

  // 1. Meta refresh primeiro: é o salto mais comum dos protetores atuais.
  const refreshTarget = extractMetaRefresh(str);
  if (refreshTarget) {
    try {
      const u = new URL(refreshTarget, baseUrl);
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 2. Variável JavaScript apontando para URL HTTP(S) de protetor permitido
  const jsMatch = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|LINK_FINAL|TARGET_URL|DESTINO|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
  );
  if (jsMatch) {
    try {
      const u = new URL(decodeEntities(jsMatch[1]), baseUrl);
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 3. Busca genérica de URLs no corpo HTML apontando para domínios de protetor
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

// Marcadores de trilha: os posts do site usam DUAL ÁUDIO/DUBLADO/LEGENDADO,
// mas temas novos também publicam NACIONAL/PORTUGUÊS/[DUB]/[LEG] na âncora.
const AUDIO_SEGMENT_RE = /(?:VERS[AÃ]O\s+)?(?:MKV\s+|MP4\s+)?(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD\w*|LEGENDAD\w*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b)/gi;
const AUDIO_ANCHOR_RE = /(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD\w*|LEGENDAD\w*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b)/gi;
const LEGENDADO_RE = /LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/i;

// Qualidade e fonte normalizadas: o site publica "UHD"/"Full HD"/"HD"/"SD"
// sem o sufixo p; o parser antigo só entendia \d{3,4}p e 4K. Vale o ÚLTIMO
// token do contexto (segmento + âncora) — o mais próximo do botão.
function extractQualityToken(raw) {
  const token = String(raw || '').toUpperCase().trim();
  if (/\b(?:2160\s*P|4K|UHD)\b/.test(token)) return 2160;
  if (/\b(?:1080\s*P|FULL\s*HD)\b/.test(token)) return 1080;
  if (/\b(?:720\s*P|\bHD\b(?!\s*TV))\b/.test(token)) return 720;
  if (/\b(?:576\s*P)\b/.test(token)) return 576;
  if (/\b(?:480\s*P|\bSD\b)\b/.test(token)) return 480;
  const m = token.match(/\b(\d{3,4})\s*P\b/);
  return m ? Number(m[1]) : null;
}

function normalizeQuality(context) {
  const text = String(context || '').toUpperCase();
  const matches = [...text.matchAll(/\b(2160\s*P|4K|UHD|1080\s*P|FULL\s*HD|720\s*P|\bHD\b(?!\s*TV)|576\s*P|480\s*P|\bSD\b|\d{3,4}\s*P)\b/gi)];
  if (!matches.length) return null;
  return extractQualityToken(matches[matches.length - 1][0]);
}

function extractSourceToken(raw) {
  const token = String(raw || '').toUpperCase().trim();
  if (/\b(?:BDREMUX|REMUX)\b/.test(token)) return 'REMUX';
  if (/\b(?:BLU[- ]?RAY|BLURAY|BD\b|BDRIP)\b/.test(token)) return 'BLU-RAY';
  if (/\b(?:WEB[-. ]?DL)\b/.test(token)) return 'WEB-DL';
  if (/\b(?:WEB[-. ]?RIP|WEBRIP)\b/.test(token)) return 'WEBRIP';
  if (/\bHDTV\b/.test(token)) return 'HDTV';
  if (/\b(?:CAMRIP|CAM)\b/.test(token)) return 'CAM';
  return null;
}

function normalizeSource(context) {
  const text = String(context || '').toUpperCase();
  const matches = [...text.matchAll(/\b(BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BD\b|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM)\b/gi)];
  if (!matches.length) return null;
  return extractSourceToken(matches[matches.length - 1][0]);
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

/**
 * Percorre o post EM ORDEM DE DOCUMENTO mantendo o estado da seção corrente
 * (áudio do <h3> e episódio do segmento) e extrai cada botão Magnet-Link.
 *
 * Metadados que moram NO TEXTO DA ÂNCORA ("S01.1080p | Episódio 01 | Dual
 * Áudio", o layout de magnet direto) valem SÓ para o próprio botão: são
 * calculados locais e não vão para o estado, senão um botão avulso
 * contaminaria todos os seguintes. O segmento continua escrevendo no estado,
 * como sempre fez — é o que preserva a semântica de seção dos posts antigos.
 */
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
    const anchorText = stripTags(m[3]).toUpperCase();
    cursor = anchor.lastIndex;

    // 1. Áudio: o marcador do segmento atualiza o estado (vale para os botões
    // seguintes até a próxima seção); o marcador da âncora é local ao botão.
    const marker = [...segment.matchAll(AUDIO_SEGMENT_RE)].pop();
    if (marker) audio = LEGENDADO_RE.test(marker[1]) ? 'legendado' : 'dublado';
    const selfAudioMarker = [...anchorText.matchAll(AUDIO_ANCHOR_RE)].pop();
    const selfAudio = selfAudioMarker
      ? (LEGENDADO_RE.test(selfAudioMarker[1]) ? 'legendado' : 'dublado')
      : null;

    // 2. Episódio: o segmento escreve no estado; a âncora só decide o botão
    // corrente. Âncora com episódio vence; âncora com marcador de pack zera;
    // senão vale o estado do segmento. Quando os dois sinais convivem no
    // MESMO segmento, desempata pela posição do último marcador — "PACK ...
    // EPISÓDIO 05" vale 5, "EPISÓDIO 05 ... TEMPORADA COMPLETA" vale null.
    const segEp = extractEpisode(segment);
    const segIsPack = PACK_RESET_PATTERN.test(segment) || EPISODE_RANGE_PATTERN.test(segment);
    if (segEp !== null && segIsPack) {
      const lastEpMatches = [...segment.matchAll(EPISODE_PATTERN)];
      const lastPackMatches = [...segment.matchAll(PACK_RESET_PATTERN_G)];
      const lastEpIdx = lastEpMatches.length > 0 ? lastEpMatches[lastEpMatches.length - 1].index : -1;
      const lastPackIdx = lastPackMatches.length > 0 ? lastPackMatches[lastPackMatches.length - 1].index : -1;
      currentEpisode = lastEpIdx > lastPackIdx ? segEp : null;
    } else if (segEp !== null) {
      currentEpisode = segEp;
    } else if (segIsPack) {
      currentEpisode = null;
    }

    const anchorIsPack = PACK_RESET_PATTERN.test(anchorText) || EPISODE_RANGE_PATTERN.test(anchorText);
    const selfEpisode = extractEpisode(anchorText);
    const episode = anchorIsPack ? null : (selfEpisode ?? currentEpisode);

    // 3. Qualidade, fonte e tamanho do contexto (segmento + texto da âncora).
    // O tamanho já sai normalizado aqui ("3.39 GB"): o site cola lixo depois
    // do parêntese ("3.39 GB &#8211; MKV") e cortar no feed chegava tarde —
    // o RSS e o card leem o mesmo campo.
    const context = `${segment} ${anchorText}`;
    const quality = normalizeQuality(context);
    const source = normalizeSource(context);
    const sizeHit = [...context.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)].pop();
    const size = sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null;

    links.push({
      url: href,
      quality,
      size,
      audio: selfAudio || audio,
      episode,
      source,
    });
  }
  return links;
}

const AUDIO_RANK = { dublado: 0, desconhecido: 1, legendado: 2 };

/**
 * Ordena os botões do post: dublado/dual primeiro, maior qualidade depois.
 * ?audio=legendado|dublado força a preferência; ?quality=1080p mira uma
 * qualidade específica (caindo na mais próxima disponível se não houver).
 */
function sortLinks(links, { audio, quality } = {}) {
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
  });
}

function pickBestLink(links, prefs) {
  return sortLinks(links, prefs)[0] || null;
}

async function fetchFollowingAllowed(value, referer) {
  if (!value) throw new Error('invalid_url');
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

    // nextProtectedUrl já testou o meta refresh contra hosts de protetor;
    // aqui ele ainda serve para alvos fora da allowlist virarem erro cedo e
    // para magnet direto dentro do refresh.
    const refreshTarget = extractMetaRefresh(html);
    if (refreshTarget) {
      if (refreshTarget.startsWith('magnet:')) return decodeEntities(refreshTarget);
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(refreshTarget, current).href);
      continue;
    }

    throw new Error('no_magnet');
  }

  throw new Error('too_many_redirects');
}

function setMagnetCache(cacheKey, magnet) {
  magnetCache.set(cacheKey, { value: magnet, expiresAt: Date.now() + MAGNET_CACHE_MS });
  if (magnetCache.size > MAX_MAGNET_CACHE_SIZE) {
    magnetCache.delete(magnetCache.keys().next().value);
  }
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

/**
 * Legado do card Cardigann: resolve em ordem de preferência e só propaga o
 * erro do ÚLTIMO botão tentado — protetor fora do ar num botão não pode matar
 * o post inteiro quando há alternativa. São no máximo MAX_RESOLVE_ATTEMPTS
 * botões: depois disso quem pediu já desistiu, e insistir só queima socket.
 * A chave da cache inclui as preferências: /resolve aceita audio= e quality=,
 * e chave sem prefs serviria o magnet da primeira preferência para quem pediu
 * a segunda.
 */
async function resolvePost(postUrl, prefs = {}) {
  const cacheKey = `magnet:best:${postUrl}:${prefs.audio || ''}:${prefs.quality || ''}`;

  const hit = magnetCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[cache] hit magnet(best) ${postUrl}`);
    return hit.value;
  }
  if (hit) magnetCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const { post, links } = await getPostLinks(postUrl);
    const sorted = sortLinks(links, prefs).slice(0, MAX_RESOLVE_ATTEMPTS);
    if (!sorted.length) throw new Error('no_protector');
    console.log(
      `[resolve] ${links.length} botão(ões), tentando ${sorted.length} em ordem de preferência ${post.pathname}`,
    );
    let lastError;
    for (const link of sorted) {
      try {
        const magnet = await fetchFollowingAllowed(link.url, post.href);
        setMagnetCache(cacheKey, magnet);
        return magnet;
      } catch (error) {
        // Degradação esperada: protetor morre com frequência. Segue o próximo.
        lastError = error;
        console.warn(`[resolve] botão ${link.quality || '?'}p falhou (${error.message}); tentando o próximo`);
      }
    }
    throw lastError || new Error('no_magnet');
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

/**
 * Modo Torznab: resolve o botão de índice fixo (o feed referencia botões por
 * posição). SEM fallback: o índice identifica um botão específico — cair para
 * outro devolveria o torrent errado pro item que o Jackett listou.
 */
async function resolveButton(postUrl, index) {
  const cacheKey = `magnet:${postUrl}:${index}`;

  const hit = magnetCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[cache] hit magnet botão ${index} ${postUrl}`);
    return hit.value;
  }
  if (hit) magnetCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = links[index];
    if (!link) throw new Error('no_such_button');
    console.log(`[dl] botão ${index} → ${link.quality || '?'}p ${link.audio} ${link.size || ''} ${post.pathname}`);
    const magnet = await fetchFollowingAllowed(link.url, post.href);
    setMagnetCache(cacheKey, magnet);
    return magnet;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
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
  // O tema repete card (widget de relacionados) e publica href relativo em
  // alguns temas: dedup por URL resolvida e new URL contra o SITE_URL, senão
  // o assertAllowedUrl descartaria o post inteiro.
  const seen = new Set();
  const re = /<div class="post">[\s\S]*?<div class="title">\s*<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try {
      url = new URL(decodeEntities(m[2].trim()), SITE_URL).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);

    // Janela do card: até o próximo <div class="post">, com teto — card curto
    // não arrasta conteúdo do vizinho, card longo não é truncado pelos 4000
    // fixos de antes, e o ÚLTIMO card não varre o documento inteiro (o rodapé
    // do site tem <img> e data, que vazariam para poster/date).
    const nextPost = html.indexOf('<div class="post">', m.index + 1);
    const end = nextPost === -1 ? html.length : nextPost;
    const block = html.slice(m.index, Math.min(end, m.index + MAX_CARD_WINDOW));
    const poster = block.match(/<img[^>]+src="([^"]+)"/);
    const original = block.match(/T[íi]tulo\s*Original:[^<\n]{0,60}(?:<[^>]+>\s*)?([^<\n]{2,80})/i);
    const date = block.match(/(\d{2}\/\d{2}\/\d{4})/);
    posts.push({
      url,
      title: stripTags(m[3]),
      date: date ? date[1] : null,
      poster: poster ? poster[1] : null,
      original: original ? original[1].trim() : null,
    });
  }
  return posts;
}

// Preserva a ordem do feed: out.push na conclusão fazia a ordem variar entre
// chamadas conforme o timing da rede, e o Stremio reordena a lista toda vez.
async function mapLimit(items, fn) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        output[index] = await fn(items[index]);
      } catch (err) {
        console.warn(`[search] post sem botões (${err.message})`);
        output[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return output.filter(Boolean);
}

// Limpeza do título do post em 7 passos: quem manda são os atributos do
// botão, então a vitrine do site (qualidades, codec, canais de áudio, termos
// de SEO) sai — senão tudo pareceria 4K/Dual Áudio pra quem consome.
function cleanPostTitle(title = '') {
  let clean = decodeEntities(String(title || ''));

  // 1. Remove "Torrent(s)" e separador adjacente (ex: "Torrent – (2024)")
  clean = clean.replace(/\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*/gi, ' ');

  // 2. Remove resoluções (2160p, 1080p, 720p, 576p, 480p, 4K, UHD, etc.)
  clean = clean.replace(/\b(?:2160p|1080p|720p|576p|480p|\d{3,4}p|4K|8K|UHD|ULTRA\s*HD|FULL\s*HD|\bHD\b(?!\s*TV)|\bSD\b)\b/gi, ' ');

  // 3. Remove codecs de vídeo e fontes (BluRay, WEB-DL, Remux, IMAX, etc.)
  clean = clean.replace(/\b(?:BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BDRIP|BRRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM|IMAX|3D|REMASTERED|REMASTER|HDR(?:10\+?)?|DOLBY\s*VISION|DV)\b/gi, ' ');

  // 4. Remove especificações de áudio e canais (5.1, 7.1, 2.0, Atmos, etc.)
  clean = clean.replace(/\b(?:5\.1|7\.1|2\.0|7\.2|DDP\s*5\.1|ATMOS)\b/gi, ' ');

  // 5. Remove tags de áudio e idioma
  clean = clean.replace(/\b(?:Dublado|Dublada|Legendado|Legendada|Dual\s*[AÁ]udio|Nacional|Multi\s*[AÁ]udio|Tri\s*[AÁ]udio|[AÁ]udio\s*Original)\b/gi, ' ');

  // 6. Remove termos de vitrine / SEO
  clean = clean.replace(/\b(?:Download|Baixar|Gr[áa]tis|Online|Completo|Completa|Assistir)\b/gi, ' ');

  // 7. Limpa separadores órfãos / múltiplos e aparas nas bordas
  clean = clean.replace(/\s*[/|–\-—:&+]\s*([/|–\-—:&+]\s*)+/g, ' ');
  clean = clean.replace(/^[–\-—/|:&+\s]+/g, '');
  clean = clean.replace(/[–\-—/|:&+\s]+$/g, '');
  clean = clean.replace(/\s+/g, ' ').trim();

  return clean;
}

/**
 * Título da release: o do post limpo + os atributos do botão na tag. A fonte
 * entra na tag ([720p WEB-DL DUBLADO]) e é removida do título limpo pra não
 * duplicar. Sem tamanho na tag: o card Cardigann já publica <div class="size">.
 */
function releaseTitle(postTitle, link) {
  let clean = cleanPostTitle(postTitle);
  const epPart = link.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const audioTag = link.audio === 'dublado' ? 'DUBLADO' : link.audio === 'legendado' ? 'LEGENDADO' : null;
  if (link.source) {
    const sourceEscaped = link.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-. ]?');
    clean = clean
      .replace(new RegExp(`\\b${sourceEscaped}\\b`, 'gi'), '')
      .replace(/[–\-—/|:&+\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const tag = [link.quality ? `${link.quality}p` : null, link.source, audioTag]
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
 * Busca com cache + coalescing: os DOIS modos (Torznab e Cardigann) passam
 * por aqui. O Stremio repete a mesma consulta em retry; sem cache cada uma
 * re-raspava a página de busca + os 5 posts. A categoria do RSS fica fora da
 * cache (decidida por chamada).
 */
async function searchPosts(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const cacheKey = `search:${normalized}`;

  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[cache] hit search "${normalized}"`);
    return hit.value;
  }
  if (hit) searchCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const html = await fetchText(assertAllowedUrl(`${BLUDV_URL}/?s=${encodeURIComponent(normalized)}`));
    const posts = parsePosts(html).slice(0, MAX_POSTS);
    const chunks = await mapLimit(posts, async (post) => {
      const { links } = await getPostLinks(post.url);
      return links.map((link, index) => ({ post, link, index }));
    });
    const items = chunks.flat();
    searchCache.set(cacheKey, { value: items, expiresAt: Date.now() + SEARCH_CACHE_MS });
    if (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
      searchCache.delete(searchCache.keys().next().value);
    }
    console.log(`[search] "${normalized}" → ${posts.length} post(s), ${items.length} release(s)`);
    return items;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
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
      // Sem tamanho o Jackett descarta a release ("No size provided"); o
      // sentinela satisfaz o Jackett e o addon o esconde (não inventa tamanho).
      // O valor já vem normalizado do parser ("3.39 GB"), sem lixo de entidade.
      const size = link.size || UNKNOWN_SIZE;
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

  const q = url.searchParams.get('q');
  if (!q || !q.trim()) return reply(response, 200, rssXml([], 2000), 'application/xml; charset=utf-8');

  const category = t === 'tvsearch' ? 5000 : 2000;
  try {
    const items = await searchPosts(q);
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
  const q = url.searchParams.get('q');
  if (!q || !q.trim()) return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
  try {
    const items = await searchPosts(q);
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
  sortLinks,
  parsePosts,
  parseSize,
  releaseTitle,
  cleanPostTitle,
  normalizeQuery,
  searchPageHtml,
  assertAllowedUrl,
  extractMagnet,
  extractMetaRefresh,
  extractEpisode,
  nextProtectedUrl,
  decodeEntities,
  normalizeQuality,
  normalizeSource,
  isDetailHost,
  isProtectorHost,
  getPostLinks,
  resolvePost,
  resolveButton,
  searchPosts,
  fetchFollowingAllowed,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};
