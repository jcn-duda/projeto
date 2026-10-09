// Apache Torrent (apachetorrents.com) — parsers puros do perfil. Sétimo
// resolvedor local BR. O site NÃO é WordPress: é um buscador PHP próprio que
// exige sessão (cookie PHPSESSID) + token por sessão no form da home, com um
// honeypot (`hp_bot_check`) que precisa ir VAZIO — bots preenchem. Os magnets
// são DIRETOS no HTML do post, sem protetor de link e sem rota /resolve: o
// card Cardigann consome o magnet direto da página sintética (/search) ou do
// feed torznab (/api), exatamente como o redetorrent.
//
// Tamanho NÃO é publicado por release (o site só expõe o botão): a página
// sintética manda o sentinela "1 KB" e o addon o trata como desconhecido.

import { decodeEntities, escapeXml, stripTags as stripTagsShared } from '../text.js';
import { createQualityRules, createSourceRules } from '../release-rules.js';
import { cleanPostTitle, createReleaseTitle } from '../release-format.js';
// Validação do magnet reusa o helper canônico do bludv-parsers: só vale magnet
// com xt=urn:btih: de hash válido (40 hex OU 32 base32) em qualquer posição —
// o site publica as duas formas no MESMO post.
import { isValidMagnetUri } from './bludv-parsers.js';
import type { ParsedResolverLink } from '../types.js';

// O apex faz 301 para o plural (`apachetorrent.com` → `apachetorrents.com`).
// Os DOIS domínios precisam estar na allowlist: sem o singular, o redirect
// vira `blocked_host` e a fonte morre em silêncio (armadilha do nerdfilmes).
const FALLBACK_SITE_SUFFIXES = ['apachetorrents.com', 'apachetorrent.com'];

const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules();

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);

// O buscador PHP do site é sensível a acento e a `:` (herança de querystring):
// o strip de diacríticos é defesa DUPLA do shapeSearchQuery do addon, que já
// tira acento para todo indexer BR. Caixa, pontuação e ano ficam — quem tira
// SxxEyy/ano é o addon (bareTitleIndexers), não o resolver.
function stripDiacritics(value: string | null | undefined): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeQuery(value: string): string {
  return stripDiacritics(value).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
}

function requestedSeasonFromQuery(value: string | null | undefined): RegExpMatchArray | null {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

// Token do form da home: `<input type="hidden" name="token" value="...">`. A
// varredura é por tag (e não um regex único) porque o site ordena atributos de
// formas diferentes e o valor pode vir antes do name em variantes do tema.
function extractSearchToken(html: string | null | undefined): string | null {
  if (!html) return null;
  const tags = String(html).match(/<input\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name || name.toLowerCase() !== 'token') continue;
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1];
    if (value) return decodeEntities(value).trim();
  }
  return null;
}

/** Card da busca do Apache Torrent. */
export interface ApacheWork {
  url: string;
  title: string;
  year: number | null;
  poster: string | null;
  type: 'Filme' | 'Série' | null;
}

