const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
const { createServer: createHttpServer } = require('../http-server');
const {
  decodeEntities,
  escapeHtml,
  parseSize,
  attribute,
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
const { createProfile } = require('../site-profile');
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');

const PORT = Number(process.env.PORT || 8701);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 5 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);

const FALLBACK_SITE_SUFFIXES = [
  'comandotorrents.to',
  'comandotorrents.net',
  'comandotorrents.org',
];

// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos cinco perfis (leitura de env no require, seletor
// de failover, conjuntos de sufixos, trio de allowlist, wrappers cosméticos)
// nasce aqui, por chamada — sem estado de módulo compartilhado.
//
// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// COMANDOTORRENTS_URLS) como candidatos ATIVOS, não só allowlist: quando a
// busca falha por erro de rede (DNS/conexão/timeout — HTTP de erro prova que
// o host respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o
// primeiro candidato que responda 2xx. O vencedor fica imune a novo probe
// por BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
const bootstrap = createProfile({
  name: 'comandotorrents',
  port: PORT,
  selfUrlEnv: 'http://comandotorrents-resolver:8701',
  siteUrl: 'https://comandotorrents.to',
  siteUrlEnv: 'COMANDOTORRENTS_URL',
  urlsCsv: process.env.COMANDOTORRENTS_URLS,
  fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
  concurrency: 3,
  decodeEntities,
});

const {
  reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
} = bootstrap;
const { ALL_PROTECTOR_SUFFIXES, ALLOWED_SUFFIXES, unwrapResolverUrl, mapLimit } = bootstrap;
const {
  assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError, stripTags,
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

function normalizeQuery(value) {
  return String(value || '')
    .replace(/\b[sS]\d{1,2}(?:[eE]\d{1,2})?\b/gi, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

// Variante RICA da factory: lista de variáveis ampliada, variante URL-encoded
// dentro das aspas, `data-download` e encoded sem exigir xt nem cortar no `&`.
const extractMagnet = createMagnetExtractor({ decodeEntities, encodedVariants: true });

// Lista de variáveis JS própria deste perfil (a básica casa a menos — R-6).
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|LINK_FINAL|TARGET_URL|DESTINO|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

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

  // 2. Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
  return discoverNextUrl(str, baseUrl, {
    isProtectorHost,
    decodeEntities,
    protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
    jsVarPattern: JS_URL_VAR_RE,
  });
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

// O laço do protetor é UM só (transport); o perfil aporta apenas os parsers.
// O assertAllowedUrl injetado no laço é o da factory (que delega ao
// protector.js) — nunca uma checagem reimplementada aqui.
const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
  decodeEntities, extractMagnet, nextProtectedUrl, extractMetaRefresh,
  maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
});

async function getPostLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
  return cachedPost(post.href, POST_CACHE_MS, async () => {
    const response = await fetch(post, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return { post, links: parseDownloadLinks(await response.text(), post.href) };
  });
}

function scoreLink(link) {
  return (link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000) + (link.quality || 0);
}

async function resolveBest(postUrl) {
  return cachedMagnet(`magnet:best:${postUrl}`, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    let lastError;
    for (const link of [...links].sort((a, b) => scoreLink(b) - scoreLink(a))) {
      try {
        return await fetchFollowingAllowed(link.url, post.href);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no_magnet');
  });
}

async function resolveButton(postUrl, index, hash, count) {
  const cacheKey = hash ? `magnet:${postUrl}:${index}:${hash}` : `magnet:${postUrl}:${index}`;
  return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = Number.isInteger(index) && index >= 0 ? pickButton(links, index, hash, count) : null;
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  });
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
  const rows = items.map(({ post, link, index, count }) => {
    const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
    return `<div class="release"><div class="title"><a href="${escapeHtml(download)}">${escapeHtml(releaseTitle(post, link, index))}</a></div><div class="size">${escapeHtml(link.size || UNKNOWN_SIZE)}</div>${post.poster ? `<div class="poster"><img src="${escapeHtml(post.poster)}"></div>` : ''}<div class="description">${escapeHtml(post.title)}</div><div class="seeders">1</div></div>`;
  }).join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}


// `seed` são os params da requisição externa: chamada direta
// (/resolve?url=<post>&i=0&h=..) não tem nível aninhado de onde ler.
// (A variante com defaults do núcleo está no unwrapResolverUrl da factory.)

async function searchPosts(query) {
  const requestedSeason = String(query || '').match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const cacheKey = `search:${String(query || '')}`;

  return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
    try {
      const source = await fetch(`${siteSelector.url()}/?s=${encodeURIComponent(normalized)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!source.ok) throw new Error(`http_${source.status}`);
      // Sucesso da busca zera o streak ANTES de raspar posts/protetores:
      // queda do protetor não conta como falha do domínio.
      siteSelector.noteSuccess();
      const posts = selectSearchPosts(await source.text(), normalized, requestedSeason);
      const chunks = await mapLimit(posts, async (post) => {
        try {
          const { links } = await getPostLinks(post.url);
          return links.map((link, index) => ({ post, link, index, count: links.length }));
        } catch (err) {
          console.warn(`[search] Falha ao obter links do post ${post.url}: ${err.message}`);
          return [];
        }
      });
      return chunks.flat();
    } catch (err) {
      // Só erro de rede (DNS/conexão/timeout) alimenta o failover: 0
      // resultados ou HTTP de erro não dizem nada sobre o domínio.
      if (isNetworkError(err)) await siteSelector.noteFailure();
      throw err;
    }
  });
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
  bootstrap.serveMain(createServer);
}

module.exports = {
  createServer,
  // Exposto para o painel ler o domínio ATIVO (o failover troca em runtime).
  siteSelector,
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
  buttonId,
  pickButton,
  unwrapResolverUrl,
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  selectSearchPosts,
  createSiteSelector,
  isNetworkError,
  postCache,
  searchCache,
  magnetCache,
  inFlight,
};
