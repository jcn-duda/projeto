// Regras PURAS do BLUDV para o motor de raspagem: o que é página de obra, o que
// é página de TEMPORADA, como o Yoast escreve loc/lastmod e qual o 2º nome da
// identificação. Nada aqui faz rede nem conhece o resolver.
//
// ── A MEDIÇÃO QUE ORGANIZA ESTE ARQUIVO (2026-09-29, 12+14 posts e 18
//    `post-sitemap*` lidos do site real) ────────────────────────────────────
//
//   - DOMÍNIO: `bludvfilmes1.xyz`. A resposta direta voltou 200 SEM desafio
//     Cloudflare nesta medição (o AGENTS registra o site atrás de challenge
//     desde 2026-08-28), então o caminho de leitura é o `fetchText` DO PROFILE,
//     que tenta direto e cai no FlareSolverr no 403 — o mesmo acesso, com a
//     sessão reaproveitada quando o servidor exigir.
//   - SITEMAP: Yoast. O `robots.txt` declara `/sitemap_index.xml` (é o que
//     responde 200, com 54 entradas: 18 `post-sitemap*`, 33 `post_tag-sitemap*`,
//     1 `category-sitemap`, 1 `page-sitemap` e 1 `author-sitemap`).
//     `/sitemap.xml` e `/wp-sitemap.xml` são 301 para o canônico e devolvem o
//     mesmo corpo, então ficam como reserva. SEM CDATA (ao contrário do AIOSEO do
//     RedeTorrent) — o parser aceita os dois porque o site troca de plugin de
//     SEO sem aviso.
//   - ACERVO: 17.860 posts nos 18 arquivos, TODOS com a mesma forma — UM
//     segmento, barra final, sem extensão, na raiz. Zero multi-segmento, zero
//     sem barra final, zero com extensão. A PRIMEIRA linha do `post-sitemap.xml`
//     é a home `/`, exatamente como no TorrentDosFilmes.
//   - TIPO PELO SLUG: o `post-sitemap*` é MISTO e não traz tipo. 3.236 das 17.860
//     linhas (18,1%) têm "temporada" no slug, e a medição em 4 delas confirma
//     que são pack de temporada ("Smallville 10ª Temporada (2010)", "Friends 4ª
//     Temporada (1997)"), não filme. Nenhum slug de taxonomia aparece aqui.
//   - `<h1>`: TERMINA no ano entre parênteses ("O Final da Turnê Torrent – Blu-ray
//     Rip 720p e 1080p Dublado (2016)", "Smallville 10ª Temporada Torrent – Blu-ray
//     Rip 720p Dublado (2010)") — a forma do ComandoTorrents, então a régua
//     COMPARTILHADA de `work-name.ts` serve inteira e a do TorrentDosFilmes (ano
//     no meio) NÃO é copiada.
//   - IMDB: a ficha publica UM `tt`, no link que vem logo depois do rótulo
//     "IMDb" (medido: 12 de 14 páginas com tt, 2 sem, ZERO com dois ou mais; e
//     em todas as 12 o `tt` está a 36–41 caracteres do rótulo). Diferente do
//     ComandoTorrents, aqui o `?ref_=tt_plg_rt` é o PLUGIN DE NOTA DA PRÓPRIA
//     ficha, não widget colado: os `tt` conferidos no IMDb são das obras
//     (`tt2802136` = "Home Sweet Hell" = "Lar Doce Inferno", `tt3179568` = "Men,
//     Women & Children" = "Homens, Mulheres e Filhos", `tt2300975` = "Jessabelle",
//     `tt0851851` = "Terminator: The Sarah Connor Chronicles"). Por isso a guarda
//     aqui é a ANCORAGEM NA FICHA, e não o filtro `ref_=tt_` dos outros sites
//     (que aqui descartaria o `tt` correto).
//   - TÍTULO ORIGINAL: DUAS formas, e o helper compartilhado erra na segunda —
//     `<b>Título Original:</b> NOME` (7 de 12) ele lê, e
//     `<strong><em>Título Original:</em></strong> NOME` (5 de 12) devolve ":",
//     porque a regex da ficha aceita `b|strong|span` e não conhece `<em>`. A
//     solução é de NORMALIZAÇÃO, não de régua: tira-se a tag `<em>` ANTES de
//     delegar ao helper compartilhado, que continua sendo o dono de todas as
//     regras de limpeza, decodificação e teto. Nenhuma cópia divergente.
import type { CrawlPageKind } from '../crawl-types.js';
import { parseOriginalTitle as parseSharedOriginalTitle } from './shared.js';
import { readWorkTitle } from './work-name.js';

