'use strict';

// Vaca Torrent (vaqueirofilmes.com) — perfil do resolver local.
//
// O plano (`.kilo/plans/1787884703326-vacatorrent-indexer.md`) mapeou o site:
//   - Não é blog de posts: catálogo por obra (CPTs movie/tv_show) via REST.
//   - Busca é JSON AJAX (acion-insensível): `admin-ajax.php?action=search_posts`.
//   - Filme → página do post → `/movie-links/<id>/` → âncoras systemtech com
//     rótulo real (áudio • qualidade • tamanho).
//   - Série → `season-internal/?show=<postId>` → cards de temporada/batch.
//   - O batch linkado pode ser de OUTRA série (bug real do site): o título do
//     batch vem do `.bl-hero-title` da página do batch (título real), nunca da
//     série buscada — o filtro do addon usa isso para descartar.
//   - Protetor `systemtech.space/enc`: go.php → `const next` → youtube redirect
//     com `q` = t.co url-encoded → t.co → relay.php.
//
// ⚠️  O magnet é ACIONÁVEL via HTTP (validado AO VIVO em 2026-08-28). A cadeia
// REAL do shortener multi-domínio (systemtech.space → t.co → vacadb.org):
//
//   go.php → 302 → processar.php (Set-Cookie; injeta `const next`/`trackUrl`/
//     `pub`/`enc`; o next é redirect do youtube com `q` = t.co urlencoded)
//     → t.co (meta-refresh/JS) → relay.php (exige cookie) → 302 →
//     vacadb.org/enc/receber.php?enc=... → 302 → landing vacadb.org (200;
//     Set-Cookie `_svu`; HTML tem `var URL_ETAPA2` = `https:\/\/vacadb.org\/
//     enc2\/receber.php?enc=<_svu>&pub=...`) → URL_ETAPA2 → 302 → pasta
//     gate-2 (200, ex. vacadb.org/hamburguer-caseiro-...) cujo `<body>` tem
//     `data-link="BASE64"` = MAGNET REAL (`magnet:?xt=urn:btih:...`).
//
// Os contadores de ~50s/clique/nova-aba são TEATRO client-side — nada disso é
// necessário. O transporte percorre só os saltos HTTP de verdade: ~7
// requisições, ~1-2s (sessão quente). Este perfil segue o contrato dos demais:
// caches, failover de domínio via seletor compartilhado, e o laço do protetor
// EXCLUSIVAMENTE em `followProtectedUrl` do transport.
const { USER_AGENT, parseExtraProtectors: runtimeParseExtraProtectors } = require('../runtime');
const { createSiteSelector: createSharedSiteSelector, isNetworkError: sharedIsNetworkError } = require('../site-selector');
const { createServer: createHttpServer, reply } = require('../http-server');
const { mapLimit: sharedMapLimit } = require('../concurrency');
const { followProtectedUrl } = require('../transport');
const { unwrapResolverUrl: unwrapSharedResolverUrl } = require('../nested-url');
const { BASE_PROTECTOR_SUFFIXES, hasAllowedHost, assertAllowedUrl: sharedAssertAllowedUrl } = require('../protector');
const {
  decodeEntities,
  stripTags: stripTagsShared,
  escapeHtml,
  parseSize,
  attribute,
  extractMetaRefresh: sharedExtractMetaRefresh,
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

const PORT = Number(process.env.PORT || 8704);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
// Cadeia real do protetor mede 8 saltos (go.php→processar→t.co→relay→
// receber→landing→etapa2→gate2→magnet); 10 dá folga sem risco de giro
// infinito (o transport ainda aborta com too_many_redirects após N).
const MAX_HOPS = 10;
const MAX_POSTS = Number(process.env.MAX_POSTS || 3);
const CONCURRENCY = 3;
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);
const SELF_URL = (process.env.SELF_URL || 'http://vacatorrent-resolver:8704').replace(/\/$/, '');
// Wireado no pool ao vivo: `config.resolvers.vacatorrentUrl` (env
// VACATORRENT_URL) e a entrada em `src/br-resolvers.ts` existem, então em modo
// embutido o SITE_URL chega injetado por lá. O default abaixo vale para a
// execução direta do resolver standalone.
const SITE_URL = (process.env.SITE_URL || process.env.VACATORRENT_URL || 'https://vaqueirofilmes.com').replace(/\/$/, '');

