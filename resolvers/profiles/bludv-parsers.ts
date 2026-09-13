import {
  decodeEntities,
  escapeHtml,
  extractMetaRefresh,
  stripTags as stripTagsShared,
} from '../text.js';
import type { DecodeEntities } from '../text.js';
import { isGenericListPost, buttonId } from '../matching.js';
import { BASE_PROTECTOR_SUFFIXES, hasAllowedHost } from '../protector.js';
import { createMagnetExtractor, discoverNextUrl } from '../magnet-extract.js';
import { capsXml as sharedCapsXml } from '../torznab.js';
import {
  createQualityRules,
  createSourceRules,
  createBrAudioHooks,
  createEpisodeRules,
  createEpisodeStep,
  createLinkCollector,
} from '../release-rules.js';
import type { LinkCollectorConfig } from '../release-rules.js';
import {
  UNKNOWN_SIZE,
  cleanPostTitle,
  createReleaseTitle,
  createNormalizeQuery,
  createRssXml,
} from '../release-format.js';
import type {
  ReleaseTitleInput,
  ReleaseTitlePost,
  SearchPageItem,
} from '../release-format.js';
import type { ResolverLink, ResolverPost } from '../types.js';

const MAX_CARD_WINDOW = 8000;
const AUDIO_RANK: Record<string, number | undefined> = { dublado: 0, desconhecido: 1, legendado: 2 };
const JS_URL_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|LINK_FINAL|TARGET_URL|DESTINO|target_url|dest|target|link|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i;

// Import-safe: a lista base é estática. A env EXTRA_PROTECTORS que existia aqui
// não era documentada nem definida (o operador usa EXTRA_ALLOWED_PROTECTORS,
// injetada no bootstrap pelo profile); os defaults desta factory só são usados
// sem isProtectorHost explícito.
const ALL_PROTECTOR_SUFFIXES = Array.from(new Set([...BASE_PROTECTOR_SUFFIXES]));

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
function isValidBtihHash(hash: string | null | undefined): boolean {
  const h = String(hash || '').trim();
  return /^[0-9a-f]{40}$/i.test(h) || /^[a-z2-7]{32}$/i.test(h);
}

/**
 * Magnet direto só vale com parâmetro xt=urn:btih: de hash válido, em
 * QUALQUER posição da query.
 */
