// Regras PURAS do RedeTorrent para o motor de raspagem. Nada aqui faz rede nem
// conhece o resolver: o que é sitemap de obra, o que é página de obra, o tipo
// pelo caminho, o NOME no `<h1>` e a leitura do `lastmod` são testáveis sem
// dublê de fetch.
//
// ── A MEDIÇÃO QUE ORGANIZA ESTE ARQUIVO (2026-09-28, FlareSolverr) ──────────
//
//   - SITEMAP: AIOSEO, e o índice é `/sitemap.xml` — é o que o `robots.txt`
//     declara. `/sitemap_index.xml` e `/wp-sitemap.xml` NÃO são o índice. O
//     índice tem 96 entradas.
//   - O SITE ESTÁ 100% ATRÁS DE CLOUDFLARE: fetch direto de `robots.txt`,
//     `/sitemap.xml` e `/movies-sitemap.xml` devolve 403 "Just a moment..."
//     nos três. Por isso a descoberta vai SEMPRE pelo `fetchText` do profile
//     (direto → FlareSolverr, sessão de 20 min reaproveitada).
//   - CONSEQUÊNCIA QUE MUDA O PARSER: o FlareSolverr devolve o VISUALIZADOR XML
//     do Chromium, não o XML. O texto chega como `<html><title>Filmes Sitemap
//     </title>` + uma tabela HTML renderizada, e NÃO EXISTE NENHUM `<loc>`
//     (medido: `movies-sitemap.xml` com len=390584 e locCount=0). A URL está em
//     `<td class="left"><a href="URL">URL</a></td>` — e no índice o mesmo loc
//     aparece 2x (o `href` e o texto do link), daí o dedupe por URL.
//   - SITEMAPS DE OBRA: `movies-sitemap*.xml` (7 arquivos) e
//     `tvshows-sitemap.xml` (1). NÃO é `post-sitemap*`: os 18 `post-sitemap*.xml`
//     do índice são posts `baixar-<slug>-torrent` na RAIZ do site, e a medição
//     não achou NENHUM deles em `/filmes/` ou `/series/`. Filtrar por
//     `post-sitemap` traria ~18 mil URLs inúteis, todas reprovadas depois por
//     `isWorkPath`. Fora também `category-sitemap*`, `page-sitemap`,
//     `faq-sitemap`, `genres-sitemap`, `addl-sitemap` e ~70 `dt*-sitemap*`
//     (taxonomias do tema de filmes).
//   - ACERVO: 6.737 páginas `/filmes/<slug>/` (1000×6 + 737) e 705 páginas
//     `/series/<slug>/`.
//   - `lastmod` NÃO VEM EM ISO: o Chromium renderiza
//     `<div class="date">16 de September de 2026</div>` +
//     `<div class="time">17:56</div>` — locale em INGLÊS, mês por NOME. Data
//     ilegível vira `''` (o `maxLastmod` tolera string vazia) e NUNCA data
//     inventada: lastmod falso move o cursor do motor e faz o acervo ser pulado.
//
// ── POR QUE A DESCOBERTA NÃO PAGINA `/filmes/` ─────────────────────────────
// A régua de obra acima JÁ é o índice completo do acervo (6.737 + 705 páginas
// mapeadas em 8 arquivos). A paginação de fallback sobre a listagem existe para
// site sem sitemap de obra e não é implementada aqui de propósito: ela seria
// um segundo caminho de descoberta medindo o mesmo acervo, com custo por hora
// e taxa de duplicata, sem ganhar nenhuma página.
import type { CrawlPageKind } from '../crawl-types.js';
import { decodeEntities } from '../../utils/title-normalization.js';
import { readWorkTitle } from './work-name.js';

/**
 * Índice de sitemaps. O canônico que o `robots.txt` declara vem PRIMEIRO
 * (medido: é o único que respondeu); `sitemap_index.xml` é a reserva, para o
 * dia em que o site voltar ao nome Yoast.
 */
export const SITEMAP_INDEX_PATHS = ['sitemap.xml', 'sitemap_index.xml'];
/** Sitemaps de OBRA do AIOSEO: `movies-sitemap.xml`, `movies-sitemap2.xml`… e
 *  `tvshows-sitemap.xml`. O `\d*` no tv-show é de futuro-proofing: hoje existe
 *  só um arquivo, e um `tvshows-sitemap2.xml` NÃO pode fazer a série sumir. */
const WORK_SITEMAP_RE = /\/(?:movies|tvshows)-sitemap\d*\.xml$/i;
const TV_SHOWS_SITEMAP_RE = /\/tvshows-sitemap\d*\.xml$/i;
/**
 * Obra: `/filmes/<slug>/` ou `/series/<slug>/` — UM segmento e barra final. É
 * a única forma de URL de obra do site, e ela já recusa as listagens
 * (`/filmes/`, `/series/`), `/genero/…`, `/page/N/` e a raiz. A barra final é
 * do próprio site: sem ela o `<a href>` do visualizador traria a mesma página
 * duas vezes com `url_key` distinto (`crawl-url-key.ts`).
 */
