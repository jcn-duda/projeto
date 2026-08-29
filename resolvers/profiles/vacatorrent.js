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
const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
const { createServer: createHttpServer } = require('../http-server');
const {
  decodeEntities,
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
const { createProfile } = require('../site-profile');
// Passo 5 do item 9: esqueleto de roteador HTTP comum — despacho por pathname
// + rotas padrão (/health, /search, /resolve). Handlers próprios do perfil
// entram no mapa de rotas sem `if` na factory.
const {
  createResolverRouter, createHealthRoute, createSearchRoute, createResolveRoute,
} = require('../resolver-http');
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');
// Passo 4 do item 9: classificadores, máquina de estados da âncora
// (release-rules.js) e títulos/feeds/laço de fallback (release-format.js).
const {
  createQualityRules, createSourceRules, VACA_SOURCE_MATCH_RE,
  createEpisodeRules, createEpisodeStep, createLinkCollector,
  createProtectorHrefResolver,
} = require('../release-rules');
const {
  createReleaseTitle, createSearchPageHtml, createNormalizeQuery, tryLinksInOrder,
} = require('../release-format');

const PORT = Number(process.env.PORT || 8704);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
// Cadeia real do protetor mede 8 saltos (go.php→processar→t.co→relay→
// receber→landing→etapa2→gate2→magnet); 10 dá folga sem risco de giro
// infinito (o transport ainda aborta com too_many_redirects após N).
const MAX_HOPS = 10;
const MAX_POSTS = Number(process.env.MAX_POSTS || 3);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);
// SELF_URL é como o JACKETT alcança este serviço; SITE_URL é o default do
// site standalone.
//
// Wireado no pool ao vivo: `config.resolvers.vacatorrentUrl` (env
// VACATORRENT_URL) e a entrada em `src/br-resolvers.ts` existem, então em modo
// embutido o SITE_URL chega injetado por lá (a factory lê SITE_URL/VACATORRENT_URL
// no require). O default abaixo vale para a execução direta do resolver standalone.

// Hosts históricos. `vaqueirofilmes.com` cobre também `www.`.
const FALLBACK_SITE_SUFFIXES = [
  'vaqueirofilmes.com',
  'vacatorrentmov.com',
];

// `t.co` e `vacadb.org` são apenas hosts de SALTO do protetor (go.php → youtube
// → t.co → relay.php → vacadb.org): entram no `assertAllowedUrl` (o transport
// segue os 302 pra lá) mas NÃO no regex de descoberta do `nextProtectedUrl` —
// `isProtectorHost` continua false pra ambos, só `systemtech.space` é
// descoberta. A exceção que o `URL_ETAPA2` aponta explicitamente pra vacadb.org
// fica no próximo salto do `nextProtectedUrl`, não aqui.
const ASSERT_ONLY_SUFFIXES = ['t.co', 'vacadb.org'];

// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos cinco perfis (leitura de env no require, seletor
// de failover, conjuntos de sufixos, trio de allowlist, wrappers cosméticos)
// nasce aqui, por chamada — sem estado de módulo compartilhado.
const bootstrap = createProfile({
  name: 'vacatorrent',
  port: PORT,
  selfUrlEnv: 'http://vacatorrent-resolver:8704',
  siteUrl: 'https://vaqueirofilmes.com',
  siteUrlEnv: 'VACATORRENT_URL',
  urlsCsv: process.env.VACATORRENT_URLS,
  fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
  // Protetor do site. NÃO alteramos o transport nem o BASE_PROTECTOR_SUFFIXES
  // (fora do escopo); o sufixo próprio entra como extra da allowlist do perfil.
  extraProtectorSuffixes: ['systemtech.space'],
  // Hosts só de salto: assert sim, descoberta nunca.
  assertOnlySuffixes: ASSERT_ONLY_SUFFIXES,
  concurrency: 3,
  decodeEntities,
});

