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
import { readWorkTitle } from './work-name.js';

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
/** tt + o resto da URL (a query denuncia o plugin de nota, ver `parseImdbId`). */
const IMDB_TITLE_RE = /imdb\.com\/title\/(tt\d{5,})([^"'\s<>]*)/gi;
/** Link do PLUGIN de nota do IMDb (`?ref_=tt_plg_rt`), colado pelo autor do post. */
const IMDB_PLUGIN_RE = /[?&]ref_=tt_plg/i;

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
 *
 * O PLUGIN de nota do IMDb (`<span data-title=…><a href="…/tt…/?ref_=tt_plg_rt">`)
 * não conta: o autor cola o widget de outro post e o tt é de obra ALHEIA.
 * Medido em 2026-09-28: em 80 filmes, 1 página tinha o plugin e ele era o
 * único tt — `tt1959490` ("Noé", 2014) em "Busca Implacável 3" e em "Curvas
 * da Vida", o mesmo link que o TorrentDosFilmes (mesma rede) já provou ser
 * aleatório. Sem ele, a página cai na identificação por título+ano.
 */
export function parseImdbId(html: string): string | null {
  const found = new Set(
    [...String(html || '').matchAll(IMDB_TITLE_RE)]
      .filter((m) => !IMDB_PLUGIN_RE.test(m[2] ?? ''))
      .map((m) => m[1]),
  );
  return found.size === 1 ? [...found][0] : null;
}

export interface WorkTitle {
  title: string;
  year: number | null;
}

/**
 * Nome da obra e ano a partir do `<h1>`. O ano é o primeiro `(YYYY)` — no
 * Comando ele fica no meio, seguido de Dual/WEB-DL. O nome passa pela régua
 * do NOME (`work-name.ts`, a mesma do TorrentDosFilmes, que é da mesma rede),
 * não pelo `cleanPostTitle` do resolver: aquele é a régua do título da RELEASE
 * e deixava "– GDRIVE", " e" órfão e "/ Legendas Fixas em Português" no nome
 * (medido na raspagem real, 2026-09-28). Sem parêntese de ano, `year` é `null`
 * e a identificação não chuta homônimo.
 */
export function workTitleYear(html: string): WorkTitle {
  // Sem parêntese no `<h1>`, o ano que a ficha declara (nunca o ano solto).
  const { title, year } = readWorkTitle(html);
  return { title, year };
}
