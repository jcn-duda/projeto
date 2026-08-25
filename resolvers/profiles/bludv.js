const http = require('node:http');
const { USER_AGENT, parseExtraProtectors: runtimeParseExtraProtectors } = require('../runtime');
const { createSiteSelector: createSharedSiteSelector, isNetworkError: sharedIsNetworkError } = require('../site-selector');
const { createFlareSessions } = require('../flare');
const { createServer: createHttpServer, reply } = require('../http-server');
const { mapLimit: sharedMapLimit } = require('../concurrency');
const { followProtectedUrl } = require('../transport');
const { capsXml: sharedCapsXml } = require('../torznab');
const { selectSearchPosts: selectSharedSearchPosts } = require('../search-posts');
const { unwrapResolverUrl: unwrapSharedResolverUrl } = require('../nested-url');
const { BASE_PROTECTOR_SUFFIXES, hasAllowedHost, assertAllowedUrl: sharedAssertAllowedUrl } = require('../protector');
const {
  decodeEntities,
  stripTags: stripTagsShared,
  parseSize,
  escapeXml,
  escapeHtml,
  extractMetaRefresh,
} = require('../text');
const {
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  isGenericListPost,
  buttonId,
  pickButton,
} = require('../matching');

const PORT = Number(process.env.PORT || 8700);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;

// --- Modo indexer Torznab ---
// SELF_URL é como o JACKETT alcança este serviço (nome DNS na rede Docker);
// os links de download do feed apontam pra cá e são resolvidos sob demanda.
const SELF_URL = (process.env.SELF_URL || 'http://bludv-resolver:8700').replace(/\/$/, '');
// O site troca de domínio com frequência; alinhar com o links: do cardigann.
// Este é o PRIMÁRIO — em runtime o siteSelector abaixo faila para os demais
// candidatos (csv BLUDV_URLS + FALLBACK_SITE_SUFFIXES) quando ele cai.
const SITE_URL = (process.env.SITE_URL || process.env.BLUDV_URL || 'https://bludvfilmes.xyz').replace(/\/$/, '');
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

function parseExtraProtectors(envVal) {
  return runtimeParseExtraProtectors(envVal);
}

const FALLBACK_SITE_SUFFIXES = [
  'bludvfilmes.xyz',
  'bludvfilmes1.xyz',
  'bludv.net',
  'bludv.xyz',
  'bludv.to',
];

// --- FlareSolverr (Cloudflare) ---
// bludvfilmes.xyz faz 301 para bludvfilmes1.xyz e o domínio novo responde 403
// com "Just a moment..." (challenge JavaScript do Cloudflare). O fetch direto
// não executa o desafio; o FlareSolverr resolve. Para não pagar os ~20s do
// browser a cada busca, a sessão resolvida (cf_clearance + userAgent) é
// memorizada por host e reusada no fetch direto enquanto for válida — só
// re-resolve quando o Cloudflare voltar a recusar.
const FLARE_SOLVERR_URL = (process.env.FLARE_SOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, '');
const FLARE_TIMEOUT_MS = Number(process.env.FLARE_TIMEOUT_MS || 55_000);
const FLARE_SESSION_TTL_MS = Number(process.env.FLARE_SESSION_TTL_MS || 20 * 60_000);
// hostname -> { cookies, userAgent, expiresAt }
const { sessions: flareSessions } = createFlareSessions();

// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// BLUDV_URLS) como candidatos ATIVOS, não só allowlist: quando a busca falha
// por erro de rede (DNS/conexão/timeout — HTTP de erro prova que o host
// respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o primeiro
// candidato que responda 2xx. O vencedor fica imune a novo probe por
// BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
function isNetworkError(err) {
  return sharedIsNetworkError(err, '|flare_');
}

// Mantém a superfície histórica do profile sem duplicar o seletor compartilhado.
const createSiteSelector = createSharedSiteSelector;

const siteSelector = createSharedSiteSelector('[bludv]', process.env.BLUDV_URLS, SITE_URL, FALLBACK_SITE_SUFFIXES);
// Hosts de TODOS os candidatos são confiáveis desde o boot (vêm de env ou da
// lista de mirrors históricos): allowlist e isDetailHost já aceitam o domínio
// que o failover escolher, sem restart.
const CANDIDATE_HOSTS = siteSelector.hosts();


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
  // O cf_clearance é do host antigo; reusá-lo no novo só garante 403.
  flareSessions.clear();
});

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

function assertAllowedUrl(value) {
  return sharedAssertAllowedUrl(value, ALLOWED_SUFFIXES);
}

function isDetailHost(hostname) {
  return hasAllowedHost(hostname, CANDIDATE_HOSTS);
}

function isProtectorHost(hostname) {
  return hasAllowedHost(hostname, ALL_PROTECTOR_SUFFIXES);
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

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);

