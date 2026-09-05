'use strict';

const {
  decodeEntities,
  escapeHtml,
  extractMetaRefresh,
  stripTags: stripTagsShared,
} = require('../text');
const { isGenericListPost, buttonId } = require('../matching');
const { BASE_PROTECTOR_SUFFIXES, hasAllowedHost } = require('../protector');
const { parseExtraProtectors } = require('../runtime');
const { createMagnetExtractor, discoverNextUrl } = require('../magnet-extract');
const { capsXml: sharedCapsXml } = require('../torznab');
const {
  createQualityRules,
  createSourceRules,
  createBrAudioHooks,
  createEpisodeRules,
  createEpisodeStep,
  createLinkCollector,
} = require('../release-rules');
const {
  UNKNOWN_SIZE,
  cleanPostTitle,
  createReleaseTitle,
  createNormalizeQuery,
  createRssXml,
} = require('../release-format');

const MAX_CARD_WINDOW = 8000;
const AUDIO_RANK = { dublado: 0, desconhecido: 1, legendado: 2 };
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|LINK_FINAL|TARGET_URL|DESTINO|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

const extraProtectors = parseExtraProtectors(process.env.EXTRA_PROTECTORS);
const ALL_PROTECTOR_SUFFIXES = Array.from(new Set([...BASE_PROTECTOR_SUFFIXES, ...extraProtectors]));

// Classificadores de áudio, qualidade e fonte compartilhados do núcleo (release-rules.js)
const brAudioHooks = createBrAudioHooks();
const { audioFromSegment, audioFromAnchor } = brAudioHooks;
const qualityRules = createQualityRules();
const { normalizeQuality } = qualityRules;
const sourceRules = createSourceRules();
const { normalizeSource } = sourceRules;

// Padrões de episódio com escopo anchor-local para o layout do BLUDV
const episodeRules = createEpisodeRules();
const { extractEpisode } = episodeRules;
const episodeStep = createEpisodeStep({
  scope: 'anchor-local',
  packRe: episodeRules.packPattern,
  rangeRe: episodeRules.rangePattern,
  epRe: episodeRules.episodePattern,
  extract: episodeRules.extractEpisode,
  packMatchAll: episodeRules.packPatternG,
  tieBreak: true,
});

/** Hash btih válido: 40 hex ou 32 base32 (alfabeto A-Z2-7), case-insensitive. */
function isValidBtihHash(hash) {
  const h = String(hash || '').trim();
  return /^[0-9a-f]{40}$/i.test(h) || /^[a-z2-7]{32}$/i.test(h);
}

/**
 * Magnet direto só vale com parâmetro xt=urn:btih: de hash válido, em
 * QUALQUER posição da query.
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

function defaultIsProtectorHost(hostname) {
  return hasAllowedHost(hostname, ALL_PROTECTOR_SUFFIXES);
}

const extractMagnet = createMagnetExtractor({ decodeEntities, encodedVariants: true });

function createNextProtectedUrl(options = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const decode = options.decodeEntities || decodeEntities;
  const extractRefresh = options.extractMetaRefresh || extractMetaRefresh;
  const suffixes = options.protectorSuffixes || ALL_PROTECTOR_SUFFIXES;
  const jsVar = options.jsVarPattern || JS_URL_VAR_RE;

  return function nextProtectedUrl(html, baseUrl) {
    if (!html) return null;
    const str = String(html);
    const refreshTarget = extractRefresh(str);
    if (refreshTarget) {
      try {
        const u = new URL(refreshTarget, baseUrl);
        if (isProtector(u.hostname) && u.href !== baseUrl) return u.href;
      } catch {}
    }
    return discoverNextUrl(str, baseUrl, {
      isProtectorHost: isProtector,
      decodeEntities: decode,
      protectorSuffixes: suffixes,
      jsVarPattern: jsVar,
    });
  };
}

const nextProtectedUrl = createNextProtectedUrl();

/**
 * Cria o coletor de links de download para o post do BLUDV.
 */
function createParseDownloadLinks(options = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const strip = options.stripTags || ((s) => stripTagsShared(s, decodeEntities));
  const decode = options.decodeEntities || decodeEntities;

  return createLinkCollector({
    anchorRe: /<a\s+[^>]*?href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
    resolveHref: (match) => {
      const href = decode(match[2].trim());
      if (isValidMagnetUri(href)) return { url: href };
      let u;
      try {
        u = new URL(href);
      } catch {
        return { skip: true };
      }
      if (!isProtector(u.hostname)) return { skip: true };
      return { url: href };
    },
    anchorTextOf: (match) => strip(match[3]),
    stripTags: strip,
    initialAudio: 'desconhecido',
    audioFromSegment,
    audioFromAnchor,
    episodeStep,
    qualityFn: normalizeQuality,
    sourceFn: normalizeSource,
  });
}

const parseDownloadLinks = createParseDownloadLinks();

/**
 * Ordena os botões do post: dublado/dual primeiro, maior qualidade depois.
 * ?audio=legendado|dublado força a preferência; ?quality=1080p mira uma
 * qualidade específica (caindo na mais próxima disponível se não houver).
 */
