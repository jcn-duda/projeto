const { USER_AGENT } = require('../runtime');
const { createServer: createHttpServer } = require('../http-server');
const { createCache } = require('../cache');
const { capsXml: sharedCapsXml } = require('../torznab');
const {
  decodeEntitiesBasic,
  parseSize,
  escapeXml,
  attribute: attributeShared,
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
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');

const PORT = Number(process.env.PORT || 8702);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const CONCURRENCY = 4;
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_MS || 2 * 60_000);
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
const MAGNET_CACHE_MS = Number(process.env.MAGNET_CACHE_MS || 30 * 60_000);
// Tamanho desconhecido. Não é 0 nem ausente porque o Jackett descarta a release
// nos dois casos; o addon trata qualquer coisa <= 1 KB como "não sei".
const UNKNOWN_SIZE = '1 KB';
// SELF_URL é como o JACKETT alcança este serviço; SITE_URL é o default do site.
const decodeEntities = decodeEntitiesBasic;

const FALLBACK_SITE_SUFFIXES = [
  'xnerdfilmes.net',
  'nerdfilmestorrent.com',
  'nerdfilmestorrent.org',
  'nerdfilmestorrent.net',
  // Domínio atual (2026): o site responde 200 aqui após 301 do antigo.
  'nerdviatorrents.net',
];

// xnerdfilmes.net migrou para nerdviatorrents.net (301 permanente). Sem
// NERDFILMES_URL/SITE_URL no ambiente (o modo embutido não injeta nada), o
// default abaixo é o que o resolver tenta primeiro — deixá-lo no domínio velho
// faz o redirect cair na allowlist e a fonte morrer em silêncio.
//
// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos cinco perfis (leitura de env no require, seletor
// de failover, conjuntos de sufixos, trio de allowlist, wrappers cosméticos)
// nasce aqui, por chamada — sem estado de módulo compartilhado.
//
// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// NERDFILMES_URLS) como candidatos ATIVOS, não só allowlist: quando a busca
// falha por erro de rede (DNS/conexão/timeout — HTTP de erro prova que o
// host respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o
// primeiro candidato que responda 2xx. O vencedor fica imune a novo probe
// por BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
const bootstrap = createProfile({
  name: 'nerdfilmes',
  port: PORT,
  selfUrlEnv: 'http://nerdfilmes-resolver:8702',
  siteUrl: 'https://www.nerdviatorrents.net',
  siteUrlEnv: 'NERDFILMES_URL',
  urlsCsv: process.env.NERDFILMES_URLS,
  fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
  // O host rejeitado viaja na mensagem: sem ele o sintoma é "0 resultados" e
  // a causa (redirect para domínio fora da allowlist) só aparece auditando.
  blockedHostDetail: true,
  concurrency: CONCURRENCY,
  decodeEntities,
});

const {
  reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
} = bootstrap;
const { ALL_PROTECTOR_SUFFIXES, ALLOWED_SUFFIXES, unwrapResolverUrl } = bootstrap;
const {
  assertAllowedUrl, isDetailHost, isProtectorHost, isNetworkError, stripTags,
} = bootstrap;
const SELF_URL = bootstrap.selfUrl;

const { values: cache, inFlight, cached: cachedCore } = createCache(500);

// Troca de domínio invalida o que foi raspado do domínio antigo (chaves de
// cache são URLs absolutas); o inFlight segue vivo para não quebrar o
// coalescing das promises em andamento.
siteSelector.onDomainChange(() => {
  cache.clear();
});

async function cached(key, ttl, loader) {
  return cachedCore(key, ttl, loader);
}

// Variante BÁSICA da factory: o passo encoded EXIGE `xt%3D` e para no `&` —
// fixture do br-parsers.test.ts fixa isso; não troque por encodedVariants:true.
const extractMagnet = createMagnetExtractor({ decodeEntities });

// Lista de variáveis JS própria deste perfil (a rica casa a mais — R-6).
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

function nextProtectedUrl(html, baseUrl) {
  if (!html) return null;
  // Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
  return discoverNextUrl(String(html), baseUrl, {
    isProtectorHost,
    decodeEntities,
    protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
    jsVarPattern: JS_URL_VAR_RE,
  });
}

async function fetchText(value, referer) {
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
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`http_${response.status}`);
    return { html: await response.text(), url: current.href };
  }
  throw new Error('too_many_redirects');
}

const attribute = (tag, name) => attributeShared(tag, name, { decode: decodeEntities, allowWhitespace: true });