const {
  reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
} = bootstrap;
const { ALL_PROTECTOR_SUFFIXES, ALLOWED_SUFFIXES, unwrapResolverUrl, mapLimit } = bootstrap;
const {
  assertAllowedUrl, isDetailHost, isProtectorHost, isAssertOnlyHost,
  isNetworkError, stripTags,
} = bootstrap;
const SELF_URL = bootstrap.selfUrl;

// --- Cache (núcleo resolvers/cache.js) ---
// TTL + coalescing + FIFO, escrevendo APENAS no sucesso (erro nunca entra no
// mapa — contrato fixado pelo teste "postCache must not store errors"). Os
// três mapas compartilham UM inFlight: é o shape que testes e harnesses
// consomem (limpam e contam `mod.inFlight` diretamente). Tetos mantidos dos
// laços manuais (fixados pelo teste de stress): post/search 100, magnet 500.
const inFlight = new Map();
const { values: postCache, cached: cachedPost } = createCache(100, { inFlight });
const { values: searchCache, cached: cachedSearch } = createCache(100, { inFlight });
const { values: magnetCache, cached: cachedMagnet } = createCache(500, { inFlight });

// Troca de domínio invalida o que foi raspado do domínio antigo; o inFlight
// segue vivo para não quebrar o coalescing das promises em andamento.
siteSelector.onDomainChange(() => {
  postCache.clear();
  searchCache.clear();
  magnetCache.clear();
});

// Variante rica de entidades (WordPress), como no comandotorrents.
const extractMetaRefresh = (html) => sharedExtractMetaRefresh(html, decodeEntities);

// ---------------------------------------------------------------------------
// Query. O `search_posts` é LIKE sobre o título SEM ano; query com ano dá 0.
// `normalizeQuery` tira SxxEyy E ano de 4 dígitos antes de consultar — a
// variante dropYear é exclusiva da vaca (R-4).
// ---------------------------------------------------------------------------
const normalizeQuery = createNormalizeQuery({ dropYear: true });

function requestedSeasonFromQuery(value) {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

// ---------------------------------------------------------------------------
// Classificadores de qualidade/fonte (núcleo) e áudio PRÓPRIO: a vaca
// classifica pelo rótulo real e produz 'dual' ("Português | Inglês") — nada
// disso passa pelos hooks comuns de áudio (R-4).
// O matcher de fonte mantém o typo BLRAY do card vivo (R-4).
// ---------------------------------------------------------------------------
const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules({ matchPattern: VACA_SOURCE_MATCH_RE });

function classifyAudio(context) {
  const text = String(context || '').toUpperCase();
  const hasPt = /PORTUGU[ÊE]S|PORTUGUES/.test(text);
  const hasForeign = /INGL[ÊE]S|INGLES|ESPANHOL|JAPON[ÊE]S|COREANO|LEGENDAD|ORIGINAL/.test(text);
  if (hasPt) return hasForeign ? 'dual' : 'dublado';
  if (hasForeign) return 'legendado';
  return null;
}

// ---------------------------------------------------------------------------
// Episódio/pack: a vaca aceita \bbatch\b no pack e usa [.\-s]* (com "s"
// literal) na faixa — diferenças vivas dos cards publicados hoje (R-4).
// ---------------------------------------------------------------------------
const episodeRules = createEpisodeRules({
  packPattern: /\b(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|\bPACK\b|\bbatch\b)\b/i,
  rangePattern: /(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\-s]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b/i,
});
const extractEpisode = episodeRules.extractEpisode;
const episodeStep = createEpisodeStep({
  scope: 'anchor-writes',
  packRe: episodeRules.packPattern,
  rangeRe: episodeRules.rangePattern,
  epRe: episodeRules.episodePattern,
  extract: episodeRules.extractEpisode,
  // Padrão CRU /i: o matchAll lança TypeError no ramo de desempate —
  // comportamento vivo preservado (não troque pelo clone /g).
  packMatchAll: episodeRules.packPattern,
  tieBreak: true,
});

// ---------------------------------------------------------------------------
// extractMagnet reusa o padrão dos profiles irmãos (nenhum laço próprio).
// nextProtectedUrl adiciona o caso `const next` + decode inline de `q` do
// youtube redirect → t.co. O laço HTTP segue no transport.
// ---------------------------------------------------------------------------
// Variante RICA + passo do data-link em base64 (gate-2 vacadb) — a factory
// do núcleo parametriza exatamente isso (passo 3 do item 9).
const extractMagnet = createMagnetExtractor({
  decodeEntities,
  encodedVariants: true,
  b64DataLink: true,
});

// Lista de variáveis JS própria deste perfil (inclui LOCATION/next_url/next —
// unificar com as irmãs mudaria comportamento, R-6).
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LOCATION|next_url|target_url|dest|target|link|url|next)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

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

  // 4. Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
  return discoverNextUrl(str, baseUrl, {
    isProtectorHost,
    decodeEntities,
    protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
    jsVarPattern: JS_URL_VAR_RE,
  });
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
// Parse de âncoras systemtech (máquina de estados do núcleo
// createLinkCollector): cada âncora vira um "link" com url, qualidade, fonte,
// áudio, tamanho e contexto de episódio. `options.season` injeta a temporada
// da página e `options.realTitle` (batch) reescreve o título da release —
// extras próprios da vaca via extrasOf. O HTML é decodificado antes do
// casamento e o cursor AVANÇA nos descartes de URL/host, como no laço
// original; href vazio não avança.
// ---------------------------------------------------------------------------
const parseDownloadLinks = createLinkCollector({
  anchorRe: /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
  resolveHref: createProtectorHrefResolver({ isProtectorHost, decodeEntities, attribute }),
  anchorTextOf: (match) => stripTags(match[2] || ''),
  stripTags,
  decodeHtml: decodeEntities,
  initialAudio: null,
  audioFromSegment: classifyAudio,
  audioFromAnchor: classifyAudio,
  episodeStep,
  qualityFn: normalizeQuality,
  sourceFn: normalizeSource,
  extrasOf: (options) => ({ season: options.season ?? null, realTitle: options.realTitle ?? null }),
});

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

