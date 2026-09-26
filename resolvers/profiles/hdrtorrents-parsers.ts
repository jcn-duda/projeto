// HDR Torrents (hdrtorrents.net) — parsers puros do perfil. Oitavo
// resolvedor local BR. O site é WordPress com a busca quebrada (devolve a
// homepage para qualquer termo), então o resolver raspa as páginas de
// listagem (homepage + paginação) para montar um catálogo em cache e casa a
// query contra esse catálogo. Os magnets são DIRETOS no HTML do post
// (`.item-downloads .download-row a[href^="magnet:"]`), sem protetor de
// link e sem rota /resolve: o Cardigann consome o magnet direto da página
// sintética, como o apachetorrent.

import { decodeEntities, escapeXml, stripTags as stripTagsShared } from '../text.js';
import { createQualityRules, createSourceRules } from '../release-rules.js';
import { cleanPostTitle, createReleaseTitle } from '../release-format.js';
import { isValidMagnetUri } from './bludv-parsers.js';
import type { ParsedResolverLink } from '../types.js';

const FALLBACK_SITE_SUFFIXES = ['hdrtorrents.net'];

const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules();

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);

// hdrtorrents.net é WordPress; a busca nativa ignora o parâmetro e devolve a
// homepage. O resolver normaliza a query para o matching local (mesmo shape
// dos outros BR: diacríticos fora, pontuação normalizada).
function stripDiacritics(value: string | null | undefined): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeQuery(value: string): string {
  return stripDiacritics(value).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
}

