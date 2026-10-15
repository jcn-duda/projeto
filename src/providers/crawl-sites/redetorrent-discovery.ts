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
//   - CONSEQUÊNCIA QUE MUDA O PARSER: o MESMO endpoint responde em DOIS formatos,
//     alternando conforme a sessão do Chromium do FlareSolverr (medido em
//     2026-09-29, chamadas em sequência no mesmo endpoint):
//       A) XML CRU do AIOSEO, com `<loc>`/`<lastmod>` em CDATA e `lastmod` em
//          ISO 8601 de verdade (`2026-09-28T19:32:39+00:00`) — o caminho BOM,
//          porque a data do site chega como ela é.
//       B) HTML RENDERIZADO, o VISUALIZADOR XML do Chromium (o XSL
//          `default-sitemap.xsl` aplicado): `<html><title>Filmes Sitemap
//          </title>` + tabela, e NÃO EXISTE NENHUM `<loc>` (medido na sessão
//          anterior: `movies-sitemap.xml` com len=390584 e locCount=0). A URL
//          está em `<td class="left"><a href="URL">URL</a></td>` e o `lastmod`
//          em `16 de September de 2026` + `17:56` — locale em INGLÊS, mês por
//          NOME, sem ISO.
//     A PRIMEIRA requisição de uma sessão fria é a que paga o browser: ela
//     volta como B (11,3 s medidos) e o `cf_clearance` que ela deixa na sessão
//     faz TODAS as seguintes voltarem pela via direta como A (~0,25 s cada,
//     `movies-sitemap.xml` = 390513 B / 308220 A, 1.000 linhas nos dois). Ou
//     seja: o formato da PRIMEIRA requisição de cada processo é o do browser, e
//     o do resto é o XML cru — e a sessão expira em 20 min
//     (`FLARE_SESSION_TTL_MS`), o que reabre a janela de B a cada processo novo.
//     Nenhuma das duas respostas é challenge do Cloudflare nem truncada: são as
//     duas legítimas, e o parser lê as DUAS — um parser de formato só devolve
//     0 URL em parte das rodadas, em silêncio, com `complete: true`. A detecção
//     é pelo CONTEÚDO (nunca pelo status HTTP, que é 200 nas duas).
//   - Consequência de ar: a mesma URL pode aparecer nos dois formatos numa
//     resposta (o site troca no meio do arquivo, ou um proxy reescreve parte).
//     O dedupe é por URL e o `lastmod` que fica é o de MAIOR valor.
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

// ── FORMATO A (XML CRU) ──────────────────────────────────────────────────────
// Bloco `<url>` do sitemap de obra e `<sitemap>` do índice — os dois são lidos
// pelo MESMO caminho porque `parseSitemapIndexLocs` consome o mesmo
// `parseSitemapRows`. `\b` depois do nome impede `<sitemapindex>` de casar com
// `<sitemap`, e a tag exige o nome INTEIRO logo depois de `<`, então o
// `<image:loc>` do AIOSEO (capa do post) NUNCA entra como loc da página: no
// bloco, o primeiro `<loc>` é o da própria URL.
const XML_URL_BLOCK_RE = /<url\b[^>]*>[\s\S]*?<\/url>/gi;
const XML_SITEMAP_BLOCK_RE = /<sitemap\b[^>]*>[\s\S]*?<\/sitemap>/gi;
const XML_LOC_RE = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i;
const XML_LASTMOD_RE = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i;
/** O site pode trocar de plugin de SEO sem aviso (AIOSEO com CDATA, Yoast sem),
 *  então o embrulho é opcional — nunca exigido. */
const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

/** Um loc do sitemap com a data de origem (string vazia = data ilegível). */
export interface SitemapRow {
  url: string;
  lastmod: string;
}

/**
 * Formato da resposta, lido pelo CONTEÚDO — nunca pelo status HTTP, que é 200
 * nos dois. `unknown` NÃO é "vazio": é a resposta que o parser não entende, e
 * ela precisa chegar como FALHA até o motor, porque `urls: []` com
 * `complete: true` faz o cursor do crawler avançar por cima de acervo nunca
 * lido (a classe de bug mais silenciosa que existe nesta camada).
 */
export type SitemapShape = 'xml' | 'viewer' | 'unknown';

/** Marcadores do XML cru: raiz (`<urlset>`/`<sitemapindex>`), bloco
 *  (`<url>`/`<sitemap>`) ou o próprio `<loc>`. */
const XML_SHAPE_RE = /<(?:urlset|sitemapindex|sitemap|url)\b|<loc\b/i;
/** Marcador da tabela do visualizador: a coluna da esquerda, que é onde o
 *  Chromium coloca a URL. */