function parseExtraProtectors(envVal) {
  return runtimeParseExtraProtectors(envVal);
}

// Hosts históricos. `vaqueirofilmes.com` cobre também `www.`.
const FALLBACK_SITE_SUFFIXES = [
  'vaqueirofilmes.com',
  'vacatorrentmov.com',
];

function isNetworkError(err) {
  return sharedIsNetworkError(err);
}

const createSiteSelector = createSharedSiteSelector;

const siteSelector = createSharedSiteSelector('[vacatorrent]', process.env.VACATORRENT_URLS, SITE_URL, FALLBACK_SITE_SUFFIXES);
// Hosts de TODOS os candidatos são confiáveis desde o boot.
const CANDIDATE_HOSTS = siteSelector.hosts();

const EXTRA_PROTECTORS = parseExtraProtectors(process.env.EXTRA_ALLOWED_PROTECTORS);

// Protetor do site. NÃO alteramos o transport nem no BASE_PROTECTOR_SUFFIXES
// (fora do escopo); a allowlist do protetor fica própria no perfil.
const ALL_PROTECTOR_SUFFIXES = Array.from(
  new Set([...BASE_PROTECTOR_SUFFIXES, ...EXTRA_PROTECTORS, 'systemtech.space']),
);

// `t.co` e `vacadb.org` são apenas hosts de SALTO do protetor (go.php → youtube
// → t.co → relay.php → vacadb.org): entram no `assertAllowedUrl` (o transport
// segue os 302 pra lá) mas NÃO no regex de descoberta do `nextProtectedUrl` —
// `isProtectorHost` continua false pra ambos, só `systemtech.space` é
// descoberta. A exceção que o `URL_ETAPA2` aponta explicitamente pra vacadb.org
// fica no próximo salto do `nextProtectedUrl`, não aqui.
const ASSERT_ONLY_SUFFIXES = ['t.co', 'vacadb.org'];

const ALLOWED_SUFFIXES = Array.from(
  new Set([
    ...CANDIDATE_HOSTS,
    ...ALL_PROTECTOR_SUFFIXES,
    ...ASSERT_ONLY_SUFFIXES,
  ]),
);

const postCache = new Map();
const searchCache = new Map();
const magnetCache = new Map();
const inFlight = new Map();

// Troca de domínio invalida o que foi raspado do domínio antigo; o inFlight
// segue vivo para não quebrar o coalescing das promises em andamento.
siteSelector.onDomainChange(() => {
  postCache.clear();
  searchCache.clear();
  magnetCache.clear();
});

// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a
// release nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);
// Variante rica de entidades (WordPress), como no comandotorrents.
const extractMetaRefresh = (html) => sharedExtractMetaRefresh(html, decodeEntities);

function assertAllowedUrl(value) {
  return sharedAssertAllowedUrl(value, ALLOWED_SUFFIXES);
}

function isDetailHost(hostname) {
  return hasAllowedHost(hostname, CANDIDATE_HOSTS);
}

function isProtectorHost(hostname) {
  return hasAllowedHost(hostname, ALL_PROTECTOR_SUFFIXES);
}

// Hosts só de passagem (t.co, vacadb.org): permitidos no transporte e no salto
// explícito do `URL_ETAPA2`, mas nunca alvo de descoberta genérica.
function isAssertOnlyHost(hostname) {
  return hasAllowedHost(hostname, ASSERT_ONLY_SUFFIXES);
}