function isValidMagnetUri(value: unknown): boolean {
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

function defaultIsProtectorHost(hostname: string | null | undefined): boolean {
  return hasAllowedHost(hostname, ALL_PROTECTOR_SUFFIXES);
}

const extractMagnet = createMagnetExtractor({ decodeEntities, encodedVariants: true });

/** Opções da factory do nextProtectedUrl do BLUDV. */
export interface BludvNextProtectedUrlOptions {
  isProtectorHost?: (hostname: string) => boolean;
  decodeEntities?: DecodeEntities;
  extractMetaRefresh?: (html: string | null | undefined) => string | null;
  protectorSuffixes?: string[];
  jsVarPattern?: RegExp;
}

function createNextProtectedUrl(options: BludvNextProtectedUrlOptions = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const decode = options.decodeEntities || decodeEntities;
  const extractRefresh = options.extractMetaRefresh || extractMetaRefresh;
  const suffixes = options.protectorSuffixes || ALL_PROTECTOR_SUFFIXES;
  const jsVar = options.jsVarPattern || JS_URL_VAR_RE;

  return function nextProtectedUrl(html: string | null | undefined, baseUrl?: string): string | null {
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

/** Opções da factory do coletor de links do BLUDV. */
export interface BludvParseDownloadLinksOptions {
  isProtectorHost?: (hostname: string) => boolean;
  stripTags?: (value: string) => string;
  decodeEntities?: DecodeEntities;
}

/**
 * Cria o coletor de links de download para o post do BLUDV.
 */
function createParseDownloadLinks(options: BludvParseDownloadLinksOptions = {}) {
  const isProtector = options.isProtectorHost || defaultIsProtectorHost;
  const strip = options.stripTags || ((s: string) => stripTagsShared(s, decodeEntities));
  const decode = options.decodeEntities || decodeEntities;

  const cfg: LinkCollectorConfig = {
    anchorRe: /<a\s+[^>]*?href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
    resolveHref: (match) => {
      const href = decode(match[2].trim());
      if (isValidMagnetUri(href)) return { url: href };
      let u: URL;
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
  };
  return createLinkCollector(cfg);
}

const parseDownloadLinks = createParseDownloadLinks();

/** Preferências do `?audio=`/`?quality=` do /resolve do BLUDV. */
export interface BludvLinkPrefs {
  audio?: string | null;
  quality?: number | string | null;
}

/**
 * Ordena os botões do post: dublado/dual primeiro, maior qualidade depois.
 * ?audio=legendado|dublado força a preferência; ?quality=1080p mira uma
 * qualidade específica (caindo na mais próxima disponível se não houver).
 */
function sortLinks(links: ResolverLink[], { audio, quality }: BludvLinkPrefs = {}): ResolverLink[] {
  const rank: Record<string, number | undefined> = audio && AUDIO_RANK[audio] !== undefined
    ? { dublado: 2, desconhecido: 1, legendado: 2, [audio]: 0 }
    : AUDIO_RANK;
  const wanted = quality != null && Number(quality) > 0 ? Number(quality) : null;

  return [...links].sort((a, b) => {
    const ar = (rank[a.audio ?? ''] ?? 1) - (rank[b.audio ?? ''] ?? 1);
    if (ar !== 0) return ar;
    if (wanted && a.quality && b.quality) {
      const qd = Math.abs(a.quality - wanted) - Math.abs(b.quality - wanted);
      if (qd !== 0) return qd;
    }
    return (b.quality || 0) - (a.quality || 0);
  });
}

function pickBestLink(links: ResolverLink[], prefs?: BludvLinkPrefs): ResolverLink | null {
  return sortLinks(links, prefs)[0] || null;
}

function scoreLink(link?: ResolverLink | null): number {
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

function parsePostDate(date: string | null | undefined): string {
  const m = String(date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date().toUTCString();
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).toUTCString();
}

const pubDate = parsePostDate;
const normalizeQuery = createNormalizeQuery();

/** Opções da factory de parse de posts da busca do BLUDV. */
export interface BludvParsePostsOptions {
  siteUrl?: string | (() => string);
  siteSelector?: { url(): string };
  decodeEntities?: DecodeEntities;
  stripTags?: (value: string) => string;
  isGenericListPost?: (title?: string | null) => boolean;
  maxCardWindow?: number;
}

/**
 * Cria a função de parse de posts da página de busca do WordPress.
 */
function createParsePosts(options: BludvParsePostsOptions = {}) {
  const staticSiteUrl = typeof options.siteUrl === 'string' ? options.siteUrl : '';
  const getSiteUrl = typeof options.siteUrl === 'function'
    ? options.siteUrl
    : () => staticSiteUrl || (options.siteSelector ? options.siteSelector.url() : 'https://bludvfilmes.xyz');
  const decode = options.decodeEntities || decodeEntities;
  const strip = options.stripTags || ((s: string) => stripTagsShared(s, decode));
  const isGeneric = options.isGenericListPost || isGenericListPost;
  const maxWindow = options.maxCardWindow || MAX_CARD_WINDOW;

  return function parsePosts(html: string, dynamicSiteUrl?: string): ResolverPost[] {
    const baseUrl = dynamicSiteUrl || getSiteUrl();
    const posts: ResolverPost[] = [];
    const seen = new Set<string>();
    const re = /<div class="post">[\s\S]*?<div class="title">\s*<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      let url: string;
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

/** Opções da factory da página HTML sintética do card Cardigann. */
export interface BludvSearchPageHtmlOptions {
  selfUrl?: string | (() => string);
  titleOf?: (post: ReleaseTitlePost, link: ReleaseTitleInput) => string;
}

/**
 * Cria o gerador de HTML sintético para o card Cardigann do Jackett.
 */
function createSearchPageHtml(options: BludvSearchPageHtmlOptions = {}) {
  const getSelfUrl = typeof options.selfUrl === 'function'
    ? options.selfUrl
    : () => (typeof options.selfUrl === 'string' ? options.selfUrl : '') || 'http://bludv-resolver:8700';
  const titleOf = options.titleOf || releaseTitle;

  return function searchPageHtml(items: SearchPageItem[]): string {
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

function capsXml(): string {
  return sharedCapsXml('BLUDV (resolver)');
}

/** Opções da factory do feed torznab do BLUDV. */
export interface BludvRssXmlOptions {
  selfUrl?: string;
  titleOf?: (input: { post: ResolverPost; link: ReleaseTitleInput }) => string;
  pubDateOf?: (input: { post: ResolverPost }) => string;
}

function createBludvRssXml(options: BludvRssXmlOptions = {}) {
  const selfUrl = options.selfUrl || 'http://bludv-resolver:8700';
  const titleOf = options.titleOf || (({ post, link }: { post: ResolverPost; link: ReleaseTitleInput }) => releaseTitle(post.title, link));
  const pubDateOf = options.pubDateOf || (({ post }: { post: ResolverPost }) => pubDate(post.date));
  return createRssXml({
    selfUrl,
    channelTitle: 'BLUDV (resolver)',
    titleOf,
    pubDateOf,
    withDescription: true,
    seedersComment: '<!-- O BLUDV não publica seeds; 1 neutro pra não ser descartado por filtros. -->',
  });
}

export {
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