// Título da release via factory comum com hooks da vaca: ano re-injetado
// (proteção de ano do addon); batch usa o título real (`.bl-hero-title`) —
// pode ser de OUTRA série, então ano/temporada/episódio do post NÃO entram.
// audioTag DUAL é exclusivo da vaca (R-4).
const releaseTitle = createReleaseTitle({
  cleanTitle: cleanMarkTitle,
  titleOf: (post, link) => link?.realTitle || (typeof post === 'string' ? post : post?.title) || '',
  audioTagOf: (link) =>
    link?.audio === 'dublado' ? 'DUBLADO'
      : link?.audio === 'dual' ? 'DUAL'
        : link?.audio === 'legendado' ? 'LEGENDADO' : null,
  seasonOf: (post, link) => (!link?.realTitle && link?.season != null)
    ? `S${String(link.season).padStart(2, '0')}` : '',
  episodeOf: (post, link) => (!link?.realTitle && link?.episode != null)
    ? `E${String(link.episode).padStart(2, '0')}` : '',
  yearOf: (post, link) => (!link?.realTitle && post?.year) ? ` (${post.year})` : '',
});

// Página compacta com poster (sem alt) entre size e description.
const searchPageHtml = createSearchPageHtml({
  selfUrl: SELF_URL,
  escape: escapeHtml,
  releaseTitle,
  rowExtras: (post) => (post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}"></div>` : ''),
  descriptionOf: (post) => post.title || '',
});

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

// Sinal interno (não escapa do módulo): post/página interna sem link de
// download. O laço manual retornava [] SEM gravar no cache (o set só rodava
// depois do parse); para preservar isso sobre o cached() do núcleo, o loader
// sinaliza e o chamador converte em [] — o valor vazio nunca entra no mapa,
// como antes (chamadores coalescidos recebem o mesmo [] pela rejeição).
const NO_LINKS_SIGNAL = new Error('vacatorrent: sem link de download na página');