// ---------------------------------------------------------------------------
// Query. O `search_posts` é LIKE sobre o título SEM ano; query com ano dá 0.
// `normalizeQuery` tira SxxEyy E ano de 4 dígitos antes de consultar.
// ---------------------------------------------------------------------------
function normalizeQuery(value) {
  return String(value || '')
    .replace(/\b[Ss]\d{1,2}(?:[Ee]\d{1,2})?\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requestedSeasonFromQuery(value) {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

// ---------------------------------------------------------------------------
// Parsers de qualidade/fonte/áudio a partir do rótulo real das âncoras.
// ---------------------------------------------------------------------------
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
  const matches = [...text.matchAll(/\b(BDREMUX|REMUX|BLU[- ]?RAY|BLRAY|BD\b|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM)\b/gi)];
  if (!matches.length) return null;
  return extractSourceToken(matches[matches.length - 1][0]);
}

// Áudio a partir do contexto (rótulo + texto ao redor da âncora).
//    só Português        → 'dublado'
//    "Português | Inglês" → 'dual'
//    sem Português        → 'legendado'
//    nada detectado        → null
function classifyAudio(context) {
  const text = String(context || '').toUpperCase();
  const hasPt = /PORTUGU[ÊE]S|PORTUGUES/.test(text);
  const hasForeign = /INGL[ÊE]S|INGLES|ESPANHOL|JAPON[ÊE]S|COREANO|LEGENDAD|ORIGINAL/.test(text);
  if (hasPt) return hasForeign ? 'dual' : 'dublado';
  if (hasForeign) return 'legendado';
  return null;
}

// ---------------------------------------------------------------------------
// Contexto de episódio entre âncoras (mesma estratégia do comandotorrents).
// ---------------------------------------------------------------------------
const PACK_RESET_PATTERN = /\b(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|\bPACK\b|\bbatch\b)\b/i;
const EPISODE_RANGE_PATTERN = /(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\-s]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b/i;
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

// ---------------------------------------------------------------------------
// extractMagnet reusa o padrão dos profiles irmãos (nenhum laço próprio).
// nextProtectedUrl adiciona o caso `const next` + decode inline de `q` do
// youtube redirect → t.co. O laço HTTP segue no transport.
// ---------------------------------------------------------------------------
function extractMagnet(html) {
  if (!html) return null;
  const str = String(html);

  const jsVar = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (jsVar) {
    let val = jsVar[1];
    if (/^magnet%3A%3F/i.test(val)) {
      try { val = decodeURIComponent(val); } catch {}
    }
    if (val.startsWith('magnet:?')) return decodeEntities(val);
  }

  const jsNav = str.match(
    /(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (jsNav) {
    let val = jsNav[1];
    if (/^magnet%3A%3F/i.test(val)) {
      try { val = decodeURIComponent(val); } catch {}
    }
    if (val.startsWith('magnet:?')) return decodeEntities(val);
  }

  const attrMatch = str.match(
    /(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i,
  );
  if (attrMatch) {
    let val = attrMatch[1];
    if (/^magnet%3A%3F/i.test(val)) {
      try { val = decodeURIComponent(val); } catch {}
    }
    if (val.startsWith('magnet:?')) return decodeEntities(val);
  }

  // data-link base64 (gate-2 do protetor vacadb). No body da pasta final o
  // magnet viaja em Base64 (`<body data-link="...">`); decodificar e validar
  // antes de devolver. Vem ANTES do regex cru de magnet (o base64 não casa
  // nele, mas a ordem documenta a prioridade do conteúdo decodificado).
  const b64Link = str.match(/data-link=["']([A-Za-z0-9+/=]{32,})["']/i);
  if (b64Link) {
    try {
      const value = b64Link[1].replace(/\s+/g, '');
      const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
      if (/^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}/i.test(decoded)) {
        return decoded;
      }
    } catch {}
  }

  const rawMatch = str.match(/magnet:\?[^"'<>\s]+/i);
  if (rawMatch) return decodeEntities(rawMatch[0]);

  const encodedMatch = str.match(/magnet%3A%3F[^"'<>\s]+/i);
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

  // 1. const next = "<url>". O go.php publica a URL JSON-escaped (\"https:\\/\\/...\")
  //    — a aspa escapa com \" e o slash com \/ — e, quando é uma redirect do
  //    youtube, o magnet está em `q` (percent-encoded): decodificar inline (sem
  //    fetch) → t.co (no assert allowlist, não no discovery).
  const nextMatch = str.match(/const\s+next\s*=\s*["'](https?:[^"']+)["']/i);
  if (nextMatch) {
    try {
      // Des-escapa a string JSON (\" e \/) antes de virar URL.
      const jsonUnescaped = String(nextMatch[1]).replace(/\\\//g, '/').replace(/\\"/g, '"');
      const u = new URL(decodeEntities(jsonUnescaped), baseUrl);
      if (/(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(u.hostname)) {
        const q = u.searchParams.get('q');
        if (q && q.trim()) {
          try {
            return decodeURIComponent(decodeEntities(q.trim()));
          } catch {}
        }
      }
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 2. URL_ETAPA2 (gate-2 da vacadb.org). A landing emite
  //    `var URL_ETAPA2 = "https:\\/\\/vacadb.org\\/enc2\\/receber.php?enc=<_svu>&pub=..."`
  //    JSON-escaped; `extractMagnet` falha ali, e este var é o próximo salto.
  //    Des-escapar só o slash (o valor não é string JSON inteira), resolver
  //    absoluto e seguir apenas p/ host de passagem (vacadb.org) ou protetor.
  const etapa2 = str.match(/URL_ETAPA2\s*=\s*["']([^"']+)["']/i);
  if (etapa2) {
    try {
      const jsonUnescaped = String(etapa2[1]).replace(/\\\//g, '/');
      const u = new URL(decodeEntities(jsonUnescaped), baseUrl);
      if ((isProtectorHost(u.hostname) || isAssertOnlyHost(u.hostname)) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 3. Meta refresh.
  const refreshValue = extractMetaRefresh(str);
  if (refreshValue) {
    try {
      const u = new URL(decodeEntities(refreshValue), baseUrl);
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 4. Lote de variáveis JS apontando para protetor permitido.
  const jsMatch = str.match(
    /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LOCATION|next_url|target_url|dest|target|link|url|next)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
  );
  if (jsMatch) {
    try {
      const u = new URL(decodeEntities(jsMatch[1]), baseUrl);
      if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
    } catch {}
  }

  // 5. Busca genérica de URLs no corpo apontando para protetores permitidos.
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

// ---------------------------------------------------------------------------
// Parse da busca AJAX (search_posts). Retorna obras
// `{url,title,poster,year,type,idioma,imdb}`.
// ---------------------------------------------------------------------------
function parseSearchJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed?.results ?? parsed?.posts);
  if (!Array.isArray(arr)) return [];

  const posts = [];
  const seen = new Set();
  for (const raw of arr) {
    if (!raw) continue;
    const title = stripTags(String(raw.title || '')).trim();
    if (!title) continue;
    const link = raw.link || raw.url;
    if (!link) continue;
    let resolved;
    try {
      resolved = new URL(String(link), siteSelector.url()).href;
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const type = /filme/i.test(String(raw.type || '')) ? 'Filme' : 'Série';
    let year = Number(raw.year);
    if (!Number.isFinite(year) || year < 1900 || year > 2100) year = null;

    posts.push({
      url: resolved,
      title,
      type,
      year,
      poster: raw.thumbnail ? decodeEntities(String(raw.thumbnail)) : null,
      idioma: raw.idioma ? String(raw.idioma) : null,
      imdb: raw.imdb ? String(raw.imdb) : null,
    });
  }
  return posts;
}

function filterSearchPosts(entries, query, requestedSeason) {
  const normalized = normalizeQuery(query);
  let posts = entries;
  if (normalized) {
    posts = entries.filter((post) => matchesResolverQuery(post, normalized));
  }
  if (requestedSeason) {
    posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
  }
  return posts.slice(0, MAX_POSTS);
}

// ---------------------------------------------------------------------------
// Parse de âncoras systemtech. Cada âncora vira um "link" com url, qualidade,
// fonte, áudio, tamanho e contexto de episódio. `options.season` injeta a
// temporada da página. `realTitle` (batch) reescreve o título da release.
// ---------------------------------------------------------------------------
function parseDownloadLinks(html, baseUrl, options = {}) {
  const links = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  let cursor = 0;
  let currentAudio = null;
  let currentEpisode = null;

  const decodedHtml = decodeEntities(html);

  while ((match = pattern.exec(decodedHtml))) {
    const rawHref = (attribute(match[1], 'href') || '').trim();
    if (!rawHref) continue;

    const isMagnet = /^magnet:\?/i.test(rawHref);
    let downloadUrl;
    if (isMagnet) downloadUrl = rawHref;
    else {
      let resolvedUrl;
      try {
        resolvedUrl = new URL(rawHref, baseUrl);
      } catch {
        cursor = pattern.lastIndex;
        continue;
      }
      // Só accepted systemtech (Download); players embed não são protetores.
      const toParam = resolvedUrl.searchParams.get('to');
      let targetHost = resolvedUrl.hostname;
      if (toParam) {
        try { targetHost = new URL(decodeEntities(toParam)).hostname; } catch {}
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

    const segAudio = classifyAudio(segment);
    if (segAudio) currentAudio = segAudio;
    const anchorAudio = classifyAudio(anchorText);
    const audio = anchorAudio ?? currentAudio;

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
        const lastEpIdx = lastEpMatches.length ? lastEpMatches[lastEpMatches.length - 1].index : -1;
        const lastPackIdx = lastPackMatches.length ? lastPackMatches[lastPackMatches.length - 1].index : -1;
        currentEpisode = lastEpIdx > lastPackIdx ? segEp : null;
      } else if (segEp !== null) {
        currentEpisode = segEp;
      } else if (segIsPack) {
        currentEpisode = null;
      }
    }

    const context = `${segment} ${anchorText}`;
    const quality = normalizeQuality(context);
    const source = normalizeSource(context);
    const sizeHit = [...context.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)].pop();
    const size = sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null;

    links.push({
      url: downloadUrl,
      quality,
      source,
      size,
      audio,
      episode: currentEpisode,
      season: options.season ?? null,
      realTitle: options.realTitle ?? null,
    });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Filme: página do post → link da página de botões (/movie-links/<id>/).
// ---------------------------------------------------------------------------
function extractMovieLinks(html, baseUrl) {
  const hrefMatch = /href=["']([^"']*\bmovie-links\b[^"']*)["']/i.exec(String(html || ''));
  const idMatch = /movie-links\/(\d+)/.exec(String(html || ''));
  const href = hrefMatch ? hrefMatch[1] : (idMatch ? `/movie-links/${idMatch[1]}/` : null);
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Série. Página do post tem `data-u` (base64) = `/pt/season-internal/?show=`.
// ---------------------------------------------------------------------------
function decodeDataU(html) {
  const attr = /data-u\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  if (!attr || !attr[1]) return null;
  try {
    return Buffer.from(attr[1], 'base64').toString('utf8').trim();
  } catch {
    return null;
  }
}

function seriesSeasonInternalUrl(html, baseUrl) {
  const decoded = decodeDataU(html);
  if (decoded && /\bseason-internal\b/.test(decoded)) {
    try { return new URL(decoded, baseUrl).href; } catch {}
  }
  const href = /season-internal\/\?show=\d+/i.exec(String(html || ''));
  if (href) {
    try { return new URL(href[0], baseUrl).href; } catch {}
  }
  const shortlink = /\?p=(\d{4,})/i.exec(String(html || ''));
  if (shortlink) {
    try { return new URL(`/pt/season-internal/?show=${shortlink[1]}`, baseUrl).href; } catch {}
  }
  return null;
}

function parseSeasonInternal(html, baseUrl) {
  const cards = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const classes = String(attribute(match[1], 'class') || '');
    const href = String(attribute(match[1], 'href') || '').trim();
    if (!href) continue;
    const isBatch = /\bsa-card-batch\b/.test(classes) || /\bbatch\b/.test(href);
    const isSeason = /\bsa-card\b/.test(classes) || /\btemporada-\d+\b/.test(href);
    if (!isBatch && !isSeason) continue;

    let resolved;
    try { resolved = new URL(href, baseUrl).href; } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const seasonMatch = /temporada-(\d+)/i.exec(resolved);
    let season = seasonMatch ? Number(seasonMatch[1]) : null;
    if (!Number.isFinite(season) || season <= 0) season = null;

    cards.push({
      url: resolved,
      isBatch,
      season,
      title: stripTags(match[2] || ''),
    });
  }
  return cards;
}

function filterSeasonCards(cards, requestedSeason) {
  const wanted = normalizeSeasonValue(requestedSeason);
  if (wanted == null) return cards;
  return cards.filter((card) => card.season == null || card.season === wanted);
}

function extractBatchTitle(html) {
  const m = /class=["'][^"']*\bbl-hero-title\b[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(String(html || ''));
  if (m) return stripTags(m[1]);
  const h = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i.exec(String(html || ''));
  return h ? stripTags(h[1]) : null;
}

// ---------------------------------------------------------------------------
// Título da release. Ano re-injetado (proteção de ano do addon); batch usa o
// título real (`.bl-hero-title`) — pode ser de OUTRA série.
// ---------------------------------------------------------------------------
function cleanMarkTitle(title = '') {
  let clean = decodeEntities(String(title || ''))
    .replace(/\s*Vaca\s+Torrent\s*/gi, ' ')
    .replace(/\s*Download\s*/gi, ' ')
    .replace(/\s*Baixar\s*/gi, ' ')
    .replace(/\s*ver\s+online\s*/gi, ' ')
    .replace(/\s*(?:dublado|dublada|legendado|legendada)\b/gi, ' ');
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}

function releaseTitle(post, link, index = null) {
  const isBatch = Boolean(link?.realTitle);
  const sourceTitle = isBatch ? link.realTitle : (typeof post === 'string' ? post : post?.title) || '';
  const clean = cleanMarkTitle(sourceTitle);
  const yearPart = !isBatch && post?.year ? ` (${post.year})` : '';

  const seasonPart = !isBatch && link?.season != null ? `S${String(link.season).padStart(2, '0')}` : '';
  const episodePart = !isBatch && link?.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const sePart = [seasonPart, episodePart].filter(Boolean).join('');

  const audioTag = link?.audio === 'dublado' ? 'DUBLADO' : link?.audio === 'dual' ? 'DUAL' : link?.audio === 'legendado' ? 'LEGENDADO' : null;
  const tags = [
    link?.quality ? `${link.quality}p` : null,
    link?.source,
    audioTag,
    link?.size || (index == null ? null : `opção ${index + 1}`),
  ].filter(Boolean);

  const base = `${clean}${yearPart}${sePart ? ` ${sePart}` : ''}`;
  return tags.length ? `${base} [${tags.join(' ')}]` : base;
}

function searchPageHtml(items) {
  const rows = items.map(({ post, link, index, count }) => {
    const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
    return `<div class="release">` +
      `<div class="title"><a href="${escapeHtml(download)}">${escapeHtml(releaseTitle(post, link, index))}</a></div>` +
      `<div class="size">${escapeHtml(link.size || UNKNOWN_SIZE)}</div>` +
      `${post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}"></div>` : ''}<div class="description">${escapeHtml(post.title || '')}</div>` +
      `<div class="seeders">1</div></div>`;
  }).join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Coleta de fontes por obra (filme/série/batch).
// ---------------------------------------------------------------------------
async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

async function fetchMovieLinks(post) {
  const cacheKey = `movie:${post.url}`;
  const cached = postCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) postCache.delete(cacheKey);
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const pageHtml = await fetchText(post.url);
    const linksUrl = extractMovieLinks(pageHtml, post.url);
    if (!linksUrl) return [];
    const linksHtml = await fetchText(linksUrl);
    const links = parseDownloadLinks(linksHtml, linksUrl);
    postCache.set(cacheKey, { value: links, expiresAt: Date.now() + POST_CACHE_MS });
    if (postCache.size > 100) postCache.delete(postCache.keys().next().value);
    return links;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

async function fetchSeriesLinks(post, requestedSeason) {
  const seasonKey = requestedSeason ? String(requestedSeason[1]) : '';
  const cacheKey = `serie:${post.url}:${seasonKey}`;
  const cached = postCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) postCache.delete(cacheKey);
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const pageHtml = await fetchText(post.url);
    const internalUrl = seriesSeasonInternalUrl(pageHtml, post.url);
    if (!internalUrl) return [];
    const internalHtml = await fetchText(internalUrl);
    const cards = filterSeasonCards(parseSeasonInternal(internalHtml, internalUrl), requestedSeason);

    const out = [];
    for (const card of cards) {
      try {
        const cardHtml = await fetchText(card.url);
        if (card.isBatch) {
          const realTitle = extractBatchTitle(cardHtml);
          const links = parseDownloadLinks(cardHtml, card.url, {
            season: card.season,
            realTitle: realTitle || null,
          });
          out.push(...links);
        } else {
          const links = parseDownloadLinks(cardHtml, card.url, { season: card.season });
          out.push(...links);
        }
      } catch (err) {
        console.warn(`[vac] card ${card.url}: ${err.message}`);
      }
    }

    postCache.set(cacheKey, { value: out, expiresAt: Date.now() + POST_CACHE_MS });
    if (postCache.size > 100) postCache.delete(postCache.keys().next().value);
    return out;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

async function postToItems(post, requestedSeason) {
  const links = post.type === 'Série'
    ? await fetchSeriesLinks(post, requestedSeason)
    : await fetchMovieLinks(post);
  return links.map((link, index) => ({ post, link, index, count: links.length }));
}

// ---------------------------------------------------------------------------
// Busca: AJAX JSON → obras → fontes.
// ---------------------------------------------------------------------------
async function searchPosts(query) {
  const cacheKey = `search:${String(query || '')}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) searchCache.delete(cacheKey);
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const requestedSeason = requestedSeasonFromQuery(query);
    const normalized = normalizeQuery(query);
    if (!normalized) return [];

    const ajaxUrl = `${siteSelector.url()}/wp-admin/admin-ajax.php?action=search_posts&s=${encodeURIComponent(normalized)}&lang=pt-BR`;
    const text = await fetchText(ajaxUrl, 'application/json, text/html, */*');
    siteSelector.noteSuccess();

    const posts = filterSearchPosts(parseSearchJson(text), normalized, requestedSeason);
    const chunks = await mapLimit(posts, async (post) => {
      try {
        return await postToItems(post, requestedSeason);
      } catch (err) {
        console.warn(`[search] Falha ao obter links do post ${post.url}: ${err.message}`);
        return [];
      }
    });
    const items = chunks.flat();

    searchCache.set(cacheKey, { value: items, expiresAt: Date.now() + SEARCH_CACHE_MS });
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    return items;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

async function mapLimit(items, fn) {
  return sharedMapLimit(items, CONCURRENCY, fn);
}

// ---------------------------------------------------------------------------
// Resolve: segue o protetor até o magnet. O laço é do transport.
// ---------------------------------------------------------------------------
async function fetchFollowingAllowed(value, referer) {
  return followProtectedUrl(value, referer, {
    assertAllowedUrl, decodeEntities, extractMagnet, nextProtectedUrl,
    extractMetaRefresh: (html) => extractMetaRefresh(html, decodeEntities),
    maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT,
    // Cookies de liberação do gatilhagem client-side. O JS (`liberar()`) setaria
    // `enc_liberado`/`enc_etapa1_visto` após o contador (teatro); aqui pré-semeamos
    // no host vacadb.org. O transport cria o jar e re-popula com esses pares via
    // o parser `harvest().from()`, além de continuar colhendo os `Set-Cookie` reais
    // (go.php/processar.php/_svu) durante a cadeia.
    cookieJar: { seed: { 'vacadb.org': { enc_liberado: '1', enc_etapa1_visto: '1' } } },
  });
}

async function collectLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
  const movie = { url: post.href, title: '', type: 'Filme', year: null, poster: null };
  let links = [];
  try { links = await fetchMovieLinks(movie); } catch {}
  if (!links.length) {
    const serie = { url: post.href, title: '', type: 'Série', year: null, poster: null };
    try { links = await fetchSeriesLinks(serie, null); } catch {}
  }
  return links;
}

async function resolveBest(postUrl) {
  const post = assertAllowedUrl(postUrl);
  const cacheKey = `best:${post.href}`;
  const cached = magnetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const links = await collectLinks(post.href);
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

async function resolveButton(postUrl, index, hash, count) {
  const post = assertAllowedUrl(postUrl);
  const cacheKey = `magnet:${post.href}:${index}:${hash || ''}`;
  const cached = magnetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const task = (async () => {
    const links = await collectLinks(post.href);
    const link = pickButton(links, index, hash, count);
    if (!link) throw new Error('no_such_button');
    const magnet = await fetchFollowingAllowed(link.url, post.href);
    magnetCache.set(cacheKey, { value: magnet, expiresAt: Date.now() + MAGNET_CACHE_MS });
    if (magnetCache.size > 500) magnetCache.delete(magnetCache.keys().next().value);
    return magnet;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

function scoreLink(link) {
  const audio = link.audio === 'dublado' || link.audio === 'dual' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
  return audio + source + Number(link.quality || 0);
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------
function unwrapResolverUrl(value, seed = {}) {
  return unwrapSharedResolverUrl(value, SELF_URL, seed);
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
      const unwrapped = unwrapResolverUrl(value, {
        index: url.searchParams.get('i'),
        hash: url.searchParams.get('h'),
        count: url.searchParams.get('n'),
      });
      const index = unwrapped.index == null ? null : Number(unwrapped.index);
      return reply(
        response,
        200,
        index == null ? await resolveBest(unwrapped.url) : await resolveButton(unwrapped.url, index, unwrapped.hash, unwrapped.count),
      );
    } catch (error) {
      return reply(response, 502, error.message);
    }
  }
  return reply(response, 404, 'not_found');
}

function createServer() {
  return createHttpServer(handleRequest);
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`vacatorrent-resolver :${PORT} — torznab em /search, fonte ${siteSelector.url()} (failover: ${CANDIDATE_HOSTS.join(', ')})`);
  });
}

module.exports = {
  createServer,
  // Exposto para o painel ler o domínio ATIVO (failover troca em runtime).
  siteSelector,
  parseSearchJson,
  filterSearchPosts,
  parseDownloadLinks,
  extractMovieLinks,
  parseSeasonInternal,
  filterSeasonCards,
  extractBatchTitle,
  decodeDataU,
  seriesSeasonInternalUrl,
  searchPageHtml,
  releaseTitle,
  assertAllowedUrl,
  extractMagnet,
  nextProtectedUrl,
  extractMetaRefresh: (html) => extractMetaRefresh(html, decodeEntities),
  isDetailHost,
  isProtectorHost,
  normalizeQuery,
  requestedSeasonFromQuery,
  normalizeSeasonValue,
  normalizeQuality,
  normalizeSource,
  classifyAudio,
  extractEpisode,
  cleanMarkTitle,
  searchPosts,
  fetchMovieLinks,
  fetchSeriesLinks,
  postToItems,
  fetchFollowingAllowed,
  resolveBest,
  resolveButton,
  buttonId,
  pickButton,
  unwrapResolverUrl,
  matchesResolverQuery,
  matchesSeasonSeason,
  createSiteSelector,
  isNetworkError,
  parseSize,
  decodeEntities,
  stripTags,
  escapeHtml,
  attribute,
  stripTrailingYears,
  computeWantedTokens,
  normalizeFilterText,
  isGenericListPost,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};