const VIEWER_SHAPE_RE = /<td\b[^>]*\bclass="[^"]*\bleft\b/i;
/** Comentário de HTML/XML. A detecção roda SEM ele: o cabeçalho de uma resposta
 *  real (e o das fixtures) nomeia as tags do outro formato — `… zero <loc> …`
 *  — e esse texto viraria XML falso. */
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Em que formato o site respondeu este sitemap. */
export function sitemapShape(html: string): SitemapShape {
  const text = String(html || '').replace(COMMENT_RE, '');
  if (XML_SHAPE_RE.test(text)) return 'xml';
  if (VIEWER_SHAPE_RE.test(text)) return 'viewer';
  return 'unknown';
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

/** Conteúdo de `<loc>`/`<lastmod>`: CDATA do AIOSEO é desembrulhado, entidade
 *  HTML/XML é resolvida (`&amp;` numa URL de sitemap é real) e sobra o texto. */
function xmlText(value: string | null | undefined): string {
  const raw = String(value ?? '');
  const cdata = CDATA_RE.exec(raw);
  return decodeEntities(cdata ? cdata[1] : raw).trim();
}

/**
 * `lastmod` do XML → ISO UTC, no MESMO formato que o caminho da tabela produz.
 * Canonicalizar é o que faz os dois formatos entregarem linhas byte a byte
 * iguais (`2026-09-16T17:56:00+00:00` → `2026-09-16T17:56:00Z`), e não muda a
 * semântica da comparação do cursor, que é `Date.parse`. Data ilegível (o
 * `0000-00-00` que o AIOSEO às vezes emite) vira `''`, nunca data inventada.
 */
function xmlLastmod(value: string | null | undefined): string {
  const raw = xmlText(value);
  const stamp = Date.parse(raw);
  if (!raw || !Number.isFinite(stamp)) return '';
  return `${new Date(stamp).toISOString().slice(0, 19)}Z`;
}

/** Blocos `<url>` (sitemap de obra) e `<sitemap>` (índice), já normalizados. */
function xmlRows(html: string): SitemapRow[] {
  const out: SitemapRow[] = [];
  for (const re of [XML_URL_BLOCK_RE, XML_SITEMAP_BLOCK_RE]) {
    for (const [block] of String(html || '').matchAll(re)) {
      const url = xmlText(XML_LOC_RE.exec(block)?.[1]);
      if (!url) continue;
      out.push({ url, lastmod: xmlLastmod(XML_LASTMOD_RE.exec(block)?.[1]) });
    }
  }
  return out;
}

/**
 * Linhas da tabela renderizada: `{ url, lastmod }`. O `href` da coluna URL e o
 * `<div class="date">`/`<div class="time">` casam por LINHA — casar no
 * documento inteiro pegaria a data da linha vizinha, e um `lastmod` trocado
 * move o cursor do motor para o lado errado (acervo pulado ou reprocessado).
 */
function viewerRows(html: string): SitemapRow[] {
  const out: SitemapRow[] = [];
  for (const [, body] of String(html || '').matchAll(ROW_RE)) {
    const href = HREF_RE.exec(URL_CELL_RE.exec(body)?.[1] ?? '')?.[1];
    const url = href ? decodeEntities(href).trim() : '';
    if (!url) continue;
    out.push({ url, lastmod: parseRenderedLastmod(cellText(DATE_DIV_RE.exec(body)?.[1]), cellText(TIME_DIV_RE.exec(body)?.[1])) });
  }
  return out;
}

/** `a` é mais nova que `b`? Data ilegível não vence data; sem data comparável, a
 *  primeira não vazia fica (nenhum dos dois valores manda sobre o outro). */
function newerLastmod(a: string, b: string): boolean {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta)) return false;
  return !Number.isFinite(tb) || ta > tb;
}

/**
 * Lê o sitemap nos DOIS formatos que o site devolve, e devolve a MESMA lista
 * nos dois. Uma resposta pode vir MISTURA (o site troca de formato no meio do
 * arquivo, ou um proxy reescreve parte): as duas leituras são fundidas por
 * URL, e o `lastmod` que sobrevive é o de MAIOR valor — data antiga aqui é o
 * acervo inteiro daquela linha sendo cortado pelo cursor.
 */
export function parseSitemapRows(html: string): SitemapRow[] {
  const byUrl = new Map<string, SitemapRow>();
  for (const row of [...xmlRows(html), ...viewerRows(html)]) {
    const prev = byUrl.get(row.url);
    if (prev) {
      if (newerLastmod(row.lastmod, prev.lastmod)) prev.lastmod = row.lastmod;
      continue;
    }
    byUrl.set(row.url, { url: row.url, lastmod: row.lastmod });
  }
  return [...byUrl.values()];
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
 * E o desvio medido é para o lado SEGURO (2026-09-29, mesmo endpoint nos dois
 * formatos, MESMA primeira linha): o site publica `2026-09-28T19:32:39+00:00` e
 * o visualizador entrega `16:32` — 3 h ATRÁS, porque o Chromium renderiza no
 * fuso local do browser (UTC-3). O corte incremental do motor é
 * `lastmod <= since`, então um lastmod menor re-admite algumas entradas na
 * próxima rodada; um lastmod MAIOR as pularia. Desvio para trás custa
 * reprocessamento de algumas linhas, desvio para frente custa acervo.
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

/** Locs de sitemap de OBRA do índice (nos DOIS formatos, via
 *  `parseSitemapRows`), ignorando host alheio e dedupe. Índice que não tem nem
 *  um loc de obra volta `[]` — e o chamador trata isso como FALHA de
 *  descoberta, não como "o site não tem filme". */
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