function sortLinks(links, { audio, quality } = {}) {
  const rank = audio && AUDIO_RANK[audio] !== undefined
    ? { dublado: 2, desconhecido: 1, legendado: 2, [audio]: 0 }
    : AUDIO_RANK;
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

function scoreLink(link) {
  return (link?.audio === 'dublado' ? 100_000 : link?.audio === 'legendado' ? 0 : 50_000) + (link?.quality || 0);
}

/**
 * Título da release: o do post limpo + os atributos do botão na tag.
 */
const releaseTitle = createReleaseTitle({
  cleanTitle: cleanPostTitle,
  withSize: false,
  stripSource: true,
});

function parsePostDate(date) {
  const m = String(date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date().toUTCString();
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).toUTCString();
}

const pubDate = parsePostDate;
const normalizeQuery = createNormalizeQuery();

/**
 * Cria a função de parse de posts da página de busca do WordPress.
 */
function createParsePosts(options = {}) {
  const getSiteUrl = typeof options.siteUrl === 'function'
    ? options.siteUrl
    : () => options.siteUrl || (options.siteSelector ? options.siteSelector.url() : 'https://bludvfilmes.xyz');
  const decode = options.decodeEntities || decodeEntities;
  const strip = options.stripTags || ((s) => stripTagsShared(s, decode));
  const isGeneric = options.isGenericListPost || isGenericListPost;
  const maxWindow = options.maxCardWindow || MAX_CARD_WINDOW;

  return function parsePosts(html, dynamicSiteUrl) {
    const baseUrl = dynamicSiteUrl || getSiteUrl();
    const posts = [];
    const seen = new Set();
    const re = /<div class="post">[\s\S]*?<div class="title">\s*<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      let url;
      try {
        url = new URL(decode(m[2].trim()), baseUrl).href;
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);

      const nextPost = html.indexOf('<div class="post">', m.index + 1);
      const end = nextPost === -1 ? html.length : nextPost;
      const block = html.slice(m.index, Math.min(end, m.index + maxWindow));
      const poster = block.match(/<img[^>]+src="([^"]+)"/);
      const original = block.match(/T[íi]tulo\s*Original:[^<\n]{0,60}(?:<[^>]+>\s*)?([^<\n]{2,80})/i);
      const date = block.match(/(\d{2}\/\d{2}\/\d{4})/);
      const title = strip(m[3]);
      if (isGeneric(title)) continue;
      posts.push({
        url,
        title,
        date: date ? date[1] : null,
        poster: poster ? poster[1] : null,
        original: original ? original[1].trim() : null,
      });
    }
    return posts;
  };
}

const parsePosts = createParsePosts();

/**
 * Cria o gerador de HTML sintético para o card Cardigann do Jackett.
 */
function createSearchPageHtml(options = {}) {
  const getSelfUrl = typeof options.selfUrl === 'function'
    ? options.selfUrl
    : () => options.selfUrl || 'http://bludv-resolver:8700';
  const titleOf = options.titleOf || releaseTitle;

  return function searchPageHtml(items) {
    const baseSelfUrl = getSelfUrl();
    const rows = items
      .map(({ post, link, index, count }) => {
        const dl = `${baseSelfUrl}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
        const size = link.size || UNKNOWN_SIZE;
        return `  <div class="release">
    <div class="title"><a href="${escapeHtml(dl)}">${escapeHtml(titleOf(post.title, link))}</a></div>
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
  };
}

const searchPageHtml = createSearchPageHtml();

function capsXml() {
  return sharedCapsXml('BLUDV (resolver)');
}

function createBludvRssXml(options = {}) {
  const selfUrl = options.selfUrl || 'http://bludv-resolver:8700';
  const titleOf = options.titleOf || (({ post, link }) => releaseTitle(post.title, link));
  const pubDateOf = options.pubDateOf || (({ post }) => pubDate(post.date));
  return createRssXml({
    selfUrl,
    channelTitle: 'BLUDV (resolver)',
    titleOf,
    pubDateOf,
    withDescription: true,
    seedersComment: '<!-- O BLUDV não publica seeds; 1 neutro pra não ser descartado por filtros. -->',
  });
}

module.exports = {
  MAX_CARD_WINDOW,
  AUDIO_RANK,
  JS_URL_VAR_RE,
  ALL_PROTECTOR_SUFFIXES,
  brAudioHooks,
  audioFromSegment,
  audioFromAnchor,
  qualityRules,
  normalizeQuality,
  sourceRules,
  normalizeSource,
  episodeRules,
  extractEpisode,
  episodeStep,
  isValidBtihHash,
  isValidMagnetUri,
  extractMagnet,
  createNextProtectedUrl,
  nextProtectedUrl,
  createParseDownloadLinks,
  parseDownloadLinks,
  sortLinks,
  pickBestLink,
  scoreLink,
  cleanPostTitle,
  releaseTitle,
  parsePostDate,
  pubDate,
  normalizeQuery,
  createParsePosts,
  parsePosts,
  createSearchPageHtml,
  searchPageHtml,
  capsXml,
  createBludvRssXml,
};
