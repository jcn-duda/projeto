const { USER_AGENT } = require('../runtime');
const { createCache } = require('../cache');
// Passo 6 do item 9: a mecânica FlareSolverr (fetchTextViaFlare,
// buildFlareHeaders, getFlareSession, buildCookies e a derivação do desafio
// CF) mora no núcleo (resolvers/flare.js) — aqui só o cabeamento. O desafio
// do 403 é reconhecido pelo núcleo (isCloudflareChallenge); o perfil mantém
// o fetchText com o redirect-follow e o timeout próprios.
const { createFlareFetcher, isCloudflareChallenge } = require('../flare');
const { createServer: createHttpServer } = require('../http-server');
// Passo 5 do item 9: esqueleto de roteador HTTP comum — despacho por pathname
// + rotas padrão (/health, /search, /resolve, /dl, /api). O /resolve do bludv
// tem prefs audio=/quality= e fica no perfil, como handler direto do mapa.
const {
  createResolverRouter, createHealthRoute, createSearchRoute,
  createDlRoute, createApiRoute,
} = require('../resolver-http');
const { capsXml: sharedCapsXml } = require('../torznab');
const {
  decodeEntities,
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
const { createProfile } = require('../site-profile');
// Passo 3 do item 9: extractMagnet e o bloco genérico do nextProtectedUrl
// vivem no núcleo (resolvers/magnet-extract.js), parametrizados por perfil.
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');
// Passo 4 do item 9: classificadores, máquina de estados da âncora
// (release-rules.js) e títulos/feeds/laço de fallback (release-format.js).
const {
  createQualityRules, createSourceRules, createBrAudioHooks,
  createEpisodeRules, createEpisodeStep, createLinkCollector,
} = require('../release-rules');
const {
  UNKNOWN_SIZE, cleanPostTitle, createReleaseTitle, createRssXml,
  createNormalizeQuery, tryLinksInOrder, magnetButtonCacheKey,
} = require('../release-format');

const PORT = Number(process.env.PORT || 8700);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15_000);
const MAX_HOPS = 6;

// --- Modo indexer Torznab ---
// SELF_URL é como o JACKETT alcança este serviço (nome DNS na rede Docker);
// os links de download do feed apontam pra cá e são resolvidos sob demanda.
// O site troca de domínio com frequência; alinhar com o links: do cardigann —
// o valor de fallback é o PRIMÁRIO, e em runtime o siteSelector faila para os
// demais candidatos (csv BLUDV_URLS + FALLBACK_SITE_SUFFIXES) quando ele cai.
const MAX_POSTS = Number(process.env.BLUDV_MAX_POSTS || 5);
// Busca repete muito (o Stremio refaz a consulta); 5 min evitam re-raspar o
// site a cada retry. Magnet é imutável por definição; 30 min poupam a cadeia
// do protetor inteira a cada play do mesmo botão.
const POST_CACHE_MS = Number(process.env.POST_CACHE_MS || 10 * 60_000);
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

const FALLBACK_SITE_SUFFIXES = [
  'bludvfilmes.xyz',
  'bludvfilmes1.xyz',
  'bludv.net',
  'bludv.xyz',
  'bludv.to',
];

// --- Bootstrap comum (site-profile) ---
// Toda a montagem repetida nos cinco perfis (leitura de env no require, seletor
// de failover, conjuntos de sufixos, trio de allowlist, wrappers cosméticos)
// nasce aqui, por chamada — sem estado de módulo compartilhado.
//
// --- Failover de domínio em runtime ---
// O SITE_URL era const lida no boot: domínio morto = fonte morta até editar
// .env + restart. O seletor trata os FALLBACK_SITE_SUFFIXES (e o csv
// BLUDV_URLS) como candidatos ATIVOS, não só allowlist: quando a busca falha
// por erro de rede (DNS/conexão/timeout — HTTP de erro prova que o host
// respondeu) N vezes seguidas, um probe GET /?s=teste escolhe o primeiro
// candidato que responda 2xx. O vencedor fica imune a novo probe por
// BR_DOMAIN_PROBE_TTL_MS (sondar de novo não ressuscita site caído) e o
// probe nunca roda no require — módulo carregado em teste não tem rede.
const bootstrap = createProfile({
  name: 'bludv',
  port: PORT,
  selfUrlEnv: 'http://bludv-resolver:8700',
  siteUrl: 'https://bludvfilmes.xyz',
  siteUrlEnv: 'BLUDV_URL',
  urlsCsv: process.env.BLUDV_URLS,
  fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
  // Erros do FlareSolverr chegam com prefixo flare_ e são excluídos do
  // isNetworkError: falha do resolvedor de challenge não é o site fora do ar,
  // e o failover de domínio não pode morder por causa dela.
  networkErrorExtra: '|flare_',
  concurrency: 4,
  // O download.before do cardigann encoda a href inteira no param url — e a
  // href já é um /resolve nosso, então o alvo real vem aninhado. Aqui os
  // níveis aninhados também podem vir por /dl e carregar audio/quality.
  unwrapOptions: {
    paths: ['/resolve', '/dl'],
    fields: { index: 'i', hash: 'h', count: 'n', audio: 'audio', quality: 'quality' },
  },
  decodeEntities,
});