/**
 * Índice de sitemaps. O canônico que o `robots.txt` declara vem PRIMEIRO
 * (medido: é o único que respondeu 200 de verdade); o nome Yoast e o `wp-sitemap`
 * ficam como reserva, e nenhum dos dois é inofensivo — são 301 para o canônico,
 * que o laço de redirects segue com allowlist por hop e devolve o mesmo XML.
 */
export const SITEMAP_INDEX_PATHS = ['sitemap_index.xml', 'sitemap.xml', 'wp-sitemap.xml'];
/**
 * Sitemaps de OBRA: `post-sitemap.xml`, `post-sitemap2.xml`… (Yoast). As
 * taxonomias saem pelo NOME: 35 das 54 entradas do índice real são
 * `post_tag-sitemap*` (1.000 tags cada), e `category-sitemap.xml` traz 826
 * listagens de `/series/<obra>/`, `/generos/…`, `/resolucao/1080p/` e
 * `/lancamento/2026/` — nenhum deles é página de obra.
 */
const POST_SITEMAP_RE = /\/post-sitemap\d*\.xml$/i;
/** Bloco `<url>…</url>` do Yoast. */
const URL_BLOCK_RE = /<url\b[^>]*>[\s\S]*?<\/url>/gi;
const SITEMAP_BLOCK_RE = /<sitemap\b[^>]*>[\s\S]*?<\/sitemap>/gi;
/**
 * `<loc>`/`<lastmod>` com CDATA (AIOSEO) ou sem (Yoast, o que o site publica
 * hoje): o site troca de plugin de SEO sem aviso, e o parser não pode quebrar no
 * dia da troca. O `image:loc` do Yoast NÃO entra — a tag do bloco é `<loc>`
 * inteiro, então `<image:loc>` nunca casa, e o `<loc>` da PÁGINA é o primeiro do
 * bloco (medido: a única linha do acervo com `image:image` traz a capa e o botão
 * como `image:loc`, e a página continua sendo a obra).
 */
const SITEMAP_LOC_RE = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i;
const SITEMAP_LASTMOD_RE = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i;
const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;
/**
 * Obra: UM segmento com barra final. É a forma do acervo inteiro do BLUDV
 * (17.860 de 17.860), e ela já recusa a home `/` (que o `post-sitemap.xml`
 * inclui como primeira linha) e qualquer taxonomia de caminho mais fundo
 * (`/generos/acao/`, `/series/fallout/`).
 */
const WORK_PATH_RE = /^\/[^/]+\/$/;
/**
 * Segmento único que NÃO é obra. São as raízes reais de taxonomia do site
 * (medidas no `category-sitemap.xml`: 826 entradas) mais as rotas do WordPress.
 * `/filmes/` e `/series/` são listagens de verdade — a régua do caminho as
 * aceitaria (um segmento, barra final) e a fila receberia taxonomia como obra.
 */
const NOT_WORK_SEGMENTS = new Set([
  'filmes', 'series', 'anime', 'novela', 'generos', 'genero', 'lancamento', 'qualidades',
  'resolucao', 'm2ts', 'mkv', 'mp4', 'uncategorized', 'tag', 'author', 'page',
  'feed', 'wp-json', 'wp-admin', 'robots.txt', 'sitemap.xml', 'sitemap_index.xml', 'wp-sitemap.xml',
]);
/**
 * Sinais de TEMPORADA no slug. A MEDIÇÃO no acervo inteiro (3.236 linhas em
 * 17.860) diz que "temporada" no slug é a marca do pack de temporada, e as 4
 * páginas amostradas confirmam. As grafias vêm do próprio acervo:
 * `10a-temporada`, `2a-temporada-torrent-blu-ray-rip-720p-dublado-2009`,
 * `temporada-completa-mini-serie`.
 *
 * Falso positivo aceito e DE PROPÓSITO, com a mesma direção dos outros sites: um
 * filme com "temporada" no slug sai como `tv_show` e, com séries desligadas,
 * deixa de ser enfileirado. O erro é "obra faltando" (visível no painel), nunca
 * "obra errada gravada" — e a linha que chegar como `movie` é recusada na porta
 * do `fetchWork`.
 *
 * `minisserie` e `serie-completa` entram pelo mesmo motivo (medido em
 * 2026-09-29): "Redenção Minissérie Completa", "The Pale Horse Minissérie" e
 * "Mr. Bean Série Completa" não têm "temporada" no slug e caíam como FILME. O
 * `serie` SOLTO não entra: "Assassino em Série", "A Série Divergente" e "Uma
 * Noite Fora de Série" são filmes.
 */
