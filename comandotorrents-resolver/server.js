const http = require('node:http');

const PORT = Number(process.env.PORT || 8701);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const CONCURRENCY = 3;
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);
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

const FALLBACK_SITE_SUFFIXES = [
  'comandotorrents.to',
  'comandotorrents.net',
  'comandotorrents.org',
];

// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// COMANDOTORRENTS_URLS) como candidatos ATIVOS, não só allowlist: quando a
// busca falha por erro de rede (DNS/conexão/timeout — HTTP de erro prova que
// o host respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o
// primeiro candidato que responda 2xx. O vencedor fica imune a novo probe
// por BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
function isNetworkError(err) {
  if (!err) return false;
  const message = String(err.message || err);
  return !/^(?:http_|blocked_host|unsupported_protocol|missing_redirect|not_detail_page|no_magnet|too_many_redirects)/.test(message);
}

function createSiteSelector(tag, envUrlsCsv, primaryUrl, fallbackHosts) {
  const fromCsv = String(envUrlsCsv || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const candidates = [];
  const seen = new Set();
  for (const url of [primaryUrl, ...fromCsv, ...fallbackHosts.map((host) => `https://${host}`)]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push(url);
  }

  const ttlMs = Number(process.env.BR_DOMAIN_PROBE_TTL_MS || 30 * 60_000);
  const failsBeforeProbe = Number(process.env.BR_DOMAIN_FAILS_BEFORE_PROBE || 2);
  // Probe leve, mas cada candidato morto custa este timeout inteiro.
  const PROBE_TIMEOUT_MS = 5_000;

  let current = candidates[0];
  // 0 = nunca sondado: o primário configurado é confiável até buscas de
  // verdade falharem (nada de probe preventivo no boot).
  let lastProbeAt = 0;
  let consecutiveFails = 0;
  let probing = null;
  const changeListeners = [];

  function hosts() {
    return Array.from(new Set(candidates.map((url) => parseHost(url)).filter(Boolean)));
  }

  async function probe() {
    for (const url of candidates) {
      try {
        const response = await fetch(`${url}/?s=teste`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
          redirect: 'follow',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.ok) return url;
      } catch {}
    }
    return null;
  }

  async function noteFailure() {
    consecutiveFails += 1;
    // Abaixo do limiar de falhas, ou dentro do TTL do último probe, mantém o
    // vencedor: sonda em rajada só queima orçamento com site caído.
    if (consecutiveFails < failsBeforeProbe) return current;
    if (Date.now() - lastProbeAt < ttlMs) return current;
    if (candidates.length <= 1) return current;
    if (probing) return probing;
    probing = (async () => {
      try {
        const winner = await probe();
        lastProbeAt = Date.now();
        consecutiveFails = 0;
        if (winner && winner !== current) {
          console.log(`${tag} domínio ativo mudou: ${current} → ${winner}`);
          current = winner;
          for (const listener of changeListeners) {
            try {
              listener(current);
            } catch {}
          }
        }
        return current;
      } finally {
        probing = null;
      }
    })();
    return probing;
  }

  function noteSuccess() {
    consecutiveFails = 0;
  }

  return {
    url: () => current,
    hosts,
    noteFailure,
    noteSuccess,
    onDomainChange(listener) {
      changeListeners.push(listener);
    },
  };
}

const siteSelector = createSiteSelector('[comandotorrents]', process.env.COMANDOTORRENTS_URLS, SITE_URL, FALLBACK_SITE_SUFFIXES);
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
const searchCache = new Map();
const magnetCache = new Map();
const inFlight = new Map();

// Troca de domínio invalida o que foi raspado do domínio antigo (chaves de
// cache são URLs absolutas); o inFlight segue vivo para não quebrar o
// coalescing das promises em andamento.
siteSelector.onDomainChange(() => {
  postCache.clear();
  searchCache.clear();
  magnetCache.clear();
});

// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';

const PACK_RESET_PATTERN = /\b(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|\bPACK\b)\b/i;
const EPISODE_RANGE_PATTERN = /(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\s-]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b/i;
const EPISODE_PATTERN = /(?:EPIS[ÓO]DIO|EP|CAP[ÍI]TULO|CAP)[.\s-]*(\d{1,3})\b|\bS\d{1,2}E(\d{1,3})\b|\bE(\d{1,3})\b|\b\d{1,2}X(\d{1,3})\b/gi;

function extractEpisode(text) {
  if (!text) return null;
  if (EPISODE_RANGE_PATTERN.test(text)) return null;
  const matches = [...text.matchAll(EPISODE_PATTERN)];
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

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
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

function parseSize(value) {
  const match = String(value || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const number = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase()];
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

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
  const lastToken = matches[matches.length - 1][0];
  return extractQualityToken(lastToken);
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
  const lastToken = matches[matches.length - 1][0];
  return extractSourceToken(lastToken);
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
  return CANDIDATE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isProtectorHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALL_PROTECTOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function normalizeQuery(value) {
  return String(value || '')
    .replace(/\b[sS]\d{1,2}(?:[eE]\d{1,2})?\b/gi, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMagnet(html) {
  if (!html) return null;
  const str = String(html);

  // 1. Variáveis JavaScript explícitas (DEST_URL, DOWNLOAD_URL, MAGNET_URL, LINK_DOWNLOAD, URL_DOWNLOAD, DOWNLOAD, REDIRECT_URL, NEXT_URL, LINK_FINAL, TARGET_URL, DESTINO, etc.)
  const jsVar = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (jsVar) {
    let val = jsVar[1];
    if (/^magnet%3A%3F/i.test(val)) {
      try {
        val = decodeURIComponent(val);
      } catch {}
    }
    if (val.startsWith('magnet:?')) return decodeEntities(val);
  }

  // 2. Redirecionamentos / atribuições de navegação JavaScript
  const jsNav = str.match(
    /(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (jsNav) {
    let val = jsNav[1];
    if (/^magnet%3A%3F/i.test(val)) {
      try {
        val = decodeURIComponent(val);
      } catch {}
    }
    if (val.startsWith('magnet:?')) return decodeEntities(val);
  }

  // 3. Atributos HTML customizados (data-magnet, data-url, data-link, data-href, data-download)
  const attrMatch = str.match(
    /(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (attrMatch) {
    let val = attrMatch[1];
    if (/^magnet%3A%3F/i.test(val)) {
      try {
        val = decodeURIComponent(val);
      } catch {}
    }
    if (val.startsWith('magnet:?')) return decodeEntities(val);
  }

  // 4. Regex direto de URI magnet no documento
  const rawMatch = str.match(/magnet:\?[^"'<>\s]+/i);
  if (rawMatch) return decodeEntities(rawMatch[0]);

  // 5. Magnet URL-encoded (Parameter Order-Invariant & allowing literal &)
  const encodedMatch = str.match(/magnet%3A%3F[^"'<>\s]+/i);
  if (encodedMatch) {
    try {
      const decoded = decodeURIComponent(encodedMatch[0]);
      if (decoded.startsWith('magnet:?')) return decodeEntities(decoded);
    } catch {}
  }

  return null;
}

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

  // 1. Meta refresh check first
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

  // 3. Busca genérica de URLs no corpo HTML apontando para domínios de protetor permitidos
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
  const seen = new Set();
  const article = /<article\b[^>]*class=["'][^"']*\bblog-view\b[^"']*["'][^>]*>([\s\S]*?)(?:<\/article>|(?=<article\b)|$)/gi;
  let match;
  while ((match = article.exec(html))) {
    const anchor = match[1].match(/<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = attribute(anchor[1], 'href');
    if (!url) continue;
    let resolvedUrl;
    try {
      resolvedUrl = new URL(decodeEntities(url), siteSelector.url()).href;
    } catch {
      continue;
    }
    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    const image = match[1].match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || null;
    const title = stripTags(attribute(anchor[1], 'title') || anchor[2]);
    if (isGenericListPost(title)) continue;
    posts.push({
      url: resolvedUrl,
      title,
      poster: image ? decodeEntities(image) : null,
    });
  }
  return posts;
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

function cleanPostTitle(title = '') {
  let clean = decodeEntities(String(title || ''));

  // 1. Remove "Torrent(s)" e separador adjacente (ex: "Torrent – (2024)" -> " (2024)")
  clean = clean.replace(/\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*/gi, ' ');

  // 2. Remove resoluções (2160p, 1080p, 720p, 576p, 480p, 4K, UHD, etc.)
  clean = clean.replace(/\b(?:2160p|1080p|720p|576p|480p|\d{3,4}p|4K|8K|UHD|ULTRA\s*HD|FULL\s*HD|\bHD\b(?!\s*TV)|\bSD\b)\b/gi, ' ');

  // 3. Remove codecs de vídeo e fontes (BluRay, WEB-DL, Remux, IMAX, 3D, Remastered, etc.)
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

function parseDownloadLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  let cursor = 0;
  let currentAudio = 'desconhecido';
  let currentEpisode = null;

  const decodedHtml = decodeEntities(html);

  while ((match = pattern.exec(decodedHtml))) {
    const rawHref = (attribute(match[1], 'href') || '').trim();
    if (!rawHref) continue;

    const isMagnet = /^magnet:\?/i.test(rawHref);
    let downloadUrl;

    if (isMagnet) {
      downloadUrl = rawHref;
    } else {
      let resolvedUrl;
      try {
        resolvedUrl = new URL(rawHref, baseUrl);
      } catch {
        cursor = pattern.lastIndex;
        continue;
      }

      let targetHost = resolvedUrl.hostname;
      const toParam = resolvedUrl.searchParams.get('to');
      if (toParam) {
        try {
          targetHost = new URL(decodeEntities(toParam)).hostname;
        } catch {}
      }

      if (!isProtectorHost(targetHost)) {
        cursor = pattern.lastIndex;
        continue;
      }
      downloadUrl = resolvedUrl.href;
    }

    const rawSegment = decodedHtml.slice(cursor, match.index);
    const segment = stripTags(rawSegment).toUpperCase();
    const anchorText = stripTags(match[2] || '').toUpperCase();
    cursor = pattern.lastIndex;

    // 1. Detecção de áudio e isolamento de contexto de seção
    const audioMarkers = [...segment.matchAll(/(?:VERS[AÃ]O\s+)?(?:MKV\s+|MP4\s+)?(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD\w*|LEGENDAD\w*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b)/gi)];
    if (audioMarkers.length > 0) {
      const lastMarker = audioMarkers[audioMarkers.length - 1][1];
      currentAudio = /LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/i.test(lastMarker) ? 'legendado' : 'dublado';
    }

    const anchorAudio = [...anchorText.matchAll(/(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD\w*|LEGENDAD\w*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b)/gi)].pop();
    let linkAudio = currentAudio;
    if (anchorAudio) {
      linkAudio = /LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/i.test(anchorAudio[1]) ? 'legendado' : 'dublado';
    }

    // 2. Numeração de episódio vs Reset de pack de temporada
    const anchorEp = extractEpisode(anchorText);
    const anchorIsPack = PACK_RESET_PATTERN.test(anchorText) || EPISODE_RANGE_PATTERN.test(anchorText);

    if (anchorEp !== null) {
      currentEpisode = anchorEp;
    } else if (anchorIsPack) {
      currentEpisode = null;
    } else {
      const segEp = extractEpisode(segment);
      const segIsPack = PACK_RESET_PATTERN.test(segment) || EPISODE_RANGE_PATTERN.test(segment);

      if (segEp !== null && segIsPack) {
        const lastEpMatches = [...segment.matchAll(EPISODE_PATTERN)];
        const lastPackMatches = [...segment.matchAll(PACK_RESET_PATTERN)];
        const lastEpIdx = lastEpMatches.length > 0 ? lastEpMatches[lastEpMatches.length - 1].index : -1;
        const lastPackIdx = lastPackMatches.length > 0 ? lastPackMatches[lastPackMatches.length - 1].index : -1;
        if (lastEpIdx > lastPackIdx) {
          currentEpisode = segEp;
        } else {
          currentEpisode = null;
        }
      } else if (segEp !== null) {
        currentEpisode = segEp;
      } else if (segIsPack) {
        currentEpisode = null;
      }
    }

    // 3. Resolução de vídeo, codec e tamanho
    const context = `${segment} ${anchorText}`;
    const quality = normalizeQuality(context);
    const source = normalizeSource(context);
    const sizeHit = [...context.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)].pop();
    const size = sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null;

    links.push({
      url: downloadUrl,
      quality,
      size,
      audio: linkAudio,
      episode: currentEpisode,
      source,
    });
  }
  return links;
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
  const cacheKey = `magnet:best:${postUrl}`;
  const cached = magnetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) magnetCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const { post, links } = await getPostLinks(postUrl);
    let lastError;
    for (const link of [...links].sort((a, b) => scoreLink(b) - scoreLink(a))) {
      try {
        const magnet = await fetchFollowingAllowed(link.url, post.href);
        magnetCache.set(cacheKey, { value: magnet, expiresAt: Date.now() + MAGNET_CACHE_MS });
        if (magnetCache.size > 500) magnetCache.delete(magnetCache.keys().next().value);
        return magnet;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no_magnet');
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

async function resolveButton(postUrl, index) {
  const cacheKey = `magnet:${postUrl}:${index}`;
  const cached = magnetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) magnetCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const { post, links } = await getPostLinks(postUrl);
    if (!Number.isInteger(index) || index < 0 || !links[index]) throw new Error('no_such_button');
    const magnet = await fetchFollowingAllowed(links[index].url, post.href);
    magnetCache.set(cacheKey, { value: magnet, expiresAt: Date.now() + MAGNET_CACHE_MS });
    if (magnetCache.size > 500) magnetCache.delete(magnetCache.keys().next().value);
    return magnet;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
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
  let clean = cleanPostTitle(postTitle);
  const epPart = link?.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const audioTag = link?.audio === 'dublado' ? 'DUBLADO' : link?.audio === 'legendado' ? 'LEGENDADO' : null;
  const tags = [
    link?.quality ? `${link.quality}p` : null,
    link?.source,
    audioTag,
    link?.size || (index == null ? null : `opção ${index + 1}`),
  ].filter(Boolean);

  if (link?.source) {
    const sourceEscaped = link.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-. ]?');
    clean = clean.replace(new RegExp(`\\b${sourceEscaped}\\b`, 'gi'), '').replace(/[–\-—/|:&+\s]+$/g, '').replace(/\s+/g, ' ').trim();
  }

  const base = epPart ? `${clean} ${epPart}` : clean;
  return tags.length ? `${base} [${tags.join(' ')}]` : base;
}

function searchPageHtml(items) {
  const rows = items.map(({ post, link, index }) => {
    const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}`;
    return `<div class="release"><div class="title"><a href="${escapeHtml(download)}">${escapeHtml(releaseTitle(post, link, index))}</a></div><div class="size">${escapeHtml(link.size || UNKNOWN_SIZE)}</div>${post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}"></div>` : ''}<div class="description">${escapeHtml(post.title)}</div><div class="seeders">1</div></div>`;
  }).join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

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

async function searchPosts(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const cacheKey = `search:${normalized}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) searchCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    try {
      const source = await fetch(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!source.ok) throw new Error(`http_${source.status}`);
      // Sucesso da busca zera o streak ANTES de raspar posts/protetores:
      // queda do protetor não conta como falha do domínio.
      siteSelector.noteSuccess();
      // Sem filtro extra aqui: parsePosts já descarta os posts-índice na origem.
      const posts = parsePosts(await source.text()).slice(0, MAX_POSTS);
      const chunks = await mapLimit(posts, async (post) => {
        try {
          const { links } = await getPostLinks(post.url);
          return links.map((link, index) => ({ post, link, index }));
        } catch (err) {
          console.warn(`[search] Falha ao obter links do post ${post.url}: ${err.message}`);
          return [];
        }
      });
      const items = chunks.flat();
      searchCache.set(cacheKey, { value: items, expiresAt: Date.now() + SEARCH_CACHE_MS });
      if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
      return items;
    } catch (err) {
      // Só erro de rede (DNS/conexão/timeout) alimenta o failover: 0
      // resultados ou HTTP de erro não dizem nada sobre o domínio.
      if (isNetworkError(err)) await siteSelector.noteFailure();
      throw err;
    }
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method !== 'GET') return reply(response, 404, 'not_found');
  if (url.pathname === '/health') return reply(response, 200, 'ok');
  if (url.pathname === '/search') {
    const rawQuery = url.searchParams.get('q');
    if (!rawQuery || !rawQuery.trim()) {
      return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
    }
    try {
      const items = await searchPosts(rawQuery);
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

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`comandotorrents-resolver :${PORT} — torznab em /api, fonte ${siteSelector.url()} (failover: ${CANDIDATE_HOSTS.join(', ')})`);
  });
}

module.exports = {
  createServer,
  parsePosts,
  parseDownloadLinks,
  releaseTitle,
  searchPageHtml,
  assertAllowedUrl,
  extractMagnet,
  extractMetaRefresh,
  nextProtectedUrl,
  isDetailHost,
  isProtectorHost,
  getPostLinks,
  resolveBest,
  resolveButton,
  fetchFollowingAllowed,
  decodeEntities,
  extractEpisode,
  cleanPostTitle,
  isGenericListPost,
  parseSize,
  normalizeQuality,
  normalizeSource,
  normalizeQuery,
  siteSelector,
  createSiteSelector,
  isNetworkError,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};