function getFlareSession(hostname) {
  const hit = flareSessions.get(hostname);
  if (hit && hit.expiresAt > Date.now()) return hit;
  return null;
}

function buildCookies(cookies) {
  return (cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// Roteia a resposta HTML pelo FlareSolverr quando o site exigir desafio
// Cloudflare. Salva a sessão (cf_clearance + userAgent) por host para o fetch
// direto seguinte reusar sem pagar o browser de novo. Retorna o HTML resolvido.
async function fetchTextViaFlare(url, referer) {
  const body = JSON.stringify({ cmd: 'request.get', url, maxTimeout: FLARE_TIMEOUT_MS });
  const res = await fetch(`${FLARE_SOLVERR_URL}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(FLARE_TIMEOUT_MS + 10_000),
  });
  // Falha do FlareSolverr (5xx/HTML) NÃO é falha do site: propaga com prefixo
  // flare_ (excluído do isNetworkError) para o failover de domínio não morder.
  if (!res.ok) throw new Error(`flare_http_${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok' || !data.solution) {
    throw new Error(`flare_error_${data.status || '?'}:${data.message || 'sem solução'}`);
  }
  const { solution } = data;
  // FlareSolverr reporta status:'ok' mesmo quando a página final é a tela de
  // erro do Chromium (ex.: origin 522). `solution.status` é o HTTP real da
  // página: só 2xx é sucesso — senão o erro de origin viraria "0 posts" e o
  // noteSuccess() zerava o streak do failover, escondendo a fonte morta.
  const solvedStatus = Number(solution.status || 200);
  if (solvedStatus < 200 || solvedStatus >= 300) {
    throw new Error(`flare_site_${solvedStatus}`);
  }
  const response = solution.response || '';
  // Guarda extra: a tela de erro do Chromium ("This page isn't working"/"HTTP
  // ERROR NNN") chega com status 200 internamente em alguns cenários. Rejeitá-la
  // mantém a falha diagnosticável em vez de silenciar em "0 resultados".
  if (/This page isn.t working|HTTP ERROR \d{3}/i.test(response)) {
    throw new Error('flare_site_error_page');
  }
  const session = {
    cookies: buildCookies(solution.cookies),
    userAgent: solution.userAgent,
    expiresAt: Date.now() + FLARE_SESSION_TTL_MS,
  };
  // Grava sob o host PEDIDO e o RESOLVIDO: no cenário 301 (bludvfilmes.xyz →
  // bludvfilmes1.xyz) o próximo fetch direto consulta o host pedido e acha a
  // sessão — senão pagava o browser de novo a cada expiração do cache.
  flareSessions.set(new URL(url).hostname, session);
  flareSessions.set(new URL(solution.url || url).hostname, session);
  return response;
}

function buildFlareHeaders(url, referer) {
  // O fetch direto só reusa a sessão do MESMO host: um domain change limpa o
  // mapa, e o cf_clearance é por host — misturar UA/cookies de outro domínio
  // só garante rejeição. O host é o do alvo pedido, não do referer (o referer
  // chega undefined no fetchText do post).
  const hostname = new URL(url).hostname;
  const session = getFlareSession(hostname);
  return {
    'User-Agent': session?.userAgent || USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    ...(session?.cookies ? { Cookie: session.cookies } : {}),
    ...(referer ? { Referer: referer } : {}),
  };
}

async function fetchText(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: buildFlareHeaders(url, referer),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 403 do Cloudflare ("Just a moment...") não é o site fora do ar: é o desafio
  // JS que o fetch direto não executa. Re-resolve pelo FlareSolverr. Mas 403 por
  // outro motivo (rate-limit, bloqueio de região/proxy) não é desafio e virar
  // página de erro do FlareSolverr silenciaria a falha em "0 resultados" — só
  // deriva quando o corpo/header confirmam o desafio Cloudflare.
  if (res.status === 403) {
    const body = await res.text();
    const isCloudflareChallenge =
      res.headers.get('cf-mitigated') === 'challenge' ||
      /Just a moment|cf-chl|__cf_chl|challenge-platform|cf-browser-verification|cf_chl/i.test(body);
    if (isCloudflareChallenge) {
      return fetchTextViaFlare(url, referer);
    }
    throw new Error(`http_403`);
  }
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
  return followProtectedUrl(value, referer, {
    assertAllowedUrl, decodeEntities, extractMagnet, nextProtectedUrl, extractMetaRefresh,
    maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT,
  });
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
async function resolveButton(postUrl, index, hash, count) {
  const cacheKey = hash ? `magnet:${postUrl}:${index}:${hash}` : `magnet:${postUrl}:${index}`;

  const hit = magnetCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[cache] hit magnet botão ${index} ${postUrl}`);
    return hit.value;
  }
  if (hit) magnetCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = pickButton(links, index, hash, count);
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
      url = new URL(decodeEntities(m[2].trim()), siteSelector.url()).href;
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
    const title = stripTags(m[3]);
    if (isGenericListPost(title)) continue;
    posts.push({
      url,
      title,
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
  return sharedMapLimit(items, SEARCH_CONCURRENCY, fn, (err) => {
    console.warn(`[search] post sem botões (${err.message})`);
  });
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

function selectSearchPosts(sourceHtml, query, requestedSeason) {
  return selectSharedSearchPosts(parsePosts, sourceHtml, query, requestedSeason, MAX_POSTS);
}

/**
 * Busca com cache + coalescing: os DOIS modos (Torznab e Cardigann) passam
 * por aqui. O Stremio repete a mesma consulta em retry; sem cache cada uma
 * re-raspava a página de busca + os 5 posts. A categoria do RSS fica fora da
 * cache (decidida por chamada).
 */
async function searchPosts(query) {
  const requestedSeason = String(query || '').match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const cacheKey = `search:${String(query || '')}`;

  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[cache] hit search "${normalized}"`);
    return hit.value;
  }
  if (hit) searchCache.delete(cacheKey);

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    try {
      const html = await fetchText(assertAllowedUrl(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`));
      // Sucesso da busca zera o streak ANTES de raspar posts/protetores:
      // queda do protetor não conta como falha do domínio.
      siteSelector.noteSuccess();
      const posts = selectSearchPosts(html, normalized, requestedSeason);
      const chunks = await mapLimit(posts, async (post) => {
        const { links } = await getPostLinks(post.url);
        return links.map((link, index) => ({ post, link, index, count: links.length }));
      });
      const items = chunks.flat();
      searchCache.set(cacheKey, { value: items, expiresAt: Date.now() + SEARCH_CACHE_MS });
      if (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
        searchCache.delete(searchCache.keys().next().value);
      }
      console.log(`[search] "${normalized}" → ${posts.length} post(s), ${items.length} release(s)`);
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

/**
 * Página HTML sintética consumida pelo card Cardigann do Jackett: o motor
 * Cardigann é 1:1 com os resultados da busca, então cada BOTÃO do post vira
 * uma linha própria (qualidade/áudio/tamanho reais). O href do download já
 * carrega o índice exato do botão, resolvido por /resolve?i= no ato.
 */
function searchPageHtml(items) {
  const rows = items
    .map(({ post, link, index, count }) => {
      const dl = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
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
  return sharedCapsXml('BLUDV (resolver)');
}

function rssXml(items, category) {
  const body = items
    .map(({ post, link, index, count }) => {
      const dl = `${SELF_URL}/dl?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
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
    const magnet = await resolveButton(postUrl, index, url.searchParams.get('h'), url.searchParams.get('n'));
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
  const unwrapped = unwrapResolverUrl(postUrl, {
    audio: url.searchParams.get('audio'),
    quality: url.searchParams.get('quality'),
    index: url.searchParams.get('i'),
    hash: url.searchParams.get('h'),
    count: url.searchParams.get('n'),
  });
  postUrl = unwrapped.url;
  const { index, hash, count, audio, quality } = unwrapped;

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
      ? await resolveButton(postUrl, wantedIndex, hash, count)
      : await resolvePost(postUrl, { audio, quality: quality ? parseInt(quality, 10) : null });
    return reply(response, 200, magnet);
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

// O download.before do cardigann encoda a href inteira no param url — e a
// href já é um /resolve nosso, então o alvo real vem aninhado. Desempacota
// quantos níveis vierem, carregando i/h/n do nível mais interno que os
// declarar. `seed` são os params da requisição externa: chamada direta
// (/resolve?url=<post>&i=0&h=..) não tem nível interno de onde ler.
// Sem checar a origem: o host varia (`addon` embutido vs. nome do
// container), e o alvo final passa por assertAllowedUrl de todo jeito.
function unwrapResolverUrl(value, seed = {}) {
  return unwrapSharedResolverUrl(value, SELF_URL, seed, {
    paths: ['/resolve', '/dl'],
    fields: { index: 'i', hash: 'h', count: 'n', audio: 'audio', quality: 'quality' },
  });
}


function createServer() {
  return createHttpServer(async (request, response) => {
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
    console.log(`bludv-resolver :${PORT} — torznab em /api, fonte ${siteSelector.url()} (failover: ${CANDIDATE_HOSTS.join(', ')})`);
  });
}

module.exports = {
  createServer,
  // Exposto para o painel ler o domínio ATIVO (o failover troca em runtime).
  siteSelector,
  parseDownloadLinks,
  pickBestLink,
  sortLinks,
  parsePosts,
  parseSize,
  releaseTitle,
  cleanPostTitle,
  normalizeQuery,
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
  createSiteSelector,
  isNetworkError,
  getFlareSession,
  buildFlareHeaders,
  fetchText,
  fetchTextViaFlare,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};