function normalizeSource(value) {
  const source = String(value || '').toUpperCase().replace(/[. ]/g, '-');
  if (source.startsWith('BLU')) return 'BluRay';
  if (source.startsWith('WEB-DL')) return 'WEB-DL';
  if (source.startsWith('WEB-RIP')) return 'WEBRip';
  if (source === 'HDTV') return 'HDTV';
  return null;
}

/** Resultados da busca WordPress: article.col > .item > .image > a. */
function parsePosts(html) {
  const posts = [];
  const article = /<article\b[^>]*class=["'][^"']*\bcol\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = article.exec(html))) {
    const image = match[1].match(
      /<div\b[^>]*class=["'][^"']*\bimage\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    const anchor = image?.[1].match(/<a\b[^>]*>/i);
    const url = anchor ? attribute(anchor[0], 'href') : null;
    const title = anchor ? attribute(anchor[0], 'title') : null;
    const clean = title ? stripTags(title) : null;
    if (url && clean && !isGenericListPost(clean) && !posts.some((post) => post.url === url)) {
      posts.push({ url, title: clean });
    }
  }
  return posts;
}

function cleanPostTitle(title = '') {
  return String(title)
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)?\s*/gi, ' ')
    .replace(/\b(?:720p|1080p|2160p|4K)(?:\s*\/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Scheme de URI é case-insensitive (RFC 3986) e o site pode publicar MAGNET:.
// Reconhecer nas duas caixas é só metade: o filtro regexp do cardigann
// (`magnet:\?…`) e o cliente de torrent esperam o scheme minúsculo, então todo
// magnet é normalizado na SAÍDA do resolver — aceitar sem normalizar apenas
// moveria a falha para depois do Jackett.
function hasMagnetScheme(value) {
  return /^magnet:/i.test(String(value || ''));
}

function normalizeMagnetScheme(value) {
  return String(value).replace(/^magnet:/i, 'magnet:');
}

// Magnet direto no href só é aceito se QUALQUER parâmetro xt (nome
// case-insensitive) for urn:btih com hash 40 hex ou 32 base32, em qualquer
// posição dos parâmetros (um xt=urn:btmh pode vir antes do btih). Tudo mais
// segue a allowlist de http(s).
function isValidDirectMagnet(value) {
  const href = String(value || '');
  if (!hasMagnetScheme(href)) return false;
  let u;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== 'magnet:') return false;
  for (const [name, xt] of u.searchParams.entries()) {
    if (name.toLowerCase() !== 'xt') continue;
    const btihMatch = xt.match(/^urn:btih:(.+)$/i);
    if (!btihMatch) continue;
    const hash = btihMatch[1];
    if (/^[0-9a-f]{40}$/i.test(hash) || /^[A-Z2-7]{32}$/i.test(hash)) return true;
  }
  return false;
}

/** Cada botão protegido representa uma qualidade/tamanho diferente. */
function parseDownloadLinks(html) {
  const links = [];
  const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  let cursor = 0;
  let currentAudio = 'desconhecido';
  let currentEpisode = null;

  while ((match = anchor.exec(html))) {
    const tag = match[0].match(/<a\b[^>]*>/i)?.[0] || '';
    const rawHref = attribute(tag, 'href');
    if (!rawHref) continue;
    const href = decodeEntities(rawHref);
    const isDirectMagnet = isValidDirectMagnet(href);
    if (!isDirectMagnet) {
      let u;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (!isProtectorHost(u.hostname)) continue;
    }
    const rawSegment = html.slice(cursor, match.index);
    const segment = stripTags(rawSegment).toUpperCase();
    const anchorText = stripTags(match[0]).toUpperCase();
    cursor = anchor.lastIndex;

    // Audio/episódio da própria âncora. Magnets diretos (ex. "S01.1080p |
    // Episódio 01 | Dual Áudio") carregam tudo no texto do botão; estes valores
    // ficam locais e não vazam para o estado das âncoras seguintes.
    const selfAudioMarker = [...anchorText.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*|PORTUGU[ÊE]S)/g)].pop();
    const selfAudio = selfAudioMarker
      ? /LEGENDAD/.test(selfAudioMarker[1]) ? 'legendado' : 'dublado'
      : null;
    let selfEpisode = null;
    let selfEpisodeComplete = false;
    if (/TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA/i.test(anchorText)) {
      // Temporada inteira no próprio botão: episódio é null por definição,
      // sem herdar currentEpisode das âncoras anteriores.
      selfEpisodeComplete = true;
    } else {
      const selfEp = [...anchorText.matchAll(/(?:EPIS[ÓO]DIO|EP)\s*(\d{1,3})\b/gi)].pop();
      if (selfEp) selfEpisode = Number(selfEp[1]);
    }

    // Inferência legada pelo texto anterior ao botão (protetores antigos).
    const audioMarker = [...segment.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*|PORTUGU[ÊE]S)/g)].pop();
    if (audioMarker) {
      currentAudio = /LEGENDAD/.test(audioMarker[1]) ? 'legendado' : 'dublado';
    }

    if (/TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA/i.test(segment)) {
      currentEpisode = null;
    } else {
      const epMatch = [...segment.matchAll(/(?:EPIS[ÓO]DIO|EP)\s*(\d{1,3})\b/gi)].pop();
      if (epMatch) {
        currentEpisode = Number(epMatch[1]);
      }
    }

    const context = `${segment} ${anchorText}`;
    const qualities = [...context.matchAll(/(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g)];
    const qualityHit = qualities.pop();
    const sizes = [...context.matchAll(/([\d.,]+)\s*(TB|GB|MB|KB)\b/g)];
    const sizeHit = sizes.pop();
    const sourceHit = [...context.matchAll(/(WEB[-. ]?DL|WEB[-. ]?RIP|BLU[- ]?RAY|HDTV)/g)].pop();

    // Magnet direto ou protetor: usa primeiro o metadado do próprio botão, com
    // fallback no estado legado. O valor local nunca é persistido no estado,
    // então não contamina os metadados das âncoras seguintes.
    const audio = selfAudio || currentAudio;
    const episode = selfEpisodeComplete ? null : (selfEpisode ?? currentEpisode);

    links.push({
      url: href,
      quality: qualityHit ? (qualityHit[1] ? Number(qualityHit[1]) : 2160) : null,
      size: sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null,
      audio,
      episode,
      source: sourceHit ? normalizeSource(sourceHit[1]) : null,
    });
  }
  return links;
}