async function fetchMovieLinks(post) {
  const cacheKey = `movie:${post.url}`;
  try {
    return await cachedPost(cacheKey, POST_CACHE_MS, async () => {
      const pageHtml = await fetchText(post.url);
      const linksUrl = extractMovieLinks(pageHtml, post.url);
      if (!linksUrl) throw NO_LINKS_SIGNAL;
      const linksHtml = await fetchText(linksUrl);
      return parseDownloadLinks(linksHtml, linksUrl);
    });
  } catch (err) {
    if (err === NO_LINKS_SIGNAL) return [];
    throw err;
  }
}

async function fetchSeriesLinks(post, requestedSeason) {
  const seasonKey = requestedSeason ? String(requestedSeason[1]) : '';
  const cacheKey = `serie:${post.url}:${seasonKey}`;
  try {
    return await cachedPost(cacheKey, POST_CACHE_MS, async () => {
      const pageHtml = await fetchText(post.url);
      const internalUrl = seriesSeasonInternalUrl(pageHtml, post.url);
      if (!internalUrl) throw NO_LINKS_SIGNAL;
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
      return out;
    });
  } catch (err) {
    if (err === NO_LINKS_SIGNAL) return [];
    throw err;
  }
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
  return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
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
    return chunks.flat();
  });
}

// ---------------------------------------------------------------------------
// Resolve: segue o protetor até o magnet. O laço é do transport; o
// assertAllowedUrl injetado nele é o da factory (que delega ao protector.js).
// ---------------------------------------------------------------------------
const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
  decodeEntities, extractMagnet, nextProtectedUrl,
  extractMetaRefresh: (html) => extractMetaRefresh(html, decodeEntities),
  maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
  // Cookies de liberação do gatilhagem client-side. O JS (`liberar()`) setaria
  // `enc_liberado`/`enc_etapa1_visto` após o contador (teatro); aqui pré-semeamos
  // no host vacadb.org. O transport cria o jar e re-popula com esses pares via
  // o parser `harvest().from()`, além de continuar colhendo os `Set-Cookie` reais
  // (go.php/processar.php/_svu) durante a cadeia.
  cookieJar: { seed: { 'vacadb.org': { enc_liberado: '1', enc_etapa1_visto: '1' } } },
});

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
  return cachedMagnet(`best:${post.href}`, MAGNET_CACHE_MS, async () => {
    const links = await collectLinks(post.href);
    return tryLinksInOrder(
      [...links].sort((a, b) => scoreLink(b) - scoreLink(a)),
      (link) => fetchFollowingAllowed(link.url, post.href),
    );
  });
}

async function resolveButton(postUrl, index, hash, count) {
  const post = assertAllowedUrl(postUrl);
  const cacheKey = `magnet:${post.href}:${index}:${hash || ''}`;
  return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
    const links = await collectLinks(post.href);
    const link = pickButton(links, index, hash, count);
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  });
}

function scoreLink(link) {
  const audio = link.audio === 'dublado' || link.audio === 'dual' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  const source = /REMUX|BLU-?RAY/.test(link.source || '') ? 500 : /WEB/.test(link.source || '') ? 250 : 0;
  return audio + source + Number(link.quality || 0);
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------

// --- Rotas HTTP (esqueleto comum em resolver-http.js) ---
// A vaca expõe só /health, /search e /resolve — sem /api nem /dl.
// validateIndex fica OFF de propósito: ?i= inválido cai no pickButton e volta
// 'no_such_button' (502), como sempre — não vira 502 invalid_index (variante
// tdf/nerd). O unwrap carrega i/h/n pelos defaults da rota.
const handleRequest = createResolverRouter({
  reply,
  routes: {
    '/health': createHealthRoute({ reply }),
    '/search': createSearchRoute({ reply, search: searchPosts, renderHtml: searchPageHtml }),
    '/resolve': createResolveRoute({ reply, unwrapResolverUrl, resolveBest, resolveButton }),
  },
});

function createServer() {
  return createHttpServer(handleRequest);
}

if (require.main === module) {
  bootstrap.serveMain(createServer);
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