const WORK_PATH_RE = /^\/(?:filmes|series)\/[^/]+\/$/;
/** tt + o resto da URL (a query denuncia o widget de NOTA/PLUGIN colado). */
const IMDB_TITLE_RE = /imdb\.com\/title\/(tt\d{5,})([^"'\s<>]*)/gi;
/**
 * Widget de outro post (`?ref_=tt_plg_rt`): a armadilha medida no ComandoTorrents
 * — o autor cola o widget e o `tt` é de obra ALEATÓRIA. O widget de NOTA deste
 * site (`nota-imdb`, medido nos cards de busca: `imdb.com/pt/` + `imdb/8/`)
 * não produz `tt` nenhum, então ele nunca chega aqui — a guarda é pela
 * mesma razão do irmão: `CrawlWorkResult.imdb` promete que obra errada é pior
 * que obra nenhuma.
 */
const IMDB_WIDGET_RE = /[?&]ref_=tt_/i;
/** Linha da tabela renderizada; a URL e a data saem da MESMA linha. */
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const URL_CELL_RE = /<td\b[^>]*\bclass="[^"]*\bleft\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i;
const HREF_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i;
const DATE_DIV_RE = /<div\b[^>]*\bclass="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const TIME_DIV_RE = /<div\b[^>]*\bclass="[^"]*\btime\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

/** Um loc do sitemap com a data de origem (string vazia = data ilegível). */
export interface SitemapRow {
  url: string;
  lastmod: string;
}

/** Resultado da leitura do `<h1>`: NOME da obra, ano e texto cru. */
export interface WorkTitle {
  title: string;
  year: number | null;
  /** Texto do `<h1>` como o site publica — é o que o `releaseTitle` do profile
   *  limpa para o título da release, e precisa ser o CRU: a busca viva do card
   *  monta o mesmo título a partir do `title=` do card de busca, que é byte a
   *  byte o `<h1>` do post (medido: "Coringa: Delírio a Dois (2024)" nos dois
   *  lados). Uma segunda limpeza aqui criaria uma terceira régua. */
  raw: string;
}

/** Texto de célula/div do visualizador: sem tag, sem entidade, colapsado. */
function cellText(value: string | null | undefined): string {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Linhas da tabela renderizada: `{ url, lastmod }`. O `href` da coluna URL e o
 * `<div class="date">`/`<div class="time">` casam por LINHA — casar no
 * documento inteiro pegaria a data da linha vizinha, e um `lastmod` trocado
 * move o cursor do motor para o lado errado (acervo pulado ou reprocessado).
 *
 * Dedup por URL: no índice o mesmo loc aparece 2x dentro da célula (o `href` e
 * o texto do link), e a lista de sitemaps é o que a rodada lê.
 */
export function parseSitemapRows(html: string): SitemapRow[] {
  const out: SitemapRow[] = [];
  const seen = new Set<string>();
  for (const [, body] of String(html || '').matchAll(ROW_RE)) {
    const cell = URL_CELL_RE.exec(body)?.[1] ?? '';
    const href = HREF_RE.exec(cell)?.[1];
    if (!href) continue;
    const url = decodeEntities(href).trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const date = cellText(DATE_DIV_RE.exec(body)?.[1]);
    const time = cellText(TIME_DIV_RE.exec(body)?.[1]);
    out.push({ url, lastmod: parseRenderedLastmod(date, time) });
  }
  return out;
}

/** Meses do locale do visualizador (inglês, por NOME — ver a medição). */
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
/** "16 de September de 2026" (medido) e a mesma forma sem as preposições. */
const DATE_RE = /^(\d{1,2})\s+(?:de\s+)?([A-Za-z]{3,9})\.?,?\s+(?:de\s+)?(\d{4})$/;
/** Já em ISO, para o dia em que o visualizador mude de locale. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `lastmod` do visualizador → ISO. Dia/hora/minuto são tratados como UTC: o
 * visualizador não traz fuso, e deslocar a data por um fuso chutado moveria o
 * cursor do motor em horas — o acervo seria pulado na volta ou reprocessado sem
 * necessidade. O custo é uma granularidade de hora, que a cadência incremental
 * do motor (minutos/horas) absorve.
 *
 * Data ilegível → `''`, nunca data inventada: `maxLastmod` já tolera string
 * vazia, e um lastmod falso é pior que lastmod ausente.
 */
export function parseRenderedLastmod(date: string, time?: string): string {
  const raw = String(date || '').trim();
  if (!raw) return '';
  const iso = ISO_DATE_RE.exec(raw);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const parts = DATE_RE.exec(raw);
    if (!parts) return '';
    day = Number(parts[1]);
    month = MONTHS[parts[2].toLowerCase()] ?? 0;
    year = Number(parts[3]);
  }
  if (!month || day < 1 || day > 31 || year < 1900 || year > 2100) return '';
  const stamp = Date.UTC(year, month - 1, day);
  const d = new Date(stamp);
  // Dia impossível na data montada (31 de fevereiro) é data ilegível, não data.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return '';
  const clock = TIME_RE.exec(String(time || '').trim());
  const hh = clock ? Math.min(23, Number(clock[1])) : 0;
  const mm = clock ? Math.min(59, Number(clock[2])) : 0;
  const ss = clock ? Math.min(59, Number(clock[3] ?? 0)) : 0;
  return `${d.toISOString().slice(0, 10)}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Locs de sitemap de OBRA do índice, ignorando host alheio e dedupe. */
export function parseSitemapIndexLocs(
  html: string,
  base: string,
  isDetailHost: (hostname: string | null) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of parseSitemapRows(html)) {
    let href: URL;
    try { href = new URL(row.url, base); } catch { continue; }
    if (!isWorkSitemap(href)) continue;
    if (!isDetailHost(href.hostname)) continue;
    if (seen.has(href.href)) continue;
    seen.add(href.href);
    out.push(href.href);
  }
  return out;
}

/** O loc é um sitemap de OBRA (`movies-sitemap*` / `tvshows-sitemap*`). */
export function isWorkSitemap(href: URL | string): boolean {
  return WORK_SITEMAP_RE.test(pathnameOf(href));
}

/**
 * O loc é o sitemap de SÉRIE. Com séries desligadas o adaptador pula esse
 * arquivo inteiro: uma requisição a menos por rodada de descoberta, e nenhum
 * URL de `tv_show` entra na fila (o `kind` do caminho já recusaria).
 */
export function isSeriesSitemap(href: URL | string): boolean {
  return TV_SHOWS_SITEMAP_RE.test(pathnameOf(href));
}

/** Caminho de um `URL` ou de uma string (URL absoluta ou caminho solto). */
function pathnameOf(href: URL | string): string {
  if (typeof href !== 'string') return href.pathname;
  try { return new URL(href).pathname; } catch { return href; }
}

/** O caminho É de página de obra (`/filmes/<slug>/` ou `/series/<slug>/`). */
export function isWorkPath(href: URL | string): boolean {
  return WORK_PATH_RE.test(pathnameOf(href));
}

/**
 * Tipo da página pelo CAMINHO — que é o que o site separa de verdade:
 * `/filmes/` é o acervo de filmes e `/series/` o de séries (medido nos cards da
 * busca: `workTypeFromPath` no profile lê exatamente estes dois prefixos). Não
 * é palpite de slug: o post de série daqui agrega mais de uma temporada
 * ("Fallout 1ª 2ª Temporada (2025)", "Temporadas: 2"), e o caminho é o que
 * sobrevive quando o slug muda de grafia.
 */
export function kindFromPath(href: URL | string): CrawlPageKind {
  return /^\/series\//i.test(pathnameOf(href)) ? 'tv_show' : 'movie';
}

/** Loc de post → URL de obra, ou `null` se não for página do site. */
export function toWorkUrl(loc: string, base: string, isDetailHost: (h: string | null) => boolean): URL | null {
  let href: URL;
  try { href = new URL(loc, base); } catch { return null; }
  return isWorkPath(href) && isDetailHost(href.hostname) ? href : null;
}

/**
 * IMDb da obra. Um `tt` único na página é o da obra; dois ou nenhum é
 * ambíguo (widget de recomendação) e a identificação cai para título+ano.
 */
export function parseImdbId(html: string): string | null {
  const found = new Set(
    [...String(html || '').matchAll(IMDB_TITLE_RE)]
      .filter((m) => !IMDB_WIDGET_RE.test(m[2] ?? ''))
      .map((m) => m[1]),
  );
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Nome da obra e ano a partir do `<h1>`. Aqui a régua COMPARTILHADA
 * (`work-name.ts`) serve: o `<h1>` deste site TERMINA no ano entre parênteses
 * ("Coringa: Delírio a Dois (2024)", "Fallout 1ª 2ª Temporada (2025)"), que é
 * exatamente a forma do ComandoTorrents, mesmo tema de filmes. A régua PRÓPRIA
 * do TorrentDosFilmes (ano no MEIO do título) não é copiada aqui — duas cópias
 * divergiriam em silêncio, e ela já está escrita no arquivo dela.
 */
export function workTitleYear(html: string): WorkTitle {
  return readWorkTitle(html);
}