function parsePostDate(html) {
  const meta = String(html).match(
    /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*>/i,
  );
  const content = meta ? attribute(meta[0], 'content') : null;
  const json = String(html).match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const date = new Date(content || json || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// O laço do protetor é UM só (transport); o perfil aporta apenas os parsers.
// O assertAllowedUrl injetado no laço é o da factory (que delega ao
// protector.js) — nunca uma checagem reimplementada aqui.
const fetchFollowingAllowed = bootstrap.fetchFollowingAllowed({
  decodeEntities, extractMagnet, nextProtectedUrl,
  extractMetaRefresh: (html) => sharedExtractMetaRefresh(html, decodeEntities),
  maxHops: MAX_HOPS, timeoutMs: TIMEOUT_MS,
});

async function getPostLinks(postUrl) {
  const post = assertAllowedUrl(postUrl);
  if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
  return cached(`post:${post.href}`, POST_CACHE_MS, async () => {
    const { html } = await fetchText(post.href);
    return { post, links: parseDownloadLinks(html), date: parsePostDate(html) };
  });
}

function scoreLink(link) {
  const audio = link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  return audio + Number(link.quality || 0);
}

async function resolveBest(postUrl) {
  return cached(`magnet:best:${postUrl}`, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const ordered = [...links].sort((a, b) => scoreLink(b) - scoreLink(a));
    let lastError;
    for (const link of ordered) {
      try {
        return await fetchFollowingAllowed(link.url, post.href);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no_protector');
  });
}

async function resolveButton(postUrl, index, hash, count) {
  return cached(hash ? `magnet:${postUrl}:${index}:${hash}` : `magnet:${postUrl}:${index}`, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = pickButton(links, index, hash, count);
    if (!link) throw new Error('no_such_button');
    return fetchFollowingAllowed(link.url, post.href);
  });
}

// Mantém a assinatura histórica de 3 argumentos: o searchPipeline passa o
// limite junto na chamada.
const mapLimit = (items, limit, fn) => bootstrap.mapLimit(items, fn, { limit });

/**
 * Seleção pura de posts: parsePosts -> matchesResolverQuery (título) -> filtro
 * de temporada corrente -> slice(MAX_POSTS). A temporada entra ANTES do corte
 * para não perder a temporada pedida quando 5 posts errados vêm primeiro — do
 * contrário o slice(MAX_POSTS) jogava fora exatamente a do usuário.
 */
const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

/**
 * Pipeline comum aos dois caminhos (/api e /search) para não deixar drift:
 * ambiguidades vêm antes das decisões que o addon toma depois. A seleção é o
 * passo <b>antes</b> da parte cara; só se pagam protetores de link nos posts
 * que passaram. Devolve { posts, items } para o chamador formatar.
 */
async function searchPipeline(sourceHtml, query, requestedSeason) {
  const posts = selectSearchPosts(sourceHtml, query, requestedSeason);
  const chunks = await mapLimit(posts, CONCURRENCY, async (post) => {
    const { links, date } = await getPostLinks(post.url);
      return links.map((link, index) => ({ post: { ...post, date }, link, index, count: links.length }));
  });
  return { posts, items: chunks.flat() };
}

function releaseTitle(postTitle, link, index = null) {
  const clean = cleanPostTitle(typeof postTitle === 'string' ? postTitle : postTitle?.title || '');
  const epPart = link.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const audioTag = link.audio === 'dublado' ? 'DUBLADO' : link.audio === 'legendado' ? 'LEGENDADO' : null;
  const tags = [
    link.quality ? `${link.quality}p` : null,
    link.source,
    audioTag,
    link.size || (index == null ? null : `opção ${index + 1}`),
  ].filter(Boolean);

  const base = epPart ? `${clean} ${epPart}` : clean;
  return tags.length ? `${base} [${tags.join(' ')}]` : base;
}

function searchPageHtml(items) {
  const rows = items
    .map(({ post, link, index, count }) => {
      const download = `${SELF_URL}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
      // O Jackett descarta QUALQUER release sem tamanho ("No size provided"), e
      // "0 B" não casa o filtro de `size` do cardigann. UNKNOWN_SIZE satisfaz o
      // Jackett e o addon o esconde em vez de exibir um tamanho inventado.
      return `<div class="release"><div class="title"><a href="${escapeXml(download)}">${escapeXml(releaseTitle(post.title, link, index))}</a></div><div class="size">${escapeXml(link.size || UNKNOWN_SIZE)}</div>${post.date ? `<div class="date">${escapeXml(post.date)}</div>` : ''}<div class="description">${escapeXml(post.title)}</div><div class="seeders">1</div></div>`;
    })
    .join('');
  return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
}

function pubDate(post) {
  const explicit = new Date(post.date || '');
  if (!Number.isNaN(explicit.getTime())) return explicit.toUTCString();
  const year = String(post.title || '').match(/\b((?:19|20)\d{2})\b/)?.[1];
  return new Date(Date.UTC(Number(year || 2000), 0, 1)).toUTCString();
}

function capsXml() {
  return sharedCapsXml('NerdFilmesTorrent / XNerdFilmes');
}

function rssXml(items, category) {
  const body = items
    .map(({ post, link, index, count }) => {
      const download = `${SELF_URL}/dl?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
      const size = parseSize(link.size) || 0;
      return `    <item>
      <title>${escapeXml(releaseTitle(post.title, link))}</title>
      <guid isPermaLink="false">${escapeXml(download)}</guid>
      <link>${escapeXml(download)}</link>
      <comments>${escapeXml(post.url)}</comments>
      <pubDate>${pubDate(post)}</pubDate>
      <size>${size}</size>
      <category>${category}</category>
      <torznab:attr name="category" value="${category}"/>
      <torznab:attr name="size" value="${size}"/>
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
    <title>NerdFilmesTorrent / XNerdFilmes</title>
${body}
  </channel>
</rss>`;
}

// O download.before do cardigann encoda a href inteira no param url — e a
// href já é um /resolve nosso, então o alvo real vem aninhado. Desempacota
// quantos níveis vierem, carregando i/h/n do nível mais interno que os
// declarar. `seed` são os params da requisição externa: chamada direta
// (/resolve?url=<post>&i=0&h=..) não tem nível interno de onde ler.
// Sem checar a origem: o host varia (`addon` embutido vs. nome do
// container), e o alvo final passa por assertAllowedUrl de todo jeito.
// (A variante com defaults do núcleo está no unwrapResolverUrl da factory.)


// Busca WordPress com nota de saúde para o failover de domínio: sucesso zera
// o streak; erro de rede (DNS/conexão/timeout) acumula e pode disparar o
// probe. Comum aos dois modos (/api torznab e /search cardigann).
async function fetchSearchHtml(query) {
  try {
    const { html } = await fetchText(`${siteSelector.url()}/?s=${encodeURIComponent(query)}`);
    siteSelector.noteSuccess();
    return html;
  } catch (err) {
    if (isNetworkError(err)) await siteSelector.noteFailure();
    // Redirect permanente para domínio fora da allowlist vira fonte morta
    // silenciosa (o failover só reage a erro de rede). O warn distinto —
    // citando o host rejeitado — é o que impede a próxima descoberta tardia.
    else if (String(err.message || err).startsWith('blocked_host')) {
      console.warn(`[nerdfilmes] busca em ${siteSelector.url()} bloqueada: ${err.message} — domínio novo fora da allowlist?`);
    }
    throw err;
  }
}

async function handleApi(url, response) {
  const type = url.searchParams.get('t') || 'caps';
  if (type === 'caps') return reply(response, 200, capsXml(), 'application/xml; charset=utf-8');
  if (!['search', 'movie', 'tvsearch'].includes(type)) return reply(response, 400, 'unsupported_t');
  const rawQuery = String(url.searchParams.get('q') || '');
  const requestedSeason = rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const query = rawQuery
    .replace(/[sS]\d{1,2}(?:[eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const category = type === 'tvsearch' ? 5000 : 2000;
  if (!query) return reply(response, 200, rssXml([], category), 'application/xml; charset=utf-8');

  try {
    const xml = await cached(`search:${type}:${rawQuery}`, SEARCH_CACHE_MS, async () => {
      const html = await fetchSearchHtml(query);
      const { posts, items } = await searchPipeline(html, query, requestedSeason);
      const seen = new Set();
      const filtered = items.filter(({ post, link }) => {
        const key = `${post.url}|${link.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      console.log(`[api] "${query}" → ${posts.length} post(s), ${filtered.length} release(s)`);
      return rssXml(filtered, category);
    });
    return reply(response, 200, xml, 'application/xml; charset=utf-8');
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

async function handleSearch(url, response) {
  const rawQuery = String(url.searchParams.get('q') || '');
  const requestedSeason = rawQuery.match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const query = rawQuery
    .replace(/[sS]\d{1,2}(?:[eE]\d{1,2})?/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query) return reply(response, 200, searchPageHtml([]), 'text/html; charset=utf-8');
  try {
    const html = await cached(`search-html:${rawQuery}`, SEARCH_CACHE_MS, async () => {
      const source = await fetchSearchHtml(query);
      const { posts, items } = await searchPipeline(source, query, requestedSeason);
      console.log(`[search] "${query}" → ${posts.length} post(s), ${items.length} release(s)`);
      return searchPageHtml(items);
    });
    return reply(response, 200, html, 'text/html; charset=utf-8');
  } catch (error) {
    return reply(response, 502, error.message);
  }
}

function createServer() {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method !== 'GET') return reply(response, 404, 'not_found');
    if (url.pathname === '/health') return reply(response, 200, 'ok');
    if (url.pathname === '/api') return handleApi(url, response);
    if (url.pathname === '/search') return handleSearch(url, response);
    if (url.pathname === '/resolve') {
      let postUrl = url.searchParams.get('url');
      if (!postUrl || postUrl.length > 4096) return reply(response, 400, 'invalid_url');
      try {
        const unwrapped = unwrapResolverUrl(postUrl, {
          index: url.searchParams.get('i'),
          hash: url.searchParams.get('h'),
          count: url.searchParams.get('n'),
        });
        postUrl = unwrapped.url;
        const { index, hash, count } = unwrapped;
        const button = index == null ? null : Number(index);
        if (button != null && (!Number.isInteger(button) || button < 0)) throw new Error('invalid_index');
        return reply(response, 200, button == null ? await resolveBest(postUrl) : await resolveButton(postUrl, button, hash, count));
      } catch (error) {
        return reply(response, 502, error.message);
      }
    }
    if (url.pathname === '/dl') {
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
    return reply(response, 404, 'not_found');
  });
}

if (require.main === module) {
  bootstrap.serveMain(createServer);
}

module.exports = {
  createServer,
  parsePosts,
  parseDownloadLinks,
  parsePostDate,
  parseSize,
  releaseTitle,
  pubDate,
  searchPageHtml,
  assertAllowedUrl,
  extractMagnet,
  nextProtectedUrl,
  isDetailHost,
  isProtectorHost,
  isValidDirectMagnet,
  getPostLinks,
  fetchFollowingAllowed,
  siteSelector,
  createSiteSelector,
  isNetworkError,
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  selectSearchPosts,
  buttonId,
  pickButton,
  unwrapResolverUrl,
  isGenericListPost,
  cache,
  inFlight,
};
