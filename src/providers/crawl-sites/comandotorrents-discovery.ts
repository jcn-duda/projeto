// Regras PURAS da descoberta do ComandoTorrents. Nada aqui faz rede nem
// conhece o resolver: o kind por slug e o título do `<h1>` são testáveis sem
// dublê de fetch.
//
// O que a medição no site (2026-09-28) fixa — por isso é regra aqui:
//
//   - SITEMAP: Yoast. `robots.txt` aponta `sitemap_index.xml`; `/sitemap.xml`
//     e `/wp-sitemap.xml` respondem o mesmo índice. Obra é `post-sitemap.xml`
//     … `post-sitemap30.xml`. `page` / `attachment` / `category` / `post_tag`
//     não são obra.
//   - URL DE OBRA: um segmento com barra final. O primeiro sitemap ainda traz
//     a homepage `/`, que não é página de obra.
//   - TIPO POR SLUG: o `post-sitemap` é misto. `temporada` no slug é página de
//     temporada (116 no sitemap antigo, 50 no mais recente). Sem a palavra, é
//     filme — inclusive mini-série cujo slug não diz temporada.
//   - TÍTULO: o ano NÃO fica no fim do `<h1>` ("Até Que Amanheça (2026) Dual
//     Áudio WEB-DL 1080p"). A régua compartilhada `parseTitleYear` devolveria
//     ano nulo e a identificação recusaria a página.
//   - IMDb: um tt único no corpo, com rótulo IMDb. Dois ou nenhum é ambíguo.
import type { CrawlPageKind } from '../crawl-types.js';
import { decodeEntities } from '../../utils/title-normalization.js';
import { cleanPostTitle } from '../../../resolvers/release-format.js';

/** Índice Yoast: o caminho que redireciona e o que o robots declara. */
export const SITEMAP_INDEX_PATHS = ['sitemap.xml', 'sitemap_index.xml'];
/** Sitemaps de obra: `post-sitemap.xml`, `post-sitemap2.xml`… (Yoast). */
const POST_SITEMAP_RE = /\/post-sitemap\d*\.xml$/i;
const URL_BLOCK_RE = /<url>[\s\S]*?<\/url>/gi;
const SITEMAP_BLOCK_RE = /<sitemap>[\s\S]*?<\/sitemap>/gi;
/** `<loc>`/`<lastmod>` com CDATA ou sem (o recorte medido veio sem CDATA). */
const SITEMAP_LOC_RE = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i;
const SITEMAP_LASTMOD_RE = /<lastmod>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/lastmod>/i;
/** Obra: UM segmento com barra final. `/` (homepage) e `feed` não casam. */
const WORK_PATH_RE = /^\/[^/]+\/$/;
const NOT_WORK_SEGMENTS = new Set(['link.php', 'feed', 'wp-json', 'wp-admin', 'robots.txt']);
const IMDB_TITLE_RE = /imdb\.com\/title\/(tt\d{5,})/gi;
/** Primeiro ano entre parênteses. Ano solto no título ("Blade Runner 2049")
 *  não conta: parêntese é declaração do site. */
const YEAR_PAREN_RE = /\((\d{4})\)/g;

/** Pares loc/lastmod de um sitemap (bloco a bloco; o `<loc>` da página é o
 *  primeiro do bloco). */
export function parseSitemapEntries(xml: string): { loc: string; lastmod: string }[] {
  const out: { loc: string; lastmod: string }[] = [];
  for (const block of String(xml || '').match(URL_BLOCK_RE) ?? []) {
    const loc = SITEMAP_LOC_RE.exec(block)?.[1]?.trim();
    if (!loc) continue;
    out.push({ loc, lastmod: SITEMAP_LASTMOD_RE.exec(block)?.[1]?.trim() || '' });
  }
  return out;
}

/**
 * Locs de `post-sitemap*` do índice, ignorando host alheio. `page` /
 * `attachment` / `category` / `post_tag` saem aqui: não são obra.
 */
export function parseSitemapIndexLocs(
  xml: string,
  base: string,
  isDetailHost: (hostname: string | null) => boolean,
): string[] {
  const out: string[] = [];
  for (const block of String(xml || '').match(SITEMAP_BLOCK_RE) ?? []) {
    const loc = SITEMAP_LOC_RE.exec(block)?.[1]?.trim();
    if (!loc) continue;
    let href: URL;
    try { href = new URL(loc, base); } catch { continue; }
    if (!POST_SITEMAP_RE.test(href.pathname)) continue;
    if (!isDetailHost(href.hostname)) continue;
    out.push(href.href);
  }
  return out;
}

/** Loc de post → URL de obra, ou `null` se não for página do site. */
export function toWorkUrl(loc: string, base: string, isDetailHost: (h: string | null) => boolean): URL | null {
  let href: URL;
  try { href = new URL(loc, base); } catch { return null; }
  return isWorkPath(href) && isDetailHost(href.hostname) ? href : null;
}

/** O caminho É de obra. A homepage `/` não casa o segmento único. */
export function isWorkPath(href: URL): boolean {
  if (!WORK_PATH_RE.test(href.pathname)) return false;
  return !NOT_WORK_SEGMENTS.has(decodeURIComponent(href.pathname.slice(1, -1)).toLowerCase());
}

/**
 * Tipo da página pelo slug. Falso positivo aceito: um filme cujo slug traga
 * "temporada" sai como `tv_show` e, com séries desligadas, deixa de ser
 * enfileirado. Obra faltando é visível; obra errada gravada não é.
 */
export function kindFromSlug(href: URL | string): CrawlPageKind {
  let pathname: string;
  try {
    pathname = typeof href === 'string' ? new URL(href).pathname : href.pathname;
  } catch {
    return 'movie';
  }
  return /temporada/i.test(decodeURIComponent(pathname)) ? 'tv_show' : 'movie';
}

/** `true` quando o slug é de página de temporada. */
export function isSeasonSlug(href: URL | string): boolean {
  return kindFromSlug(href) === 'tv_show';
}

/**
 * IMDb da obra. Um tt na página inteira é o da obra (medido no corpo, antes
 * dos comentários). Dois ou mais é widget de recomendação: `null`, porque
 * obra errada é pior que obra nenhuma.
 */
export function parseImdbId(html: string): string | null {
  const found = new Set([...String(html || '').matchAll(IMDB_TITLE_RE)].map((m) => m[1]));
  return found.size === 1 ? [...found][0] : null;
}

export interface WorkTitle {
  title: string;
  year: number | null;
}

/** Comentário, `<script>` e `<style>` fora, para o `<h1>` comentado não vencer. */
function withoutNoise(html: string): string {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Nome da obra e ano a partir do `<h1>`. O ano é o primeiro `(YYYY)` entre
 * 1900 e 2100 — no Comando ele fica no meio, seguido de Dual/WEB-DL. O nome
 * passa por `cleanPostTitle` para a igualdade estrita do TMDB não carregar
 * a vitrine ("Dual Áudio WEB-DL 1080p"). Sem parêntese de ano, `year` é
 * `null` e a identificação não chuta homônimo.
 */
export function workTitleYear(html: string): WorkTitle {
  const source = withoutNoise(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ?? '';
  const raw = decodeEntities(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  let year: number | null = null;
  let title = raw;
  for (const match of raw.matchAll(YEAR_PAREN_RE)) {
    const value = Number(match[1]);
    if (value < 1900 || value > 2100) continue;
    year = value;
    title = `${raw.slice(0, match.index)} ${raw.slice(match.index + match[0].length)}`;
    break;
  }
  title = cleanPostTitle(title);
  return { title, year };
}