// O card publica o marcador de tipo/ano por extenso no TEXTO do h2
// ("(Filme de 2024)"/"(Série de 2025)"), enquanto o atributo title traz só o
// nome. O título da release usa o atributo quando existe (sem o marcador); o
// ano e o tipo saem do texto.
function workTypeFromText(text: string): 'Filme' | 'Série' | null {
  if (/\(\s*S[ée]rie\b/i.test(text)) return 'Série';
  if (/\(\s*Filme\b/i.test(text)) return 'Filme';
  return null;
}

// Cards da busca: div.capa-item > h2.capa-titulo > a. baseUrl resolve href
// relativo (o site publica absoluto; o parâmetro cobre HTML sintético e
// mudanças futuras do tema).
function parseSearchHtml(html: string | null | undefined, baseUrl?: string): ApacheWork[] {
  if (!html) return [];
  const out: ApacheWork[] = [];
  const seen = new Set<string>();
  const chunks = String(html).split(/<div class=["']capa-item["']>/i).slice(1);
  for (const chunk of chunks) {
    const anchor = chunk.match(/<h2 class=["']capa-titulo["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const href = anchor[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let resolved: string;
    try {
      resolved = new URL(decodeEntities(href), baseUrl || undefined).href;
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const text = stripTags(anchor[2]);
    const attrTitle = anchor[1].match(/\btitle=["']([^"']*)["']/i)?.[1];
    const title = stripTags(attrTitle || anchor[2]);
    if (!title) continue;
    const yearMatch = text.match(/\(\s*(?:Filme|S[ée]rie|Document[áa]rio|Anime|Desenho)\s+de\s+(\d{4})\s*\)/i)
      || text.match(/\((\d{4})\)/);
    out.push({
      url: resolved,
      title,
      year: yearMatch ? Number(yearMatch[1]) : null,
      poster: null,
      type: workTypeFromText(text),
    });
  }
  return out;
}

function magnetParams(magnet: string): { dn: string } {
  try {
    return { dn: decodeURIComponent(new URL(magnet).searchParams.get('dn') || '') };
  } catch {
    return { dn: '' };
  }
}

function qualityFromText(text: string | null | undefined): number | null {
  const match = String(text || '').match(/\b(\d{3,4})\s*p\b/i);
  return match ? normalizeQuality(match[0]) : null;
}

// Áudio pelo contexto do bloco: "VERSÃO LEGENDADA" vence; "DUAL ÁUDIO" vence
// "DUBLADA" (o site escreve "VERSÃO DUBLADA" com desc "DUAL ÁUDIO 5.1" quando a
// trilha é dual); sem nenhum marcador, desconhecido.
function classifyAudio(context: string | null | undefined): 'legendado' | 'dual' | 'dublado' | null {
  const text = String(context || '').toUpperCase();
  if (/LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)/.test(text)) return 'legendado';
  if (/DUAL[-\s]*[AÁ]UDIO|AUDIO[-\s]*DUPLO|DUPLO[-\s]*AUDIO/.test(text)) return 'dual';
  if (/DUBLAD|\bDUB\b|NACIONAL|PORTUGU[ÊE]S/.test(text)) return 'dublado';
  return null;
}

/** Botão do post com o contexto do bloco (descrição própria da release). */
export interface ApacheLink extends ParsedResolverLink {
  description?: string | null;
}

// Cada bloco `div.download-block` carrega UM grupo de âncoras de magnet com o
// contexto de áudio/qualidade em `p.download-desc` e, às vezes, o cabeçalho
// `p.download-versao` ("VERSÃO DUBLADA"/"VERSÃO LEGENDADA"). O bloco de
// legendas externas também usa a classe: só âncora com magnet VÁLIDO entra.
function parsePostMagnets(
  html: string | null | undefined,
  post: string | { url?: string } | null | undefined,
): ApacheLink[] {
  if (!html) return [];
  const baseUrl = typeof post === 'string' ? post : post?.url;
  const out: ApacheLink[] = [];
  const blocks = String(html).split(/<div[^>]*class=["'][^"']*download-block[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const version = stripTags(block.match(/class=["']download-versao["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
    // O rótulo do próprio botão ("Download Torrent") vive dentro do desc e sai
    // junto com o <a> antes do stripTags — senão polui a description da linha.
    const descRaw = block.match(/class=["']download-desc["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
    const desc = stripTags(descRaw.replace(/<a\b[\s\S]*?<\/a>/gi, ' '));
    const context = `${version} ${desc}`;
    const audio = classifyAudio(context);
    const quality = normalizeQuality(context);
    const source = normalizeSource(context);
    const hrefRe = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
    let hrefMatch: RegExpExecArray | null;
    while ((hrefMatch = hrefRe.exec(block)) !== null) {
      let href = decodeEntities(hrefMatch[1]);
      if (baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        try { href = new URL(href, baseUrl).href; } catch {}
      }
      if (!isValidMagnetUri(href)) continue;
      const { dn } = magnetParams(href);
      out.push({
        url: href,
        quality: quality ?? qualityFromText(dn),
        size: null,
        audio,
        source: source ?? normalizeSource(dn),
        episode: null,
        season: null,
        realTitle: null,
        description: [version, desc].filter(Boolean).join(' — ') || null,
      });
    }
  }
  return out;
}

// Título da release: o título do post limpo + os atributos do magnet (sem
// tamanho — o site não publica). O áudio por magnet é o que desempata as 8
// opções do mesmo post no card; sem ele todas sairiam idênticas.
const releaseTitle = createReleaseTitle({
  cleanTitle: cleanPostTitle,
  titleOf: (post, link) => (typeof post === 'string' ? post : post?.title) || '',
  audioTagOf: (link) => link?.audio === 'dublado' ? 'DUBLADO'
    : link?.audio === 'dual' ? 'DUAL'
      : link?.audio === 'legendado' ? 'LEGENDADO' : null,
  withSize: false,
});

/** Item da página sintética do Apache Torrent. */
export interface ApachePageItem {
  post: { url?: string; title?: string | null; year?: number | null };
  link: ApacheLink;
  index: number;
}

/** Opções da factory da página sintética do Apache Torrent. */
export interface ApacheSearchPageOptions {
  escape?: (value: string | null | undefined) => string;
  releaseTitle?: (post: unknown, link: ApacheLink, index?: number | null) => string;
}

// Página sintética do card Cardigann: o href de cada linha É o magnet do post
// (magnet direto, sem /resolve e sem download.before). O post.url tem elemento
// PRÓPRIO (div.post > a) para o details ler o atributo — colar texto ali fazia
// o Jackett carregar URL quebrada.
function createApacheSearchPageHtml(options: ApacheSearchPageOptions = {}) {
  const escape = options.escape || escapeXml;
  const relTitle: (post: unknown, link: ApacheLink, index?: number | null) => string =
    options.releaseTitle || releaseTitle;
  return function searchPageHtml(items: ApachePageItem[]): string {
    const rows = items.map(({ post, link, index }) => {
      const title = relTitle(post, link, index);
      const description = link.description || post.title || '';
      return `<div class="release"><div class="title"><a href="${escape(link.url)}">${escape(title)}</a></div><div class="size">${escape(link.size || '1 KB')}</div><div class="post"><a href="${escape(post.url || '')}">${escape(post.url || '')}</a></div><div class="description">${escape(description)}</div><div class="seeders">1</div></div>`;
    }).join('');
    return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
  };
}

// Feed torznab: o link é o magnet do post (sem /dl do perfil).
function apacheRssXml(items: ApachePageItem[], category: number): string {
  const body = items.map(({ post, link, index }) => {
    const title = releaseTitle(post, link, index);
    return `<item><title>${escapeXml(title)}</title><guid isPermaLink="false">${escapeXml(link.url)}</guid><link>${escapeXml(link.url)}</link><comments>${escapeXml(post.url || '')}</comments><pubDate>${new Date().toUTCString()}</pubDate><size>0</size><category>${category}</category><torznab:attr name="category" value="${category}"/><torznab:attr name="size" value="0"/><torznab:attr name="seeders" value="1"/><torznab:attr name="peers" value="1"/><torznab:attr name="downloadvolumefactor" value="0"/><torznab:attr name="uploadvolumefactor" value="1"/></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Apache Torrent</title>${body}</channel></rss>`;
}

export {
  FALLBACK_SITE_SUFFIXES,
  normalizeQuery, requestedSeasonFromQuery, classifyAudio,
  extractSearchToken, parseSearchHtml, parsePostMagnets,
  isValidMagnetUri, qualityFromText,
  cleanPostTitle, releaseTitle, createApacheSearchPageHtml, apacheRssXml,
  stripTags, decodeEntities, escapeXml,
};