const SEASON_SLUG_RE = /temporada|minis+erie|serie-completa/i;
/**
 * Categorias do PRÓPRIO post (`rel="category tag"`), não do menu. O BLUDV põe
 * toda série em `/series/` e todo filme em `/filmes/`, mesmo o filme com "Série"
 * no nome — medido em 85 páginas (2026-09-29): a categoria separou as 5 séries
 * de verdade dos 80 filmes, sem falso positivo.
 */
const POST_CATEGORY_RE = /href="[^"]*\/(series|filmes)\/(?:[^"/]*\/)?"\s+rel="category tag"/gi;
/** Marcadores do XML de sitemap: raiz (`<urlset>`/`<sitemapindex>`), bloco ou loc. */
const XML_SHAPE_RE = /<(?:urlset|sitemapindex|sitemap|url)\b|<loc\b/i;
/** tt + o resto da URL (a query do plugin de nota). */
const IMDB_TITLE_RE = /imdb\.com\/title\/(tt\d{5,})([^"'\s<>]*)/gi;
/**
 * Rótulo da ficha. A janela é medida: em 12 de 12 páginas com `tt` o link fica
 * a 36–41 caracteres do rótulo (`<b>Classificação:</b> 12 Anos<br> <strong>IMDb
 * </strong>: <a href=…`). 200 é folga para a marcação do tema, e continua curto
 * demais para alcançar um widget de outro post no fim da página.
 */
const IMDB_LABEL_RE = /IMDb/gi;
const IMDB_LABEL_WINDOW = 200;

/** Resultado da leitura do `<h1>`: NOME da obra, ano e texto cru. */
export interface WorkTitle {
  title: string;
  year: number | null;
  /**
   * Texto do `<h1>` como o site publica — é o que o `releaseTitle` do profile
   * limpa, e precisa ser o CRU: o `title=` do card de busca vivo é byte a byte o
   * `<h1>` do post. Uma segunda limpeza aqui criaria uma terceira régua.
   */
  raw: string;
}

/** Conteúdo de `<loc>`/`<lastmod>`: CDATA desembrulhado, entidade resolvida. */
function xmlText(value: string | null | undefined): string {
  const raw = String(value ?? '');
  const cdata = CDATA_RE.exec(raw);
  return (cdata ? cdata[1] : raw).replace(/&amp;/g, '&').trim();
}

/**
 * `lastmod` para o formato que o motor compara (`Date.parse`), ou `''` quando a
 * data é ILEGÍVEL. O `0000-00-00` que o Yoast às vezes emite vira vazio, e não
 * a string crua: o valor cru chegaria ao store como `lastmod` gravado, e um
 * cursor que lê `0000-00-00` como nada compara errado na rodada seguinte. Vazia
 * é o estado que o motor já tolera (entra sempre, sem pular acervo).
 */
function lastmodOf(value: string | null | undefined): string {
  const raw = xmlText(value);
  return Number.isFinite(Date.parse(raw)) ? raw : '';
}

/** O corpo é um sitemap em XML? `false` é a forma silenciosa de perder acervo. */
export function isSitemapXml(text: string): boolean {
  return XML_SHAPE_RE.test(String(text || ''));
}

/** Pares loc/lastmod de um sitemap de obra, bloco a bloco. */
export function parseSitemapEntries(xml: string): { loc: string; lastmod: string }[] {
  const out: { loc: string; lastmod: string }[] = [];
  for (const block of String(xml || '').match(URL_BLOCK_RE) ?? []) {
    const loc = xmlText(SITEMAP_LOC_RE.exec(block)?.[1]);
    if (!loc) continue;
    out.push({ loc, lastmod: lastmodOf(SITEMAP_LASTMOD_RE.exec(block)?.[1]) });
  }
  return out;
}

/**
 * Locs de `post-sitemap*` do índice. `category-sitemap*` (826 listagens de
 * `/series/…`), `post_tag-sitemap*` (1.000 tags) e os demais saem pelo NOME do
 * arquivo, e o host alheio sai pelo allowlist do site — o loc do índice é INPUT
 * do site, então host de fora nunca é nem consultado.
 */
export function parseSitemapIndexLocs(
  xml: string,
  base: string,
  isDetailHost: (hostname: string | null) => boolean,
): string[] {
  const out: string[] = [];
  for (const block of String(xml || '').match(SITEMAP_BLOCK_RE) ?? []) {
    const loc = xmlText(SITEMAP_LOC_RE.exec(block)?.[1]);
    if (!loc) continue;
    let href: URL;
    try { href = new URL(loc, base); } catch { continue; }
    if (!POST_SITEMAP_RE.test(href.pathname)) continue;
    if (!isDetailHost(href.hostname)) continue;
    out.push(href.href);
  }
  return out;
}

/** O caminho É de página de obra (a home e as taxonomias não são). */
export function isWorkPath(href: URL | string): boolean {
  const path = pathnameOf(href);
  if (!WORK_PATH_RE.test(path)) return false;
  let segment = path;
  try { segment = decodeURIComponent(path.slice(1, -1)).toLowerCase(); } catch { /* caminho cru é comparado como está */ }
  return !NOT_WORK_SEGMENTS.has(segment);
}

/** Loc de post → URL de obra, ou `null` se não for página do site. */
export function toWorkUrl(loc: string, base: string, isDetailHost: (h: string | null) => boolean): URL | null {
  let href: URL;
  try { href = new URL(loc, base); } catch { return null; }
  return isWorkPath(href) && isDetailHost(href.hostname) ? href : null;
}

/**
 * Tipo da página pelo slug — a única fonte disponível: o `post-sitemap*` é
 * misto e não traz tipo, e o `<h1>` só é lido DEPOIS, na fila.
 */
export function kindFromSlug(href: URL | string): CrawlPageKind {
  return isSeasonSlug(href) ? 'tv_show' : 'movie';
}

/** `true` quando o slug é de página de temporada (pack). */
export function isSeasonSlug(href: URL | string): boolean {
  let path = pathnameOf(href);
  try { path = decodeURIComponent(path); } catch { /* slug cru ainda casa o padrão */ }
  return SEASON_SLUG_RE.test(path);
}

/**
 * `true` quando o post se declara SÉRIE nas categorias dele (`/series/…`) e não
 * se declara filme. É a rede do slug: "Boneca Russa 1ª Temporada" mora em
 * `boneca-russa-torrent-web-dl-720p-1080p-dual-audio-download/`, sem nada de
 * temporada no caminho, e a descoberta a enfileira como filme. O post com as
 * duas categorias (anime publicado nas duas) fica como está: o sinal só vale
 * sem contradição.
 */
export function postDeclaresSeries(html: string): boolean {
  const kinds = new Set([...String(html || '').matchAll(POST_CATEGORY_RE)].map((m) => m[1].toLowerCase()));
  return kinds.has('series') && !kinds.has('filmes');
}

/** Caminho de um `URL` ou de uma string (URL absoluta ou caminho solto). */
function pathnameOf(href: URL | string): string {
  if (typeof href !== 'string') return href.pathname;
  try { return new URL(href).pathname; } catch { return href; }
}

/**
 * IMDb da obra. O `tt` precisa estar ANCORADO no rótulo "IMDb" da ficha, e não
 * ser único na página: a âncora é o que separa a ficha de um widget de post
 * alheio colado no fim da página (a armadilha medida no ComandoTorrents, onde o
 * `tt` era de obra ALEATÓRIA). Aqui o widget não existe — o `?ref_=tt_plg_rt` é
 * do plugin de nota da própria ficha, e por isso ele NÃO é filtrado; a âncora é
 * que prova que o link é o da obra. `null` (dois `tt` na ficha, nenhum, ou um
 * `tt` fora da ficha) devolve a identificação para título+ano, que é o estado
 * honesto: obra errada é pior que obra nenhuma.
 */
export function parseImdbId(html: string): string | null {
  const source = String(html || '');
  const found = new Set<string>();
  for (const match of source.matchAll(IMDB_TITLE_RE)) {
    const antes = source.slice(0, match.index);
    const rotulos = [...antes.matchAll(IMDB_LABEL_RE)];
    const ultimo = rotulos[rotulos.length - 1];
    if (ultimo && match.index - (ultimo.index ?? 0) <= IMDB_LABEL_WINDOW) found.add(match[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Título original que a post declara. Delega ao helper COMPARTILHADO depois de
 * normalizar a marcação: o site publica `<strong><em>Título Original:</em>
 * </strong>` (5 de 12 posts medidos) e a regex da ficha conhece `b|strong|span`,
 * não `<em>` — sem a normalização ela devolve `":"`, que é lixo de markup virado
 * nome de obra. Tirar a tag é o único ajuste; toda a limpeza (entidade, dois
 * nomes, rótulo colado, teto) continua sendo do helper.
 */
export function parseOriginalTitle(html: string): string | null {
  return parseSharedOriginalTitle(String(html || '').replace(/<\/?em>/gi, ''));
}

/**
 * Nome da obra e ano a partir do `<h1>`. Aqui a régua COMPARTILHADA
 * (`work-name.ts`) serve inteira: o `<h1>` deste site TERMINA no ano entre
 * parênteses, que é a forma do ComandoTorrents, mesmo tema de filmes. A régua
 * PRÓPRIA do TorrentDosFilmes (ano no MEIO) não é copiada — duas cópias
 * divergiriam em silêncio.
 */
export function workTitleYear(html: string): WorkTitle {
  return readWorkTitle(html);
}