const {
  reply, siteSelector, CANDIDATE_HOSTS, createSiteSelector,
} = bootstrap;
const { ALL_PROTECTOR_SUFFIXES, ALLOWED_SUFFIXES, unwrapResolverUrl } = bootstrap;
const {
  assertAllowedUrl, isDetailHost, isProtectorHost,
  isNetworkError, stripTags,
} = bootstrap;
const SELF_URL = bootstrap.selfUrl;

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
// hostname -> { cookies, userAgent, expiresAt } — sessões nascem aqui (R-2);
// os knobs de env continuam sendo lidos no require do perfil, como antes.
const flare = createFlareFetcher({
  solverUrl: FLARE_SOLVERR_URL,
  timeoutMs: FLARE_TIMEOUT_MS,
  sessionTtlMs: FLARE_SESSION_TTL_MS,
  userAgent: USER_AGENT,
});
const { sessions: flareSessions, getFlareSession, buildFlareHeaders, fetchTextViaFlare } = flare;

// --- Cache (núcleo resolvers/cache.js) ---
// TTL + coalescing + FIFO, escrevendo APENAS no sucesso (erro nunca entra no
// mapa — contrato fixado pelo teste "postCache must not store errors"). Os
// três mapas compartilham UM inFlight: é o shape que testes e harnesses
// consomem (limpam e contam `mod.inFlight` diretamente).
const inFlight = new Map();
const { values: postCache, cached: cachedPost } = createCache(MAX_CACHE_SIZE, { inFlight });
const { values: searchCache, cached: cachedSearch } = createCache(MAX_SEARCH_CACHE_SIZE, { inFlight });
const { values: magnetCache, cached: cachedMagnet } = createCache(MAX_MAGNET_CACHE_SIZE, { inFlight });

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

// Faixa "Episódios 01 ao 10" é PACK: quem casa por episódio no addon precisa
// ver episode null, não o 10 (senão vira um episódio de temporada inteira).
// Padrões, extração e a máquina de estados da âncora são do núcleo
// (release-rules.js); aqui só o cabeamento, com o escopo anchor-local: o
// sinal da âncora vale SÓ para o próprio botão.
const episodeRules = createEpisodeRules();
const extractEpisode = episodeRules.extractEpisode;
const episodeStep = createEpisodeStep({
  scope: 'anchor-local',
  packRe: episodeRules.packPattern,
  rangeRe: episodeRules.rangePattern,
  epRe: episodeRules.episodePattern,
  extract: episodeRules.extractEpisode,
  packMatchAll: episodeRules.packPatternG,
  tieBreak: true,
});

// Variante RICA da factory: lista de variáveis ampliada, variante URL-encoded
// dentro das aspas, `data-download` e encoded sem exigir xt nem cortar no `&`.
// (O decodeMaybeEncoded local virou o decodeEncodedValue do núcleo.)
const extractMagnet = createMagnetExtractor({ decodeEntities, encodedVariants: true });

// Lista de variáveis JS própria deste perfil (a básica casa a menos — R-6).
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|LINK_FINAL|TARGET_URL|DESTINO|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

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

  // 2. Bloco genérico (variável JS de protetor + busca por sufixos) → núcleo.
  return discoverNextUrl(str, baseUrl, {
    isProtectorHost,
    decodeEntities,
    protectorSuffixes: ALL_PROTECTOR_SUFFIXES,
    jsVarPattern: JS_URL_VAR_RE,
  });
}

// getFlareSession, buildCookies, buildFlareHeaders e fetchTextViaFlare são do
// núcleo (flare.js, passo 6 do item 9) — reexportados abaixo com os mesmos
// nomes (R-9: o bludv-resolver.test.ts consome esses exports com 403-CF).

