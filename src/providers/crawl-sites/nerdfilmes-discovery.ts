// Regras PURAS da descoberta do NerdFilmes: o que é página de obra, o que é
// página de TEMPORADA e como o AIOSEO escreve loc/lastmod. Extraído de
// `nerdfilmes.ts` pela catraca de 400 linhas — nada aqui faz rede nem conhece o
// resolver, e é por isso que o `kind` por slug é testável sem dublê de fetch.
//
// O que a MEDIÇÃO no site (2026-09-28: índice + 6 sitemaps + 40 posts do
// recorte real) fixa — por isso é regra aqui e não palpite:
//
//   - SITEMAP: AIOSEO, não Yoast. As entradas de obra são `post-sitemap.xml` …
//     `post-sitemap6.xml` (5.814 posts); `movie-sitemap*` do Vaca não existe.
//     `/sitemap_index.xml` responde 302 para `/sitemap.xml` — os dois caminhos
//     são tentados e o 302 é seguido com allowlist por hop.
//   - URL DE OBRA: slug de UM segmento com barra final (`/bancarios-2020/`).
//     O sitemap NÃO separa filme de série e nenhum post sai da profundidade 1.
//   - SEM IMDB: 0 de 24 posts com `imdb.com/title/tt*`. A identificação é
//     SEMPRE por título+ano no TMDB; o `parseImdbId` só aceita um tt ÚNICO,
//     porque o theme não tem ficha técnica para ancorar.
//   - TIPO POR SLUG: o `post-sitemap` é misto e o tipo só aparece no slug. Das
//     40 páginas do recorte real, 13 são página de TEMPORADA ("…-1a-temporada-",
//     "…-2a-temporada-", "…-13a-temporada-") e 27 são filme.
//
// Onde o portão de série entra: o `kind` certo no rótulo é só METADE do
// trabalho. A outra metade é o `discover` NÃO emitir as URLs de série enquanto o
// motor não liga séries — é o que impede a página de temporada de ser
// enfileirada como filme e gravada (14 magnets de episódio virariam uma "obra" de
// filme que não existe). Ver `nerdfilmes.ts`.
import type { CrawlPageKind } from '../crawl-types.js';
import { stripHtmlComments } from './shared.js';

/** Índice de sitemaps: o canônico do AIOSEO e o nome Yoast (302 medido). */
export const SITEMAP_INDEX_PATHS = ['sitemap.xml', 'sitemap_index.xml'];
/** Sitemaps de obra: `post-sitemap.xml`, `post-sitemap2.xml`… (AIOSEO). */
const POST_SITEMAP_RE = /\/post-sitemap\d*\.xml$/i;
/** Bloco `<url>…</url>` do sitemap (o `image:loc` do AIOSEO fica de fora: o
 *  `<loc>` da PÁGINA é o primeiro do bloco). */
const URL_BLOCK_RE = /<url>[\s\S]*?<\/url>/gi;
const SITEMAP_BLOCK_RE = /<sitemap>[\s\S]*?<\/sitemap>/gi;
/** `<loc>`/`<lastmod>` com CDATA do AIOSEO (`<![CDATA[…]]>`) ou sem. */
const SITEMAP_LOC_RE = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i;
const SITEMAP_LASTMOD_RE = /<lastmod>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/lastmod>/i;
/** Obra: UM segmento com barra final, sem extensão. `link.php` (o gate) e
 *  `feed` ficariam nesse formato e NÃO são obra. */
const WORK_PATH_RE = /^\/[^/]+\/$/;
const NOT_WORK_SEGMENTS = new Set(['link.php', 'feed', 'wp-json', 'wp-admin', 'robots.txt']);
/** tt do IMDb em qualquer posição. O theme do nerdfilmes não publica ficha
 *  técnica (0 de 24 posts medidos), então a ÚNICA prova é a unicidade. */
const IMDB_TITLE_RE = /imdb\.com\/title\/(tt\d{5,})/gi;

/**
 * Sinais de TEMPORADA no slug, na ordem em que aparecem no acervo real. Os três
 * vêm do mesmo recorte de 40:
 *   - `-1a-temporada-`: "lanternas-1a-temporada-2026", "s-w-a-t-exiles-1a-temporada-2026";
 *   - `-1-temporada-`: variante sem o "a" do ordinal;
 *   - `temporada`: cobre os ordinais maiores ("outlander-…-2a-temporada-2026",
 *     "star-trek-…-4a-temporada-2026", "american-horror-story-13a-temporada-2026")
 *     e o plural ("todas-as-temporadas").
 * Falso positivo aceito e DE PROPÓSITO: um filme cujo slug pt traga a palavra
 * "temporada" sai como `tv_show` e, com séries desligadas, deixa de ser
 * enfileirado. O erro é "obra faltando" (visível no painel), nunca "obra
 * errada gravada" — a direção que o resto do desenho já escolhe.
 */
const SEASON_SLUG_RES: readonly RegExp[] = [
  /-1a-temporada-/i,
  /-1-temporada-/i,
  /temporada/i,
];

/** Pares loc/lastmod de um sitemap do AIOSEO (bloco a bloco). */
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
 * Locs de `post-sitemap*` do índice, ignorando host alheio. `page`/`category`/
 * `addl` saem aqui: não são obra. O tipo NÃO é decidido aqui — quem sabe o
 * tipo da página é o slug (`kindFromSlug`), não o nome do arquivo.
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
    if (!isDetailHost(href.hostname)) continue; // loc do índice é INPUT do site
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

/** O caminho É de obra (o gate `/link.php` e `feed` não são, apesar de terem o
 *  mesmo formato de um segmento). */
export function isWorkPath(href: URL): boolean {
  if (!WORK_PATH_RE.test(href.pathname)) return false;
  return !NOT_WORK_SEGMENTS.has(decodeURIComponent(href.pathname.slice(1, -1)).toLowerCase());
}

/**
 * Tipo da página pelo slug. É a única fonte disponível neste site: o
 * `post-sitemap` é único e não traz tipo, e o `<h1>` ("Lanternas 1ª Temporada
 * (2026)") só é lido DEPOIS, na fila. Etapa seguinte do portão: com séries
 * desligadas a página de temporada não é enfileirada (ver `nerdfilmes.ts`).
 */
export function kindFromSlug(href: URL | string): CrawlPageKind {
  let pathname: string;
  try {
    pathname = typeof href === 'string' ? new URL(href).pathname : href.pathname;
  } catch {
    return 'movie';
  }
  const slug = decodeURIComponent(pathname);
  return SEASON_SLUG_RES.some((re) => re.test(slug)) ? 'tv_show' : 'movie';
}

/** `true` quando o slug é de página de temporada (atalho do portão em
 *  `fetchWork`, que precisa recusar a linha antiga que chegou como filme). */
export function isSeasonSlug(href: URL | string): boolean {
  return kindFromSlug(href) === 'tv_show';
}

/**
 * IMDb da OBRA. O theme do nerdfilmes não publica ficha técnica (medido: 0 de
 * 24 posts com `imdb.com/title/tt*`), então não existe âncora como a do Vaca —
 * a prova disponível é a unicidade: UM tt na página inteira é o da obra, dois
 * ou mais é página ambígua (widget de recomendação) e `null` é o veredito.
 * `null` não perde nada: a identificação por título+ano é o caminho REAL deste
 * site, e obra errada é pior que obra nenhuma.
 */
export function parseImdbId(html: string): string | null {
  const source = stripHtmlComments(html);
  const found = new Set([...source.matchAll(IMDB_TITLE_RE)].map((m) => m[1]));
  return found.size === 1 ? [...found][0] : null;
}