function requestedSeasonFromQuery(value: string | null | undefined): RegExpMatchArray | null {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

/** Card da listagem do HDR Torrents. */
export interface HDRWork {
  url: string;
  title: string;
  year: number | null;
  poster: string | null;
  type: 'Filme' | 'Série' | 'Desenho' | null;
  quality: string | null;
}

// Cards da listagem: `.media-card-link` envolve `.media-card` com
// `.media-card-title`, `.media-card-year`, `.badge-tipo`, `.badge-qualidade`
// e `.media-card-cover > img`. A página tem 20 cards por página e paginação
// em `/pagina/N/`.
function parseListingHtml(html: string | null | undefined, baseUrl: string): HDRWork[] {
  if (!html) return [];
  const out: HDRWork[] = [];
  const seen = new Set<string>();
  // O HTML tem quebras de linha entre atributos (href vem na linha 1,
  // class="media-card-link" na linha 2). Uso matchAll para capturar o bloco
  // completo do <a> com seu conteúdo interno, extraindo href do tag e
  // título/ano/etc do conteúdo.
  // Regex: <a ...href="..."...class="...media-card-link"...> ...conteúdo... </a>
  const blockRe = /<a\b[\s\S]*?\bhref=["']([^"']+)["'][\s\S]*?\bclass=["'][^"']*media-card-link[^"']*["'][\s\S]*?>([\s\S]*?)<\/a>/gi;
  for (const match of String(html).matchAll(blockRe)) {
    const href = match[1];
    const inner = match[2];
    if (!href || !inner) continue;
    let resolved: string;
    try {
      resolved = new URL(decodeEntities(href), baseUrl).href;
    } catch {
      continue;
    }
    // Ignora links da navbar (homepage sem path de conteúdo).
    if (resolved === baseUrl || resolved === `${baseUrl}/`) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const titleMatch = inner.match(/class=["'][^"']*media-card-title[^"']*["'][\s\S]*?>([\s\S]*?)$/i)
      ?? inner.match(/class=["'][^"']*media-card-title[^"']*["'][^>]*>([\s\S]*)/i);
    const title = stripTags(titleMatch?.[1] || '').trim();
    if (!title) continue;
    const yearMatch = inner.match(/class=["'][^"']*media-card-year[^"']*["'][\s\S]*?>\s*\(?(\d{4})\)?/i);
    const typeMatch = inner.match(/class=["'][^"']*badge-tipo[^"']*["'][\s\S]*?>([\s\S]*?)<(?:\/span|\/div|\/a)/i);
    const qualityMatch = inner.match(/class=["'][^"']*badge-qualidade[^"']*["'][\s\S]*?>([\s\S]*?)<(?:\/span|\/div|\/a)/i);
    const posterMatch = inner.match(/class=["'][^"']*media-card-cover[^"']*["'][\s\S]*?>\s*<img[\s\S]*?\b(?:data-)?src=["']([^"']+)["']/i);
    const typeText = stripTags(typeMatch?.[1] || '').trim();
    out.push({
      url: resolved,
      title,
      year: yearMatch ? Number(yearMatch[1]) : null,
      poster: posterMatch ? decodeEntities(posterMatch[1]) : null,
      type: /s[ée]rie/i.test(typeText) ? 'Série'
        : /desenho|anima/i.test(typeText) ? 'Desenho'
        : /filme/i.test(typeText) ? 'Filme'
        : null,
      quality: stripTags(qualityMatch?.[1] || '').trim() || null,
    });
  }
  return out;
}

/** Botão do post com contexto do bloco de download. */
export interface HDRLink extends ParsedResolverLink {
  description?: string | null;
}

// Cada `.download-row` tem `.download-name` (texto do episódio/release) e
// `a.download-btn[href^="magnet:"]`. O magnet é DIRETO no HTML, sem protetor.
// Para séries, cada episódio é uma `.download-row` separada.
function parseContentMagnets(html: string | null | undefined, baseUrl: string): HDRLink[] {
  if (!html) return [];
  const out: HDRLink[] = [];
  const rows = String(html).split(/<div[^>]*class=["'][^"']*download-row[^"']*["'][^>]*>/i).slice(1);
  for (const row of rows) {
    const nameMatch = row.match(/class=["'][^"']*download-name[^"']*"[^>]*>([\s\S]*?)<\/div/i);
    const name = stripTags(nameMatch?.[1] || '').trim();
    const hrefMatch = row.match(/<a\b[^>]*href=["'](magnet:[^"']+)["']/i);
    if (!hrefMatch) continue;
    const magnet = decodeEntities(hrefMatch[1]);
    if (!isValidMagnetUri(magnet)) continue;
    const context = name;
    const audio = classifyAudio(context);
    const quality = normalizeQuality(context);
    const source = normalizeSource(context);
    const episode = extractEpisodeFromName(name);
    const dnMatch = magnet.match(/[?&]dn=([^&]+)/i);
    const dn = dnMatch ? decodeURIComponent(dnMatch[1]) : '';
    out.push({
      url: magnet,
      quality: quality ?? normalizeQuality(dn),
      size: null,
      audio,
      source: source ?? normalizeSource(dn),
      episode,
      season: null,
      realTitle: null,
      description: name || null,
    });
  }
  // Preenche o tamanho da ficha técnica em todos os links (é o mesmo para
  // todos os episódios do post — o site publica um tamanho por obra).
  const size = extractSizeFromTechSheet(html);
  if (size) {
    for (const link of out) {
      if (!link.size) link.size = size;
    }
  }
  return out;
}

// Áudio pelo contexto do nome do episódio/release: "DUAL" vence "DUBLADO"
// (o site escreve "DUBLADO DUAL AUDIO" quando a trilha é dual).
function classifyAudio(context: string | null | undefined): 'legendado' | 'dual' | 'dublado' | null {
  const text = String(context || '').toUpperCase();
  if (/LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)/.test(text)) return 'legendado';
  if (/DUAL[-\s]*[AÁ]UDIO|AUDIO[-\s]*DUPLO/.test(text)) return 'dual';
  if (/DUBLAD|\bDUB\b|NACIONAL|PORTUGU[ÊE]S/.test(text)) return 'dublado';
  return null;
}

function extractEpisodeFromName(name: string): number | null {
  const match = name.match(/\b[Ee](\d{1,3})\b/) || name.match(/EPIS[ÓO]DIO\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

// A ficha técnica do post publica "Tamanho 4.62 GB" (ou "Tamanho: 4.62 GB").
// Regex cobre ambas as formas.
function extractSizeFromTechSheet(html: string): string | null {
  const match = html.match(/Tamanho\s*:?\s*([\d.,]+\s*(?:TB|GB|MB|KB))/i);
  if (!match) return null;
  return match[1].replace(',', '.');
}

function extractYearFromTechSheet(html: string): number | null {
  const match = html.match(/Lan[çc]amento\s*:?\s*(\d{4})/i);
  return match ? Number(match[1]) : null;
}

const releaseTitle = createReleaseTitle({
  cleanTitle: cleanPostTitle,
  titleOf: (post, link) => (typeof post === 'string' ? post : post?.title) || '',
  audioTagOf: (link) => link?.audio === 'dublado' ? 'DUBLADO'
    : link?.audio === 'dual' ? 'DUAL'
      : link?.audio === 'legendado' ? 'LEGENDADO' : null,
  withSize: false,
});

/** Item da página sintética do HDR Torrents. */
export interface HDRPageItem {
  post: { url?: string; title?: string | null; year?: number | null };
  link: HDRLink;
  index: number;
}

/** Opções da factory da página sintética. */
export interface HDRSearchPageOptions {
  escape?: (value: string | null | undefined) => string;
  releaseTitle?: (post: unknown, link: HDRLink, index?: number | null) => string;
}

// Página sintética do card Cardigann: o href de cada linha É o magnet do post
// (magnet direto, sem /resolve e sem download.before). Idêntico ao formato do
// apachetorrent — o Cardigann lê o magnet direto do atributo.
function createHDRSearchPageHtml(options: HDRSearchPageOptions = {}) {
  const escape = options.escape || escapeXml;
  const relTitle: (post: unknown, link: HDRLink, index?: number | null) => string =
    options.releaseTitle || releaseTitle;
  return function searchPageHtml(items: HDRPageItem[]): string {
    const rows = items.map(({ post, link, index }) => {
      const title = relTitle(post, link, index);
      const description = link.description || post.title || '';
      return `<div class="release"><div class="title"><a href="${escape(link.url)}">${escape(title)}</a></div><div class="size">${escape(link.size || '1 KB')}</div><div class="post"><a href="${escape(post.url || '')}">${escape(post.url || '')}</a></div><div class="description">${escape(description)}</div><div class="seeders">1</div></div>`;
    }).join('');
    return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
  };
}

function hdrRssXml(items: HDRPageItem[], category: number): string {
  const body = items.map(({ post, link, index }) => {
    const title = releaseTitle(post, link, index);
    return `<item><title>${escapeXml(title)}</title><guid isPermaLink="false">${escapeXml(link.url)}</guid><link>${escapeXml(link.url)}</link><comments>${escapeXml(post.url || '')}</comments><pubDate>${new Date().toUTCString()}</pubDate><size>0</size><category>${category}</category><torznab:attr name="category" value="${category}"/><torznab:attr name="size" value="0"/><torznab:attr name="seeders" value="1"/><torznab:attr name="peers" value="1"/><torznab:attr name="downloadvolumefactor" value="0"/><torznab:attr name="uploadvolumefactor" value="1"/></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>HDR Torrents</title>${body}</channel></rss>`;
}

export {
  FALLBACK_SITE_SUFFIXES,
  normalizeQuery, requestedSeasonFromQuery, classifyAudio,
  parseListingHtml, parseContentMagnets,
  extractSizeFromTechSheet, extractYearFromTechSheet,
  isValidMagnetUri, releaseTitle, createHDRSearchPageHtml, hdrRssXml,
  stripTags, decodeEntities, escapeXml,
};