async function fetchText(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: buildFlareHeaders(url, referer),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 403 do Cloudflare ("Just a moment...") não é o site fora do ar: é o desafio
  // JS que o fetch direto não executa. Re-resolve pelo FlareSolverr. Mas 403 por
  // outro motivo (rate-limit, bloqueio de região/proxy) não é desafio e virar
  // página de erro do FlareSolverr silenciaria a falha em "0 resultados" — a
  // derivação (header cf-mitigated OU marcadores no corpo) é do núcleo.
  if (res.status === 403) {
    const body = await res.text();
    if (isCloudflareChallenge(res, body)) {
      return fetchTextViaFlare(url, referer);
    }
    throw new Error(`http_403`);
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}

// Classificadores de áudio (hooks de segmento/âncora), qualidade e fonte são
// os compartilhados (release-rules.js) — idênticos nos cinco perfis que os
// usam; aqui só o cabeamento.
const { audioFromSegment, audioFromAnchor } = createBrAudioHooks();
const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules();

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
 * (áudio do <h3> e episódio do segmento) e extrai cada botão Magnet-Link —
 * máquina de estados comum no núcleo (createLinkCollector, release-rules.js).
 *
 * Metadados que moram NO TEXTO DA ÂNCORA ("S01.1080p | Episódio 01 | Dual
 * Áudio", o layout de magnet direto) valem SÓ para o próprio botão: são
 * calculados locais e não vão para o estado, senão um botão avulso
 * contaminaria todos os seguintes. O segmento continua escrevendo no estado,
 * como sempre fez — é o que preserva a semântica de seção dos posts antigos.
 *
 * O regex de âncora aceita aspas simples e duplas (o tema emite as duas) e
 * atributos antes do href; só entra magnet com btih válido (validador próprio
 * deste perfil, abaixo) e http(s) continua exigindo host de protetor.
 * Falha de validação NUNCA avança o cursor (advance ausente): o segmento do
 * botão descartado continua valendo para o seguinte, como no laço original.
 */
const parseDownloadLinks = createLinkCollector({
  anchorRe: /<a\s+[^>]*?href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
  resolveHref: (match) => {
    // A URI decodificada É o download: o magnet resolve no cliente de torrent,
    // sem fetch — o href vira o url do botão direto.
    const href = decodeEntities(match[2].trim());
    // Magnet malformado, sem btih ou só com btmh cai no branch http e morre no
    // allowlist (hostname do magnet é vazio, nunca é protetor).
    if (isValidMagnetUri(href)) return { url: href };
    let u;
    try {
      u = new URL(href);
    } catch {
      return { skip: true };
    }
    if (!isProtectorHost(u.hostname)) return { skip: true };
    return { url: href };
  },
  anchorTextOf: (match) => stripTags(match[3]),
  stripTags,
  initialAudio: 'desconhecido',
  audioFromSegment,
  audioFromAnchor,
  episodeStep,
  qualityFn: normalizeQuality,
  sourceFn: normalizeSource,
});

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
    const html = await fetchText(post);
    return { post, links: parseDownloadLinks(html) };
  });
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
  // A chave inclui as preferências: /resolve aceita audio= e quality=, e chave
  // sem prefs serviria o magnet da primeira preferência para quem pediu a
  // segunda.
  const cacheKey = `magnet:best:${postUrl}:${prefs.audio || ''}:${prefs.quality || ''}`;
  // Log de hit preservado do laço manual (o cached() do núcleo não loga).
  const hit = magnetCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) console.log(`[cache] hit magnet(best) ${postUrl}`);

  return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const sorted = sortLinks(links, prefs).slice(0, MAX_RESOLVE_ATTEMPTS);
    if (!sorted.length) throw new Error('no_protector');
    console.log(
      `[resolve] ${links.length} botão(ões), tentando ${sorted.length} em ordem de preferência ${post.pathname}`,
    );
    return tryLinksInOrder(sorted, (link) => fetchFollowingAllowed(link.url, post.href), {
      onError: (link, error) =>
        console.warn(`[resolve] botão ${link.quality || '?'}p falhou (${error.message}); tentando o próximo`),
    });
  });
}

/**
 * Modo Torznab: resolve o botão de índice fixo (o feed referencia botões por
 * posição). SEM fallback: o índice identifica um botão específico — cair para
 * outro devolveria o torrent errado pro item que o Jackett listou.
 */
async function resolveButton(postUrl, index, hash, count) {
  const cacheKey = magnetButtonCacheKey(postUrl, index, hash);
  // Log de hit preservado do laço manual (o cached() do núcleo não loga).
  const hit = magnetCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) console.log(`[cache] hit magnet botão ${index} ${postUrl}`);

  return cachedMagnet(cacheKey, MAGNET_CACHE_MS, async () => {
    const { post, links } = await getPostLinks(postUrl);
    const link = pickButton(links, index, hash, count);
    if (!link) throw new Error('no_such_button');
    console.log(`[dl] botão ${index} → ${link.quality || '?'}p ${link.audio} ${link.size || ''} ${post.pathname}`);
    return fetchFollowingAllowed(link.url, post.href);
  });
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
const mapLimit = (items, fn) => bootstrap.mapLimit(items, fn, {
  onError: (err) => console.warn(`[search] post sem botões (${err.message})`),
});

// cleanPostTitle (7 passos) é o do núcleo (release-format.js) — idêntico ao
// do comandotorrents; importado no topo e reexportado abaixo.

/**
 * Título da release: o do post limpo + os atributos do botão na tag. A fonte
 * entra na tag ([720p WEB-DL DUBLADO]) e é removida do título limpo pra não
 * duplicar. Sem tamanho na tag: o card Cardigann já publica <div class="size">.
 * (Factory comum no release-format.js — diferenças do bludv via parâmetro.)
 */
const releaseTitle = createReleaseTitle({
  cleanTitle: cleanPostTitle,
  withSize: false,
  stripSource: true,
});

function pubDate(date) {
  const m = String(date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date().toUTCString();
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).toUTCString();
}

/**
 * "Nome S01E01" → "Nome"; o buscador WordPress engasga com ":" (vide o scraper
 * nativo do addon). Ano ajuda a relevância, então fica.
 *
 * As fronteiras \b são obrigatórias: sem elas o strip comia pedaço de título
 * com S+número dentro de palavra ("S1m0ne" virava "m0ne" e a busca zerava).
 * Usada pelos DOIS modos (Torznab e Cardigann) para não divergirem.
 */
const normalizeQuery = createNormalizeQuery();

const selectSearchPosts = bootstrap.makeSelectSearchPosts(parsePosts, MAX_POSTS);

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
  // Log de hit preservado do laço manual (o cached() do núcleo não loga).
  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) console.log(`[cache] hit search "${normalized}"`);

  return cachedSearch(cacheKey, SEARCH_CACHE_MS, async () => {
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
      console.log(`[search] "${normalized}" → ${posts.length} post(s), ${items.length} release(s)`);
      return items;
    } catch (err) {
      // Só erro de rede (DNS/conexão/timeout) alimenta o failover: 0
      // resultados ou HTTP de erro não dizem nada sobre o domínio.
      if (isNetworkError(err)) await siteSelector.noteFailure();
      throw err;
    }
  });
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

// Feed multilinha com description e comentário dos seeds — as diferenças do
// bludv viram parâmetros da factory comum (release-format.js).
const rssXml = createRssXml({
  selfUrl: SELF_URL,
  channelTitle: 'BLUDV (resolver)',
  titleOf: ({ post, link }) => releaseTitle(post.title, link),
  pubDateOf: ({ post }) => pubDate(post.date),
  withDescription: true,
  seedersComment: '<!-- O BLUDV não publica seeds; 1 neutro pra não ser descartado por filtros. -->',
});

// /api, /search e /dl são as rotas padrão do esqueleto (resolver-http.js);
// o feed vazio do /api é SEMPRE categoria 2000 no bludv (decisão própria,
// via emptyXml) e o log de busca acontece dentro do searchPosts. O /resolve
// fica AQUI (handleResolve): aceita prefs audio=/quality= com validação
// própria (invalid_audio/invalid_quality/invalid_index → 400) e o unwrap
// carrega os campos extras — lógica exclusiva do perfil, não vira if na
// factory. O bloco download.before do cardigann (URL aninhada) é tratado pelo
// unwrapOptions da factory (paths /resolve + /dl, campos i/h/n/audio/quality).

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

const handleRequest = createResolverRouter({
  reply,
  routes: {
    '/health': createHealthRoute({ reply }),
    '/api': createApiRoute({
      reply, capsXml,
      search: searchPosts,
      renderXml: (items, category) => rssXml(items, category),
      emptyXml: () => rssXml([], 2000),
    }),
    '/dl': createDlRoute({ reply, resolveButton }),
    '/search': createSearchRoute({ reply, search: searchPosts, renderHtml: searchPageHtml }),
    '/resolve': handleResolve,
  },
});

function createServer() {
  return createHttpServer(handleRequest);
}

// Mesmo desenho do nerdfilmes: quem sobe o servidor é o processo principal ou o
// src/br-resolvers.js (que já chama createServer quando o módulo o exporta).
// Abrir a porta no require deixava o parser impossível de exercitar em teste
// sem tomar a 8700 de quem estivesse rodando.
if (require.main === module) {
  bootstrap.serveMain(createServer);
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
