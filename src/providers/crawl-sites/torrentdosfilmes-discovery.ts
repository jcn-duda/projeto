// Regras PURAS do TorrentDosFilmes para o motor de raspagem: o que é página de
// obra, o que é página de TEMPORADA, como o Yoast escreve loc/lastmod e — o
// ponto que não tem equivalente nos outros dois sites — COMO SE LÊ O NOME DA
// OBRA no `<h1>` deste site. Nada aqui faz rede nem conhece o resolver.
//
// Tudo neste arquivo vem de MEDIÇÃO no site (2026-09-28, 11 requisições
// sequenciais em `torrentdosfilmes-v2.xyz`, fetch direto sem FlareSolverr — o
// tdf responde 200 sem desafio), e não de palpite:
//
//   - SITEMAP: Yoast, canônico em `/sitemap_index.xml` (200, 45 entradas: 27
//     `post-sitemap*.xml`, 2 `category-sitemap*` e 16 `post_tag-sitemap*`).
//     `/sitemap.xml` e `/wp-sitemap.xml` dão 301 para o canônico, e o
//     `robots.txt` declara o canônico. SEM CDATA (ao contrário do AIOSEO do
//     NerdFilmes) — o parser aceita os dois formatos porque o do site pode
//     mudar com a troca do plugin de SEO.
//   - URL DE OBRA: slug de UM segmento com barra final. O `post-sitemap.xml`
//     tem 1.001 entradas e a PRIMEIRA É A HOME `/` — o índice de obra do site
//     inclui a página inicial, então a regra do caminho é o que a recusa.
//     Os blocos trazem `image:image`/`image:loc` (capa e botão): o `<loc>` da
//     PÁGINA é o primeiro do bloco e o `image:loc` não é obra.
//   - TIPO POR SLUG: o `post-sitemap` é misto e não traz tipo. 118 dos 1.000
//     slugs de obra (11,8%) têm "temporada" no slug, e o post é PACK DE
//     TEMPORADA (medido: `dn=O_Caçador.S01Complete`), não episódios.
//   - IMDB: NÃO SE LÊ. Este site não publica ficha técnica; o que publica é um
//     plugin de RECOMENDAÇÃO (`<span data-title="tt0340163" data-user="…">`)
//     cujo link do IMDb é de obra aleatória: na página de "Como Viajar com o
//     Mala do seu Pai (2008)" o único `imdb.com/title/` é `tt1959490`
//     ("Referência (2005)"), confirmado pelo `alt` da imagem. A regra de
//     unicidade do NerdFilmes (um tt só = o da obra) cairia nesse widget e
//     gravaria a obra ERRADA no acervo. Aqui `imdb` é sempre `null` e a
//     identificação é por título+ano (o caminho real deste site).
//   - `<h1>`: o ANO VAI NO MEIO do título, não no fim como nos outros dois
//     sites ("Exterminador As Crônicas de Sarah Connor 1ª Temporada Bluray
//     720p (2008) Dublado"), e o nome vem antes de um bloco de vitrina
//     (fonte, qualidade, áudio, canais, "Torrent", "GDRIVE"). O
//     `parseTitleYear` compartilhado em `shared.ts` só aceita parêntese FINAL,
//     então devolve `year: null` aqui e TODA página cairia em `pagina-sem-ano`
//     — que é justamente a condição que impede a identificação de consultar o
//     TMDB. Por isso a régua do nome é PRÓPRIA deste site, e é medida: ver
//     `workTitleYear` e os cinco `<h1>` reais que ele fixa.
import type { CrawlPageKind } from '../crawl-types.js';
import { decodeEntities } from '../../utils/title-normalization.js';

/**
 * Índice de sitemaps. O canônico primeiro (é o que o `robots.txt` declara e o
 * único que respondeu 200); o nome Yoast fica como reserva, e ele não é
 * inofensivo — é 301 para o canônico, que o laço de redirects segue com
 * allowlist por hop e devolve o mesmo XML. Se um dia os dois 404arem, a
 * descoberta é erro do site e o motor retenta.
 */
export const SITEMAP_INDEX_PATHS = ['sitemap_index.xml', 'sitemap.xml'];
/** Sitemaps de OBRA: `post-sitemap.xml`, `post-sitemap2.xml`… (Yoast). */
const POST_SITEMAP_RE = /\/post-sitemap\d*\.xml$/i;
/** Bloco `<url>…</url>` do Yoast (o `image:loc` fica de fora: `<loc>` da
 *  PÁGINA é o primeiro do bloco, e `<image:loc>` não casa `<loc>`). */
const URL_BLOCK_RE = /<url>[\s\S]*?<\/url>/gi;
const SITEMAP_BLOCK_RE = /<sitemap>[\s\S]*?<\/sitemap>/gi;
/** `<loc>`/`<lastmod>` com CDATA (AIOSEO) ou sem (Yoast): o site troca de
 *  plugin de SEO sem aviso, e o parser não pode quebrar no dia da troca. */
const SITEMAP_LOC_RE = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i;
const SITEMAP_LASTMOD_RE = /<lastmod>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/lastmod>/i;
/** Obra: UM segmento com barra final, sem extensão. `/` (a home, que o índice
 *  do site inclui) NÃO casa — é o que a regra recusa. */
const WORK_PATH_RE = /^\/[^/]+\/$/;
const NOT_WORK_SEGMENTS = new Set([
  'link.php', 'feed', 'wp-json', 'wp-admin', 'robots.txt', 'sitemap_index.xml', 'sitemap.xml',
]);

/**
 * Sinais de TEMPORADA no slug. A MEDIÇÃO diz que a página de temporada deste
 * site é PACK (o `dn=` do magnet é `…S01Complete`), e que 11,8% do acervo é
 * temporada — a mesma proporção do NerdFilmes (13 de 40). A palavra cobre as
 * formas todas do acervo real: `1a-temporada`, `2a-temporada`, `15a-temporada`
 * (os ordinais de "Os Simpsons"), `temporada-completa-mini-serie` e o plural.
 *
 * Falso positivo aceito e DE PROPÓSITO, com a mesma direção do NerdFilmes: um
 * filme cujo slug traga "temporada" sai como `tv_show` e, com séries desligadas,
 * deixa de ser enfileirado. O erro é "obra faltando" (visível no painel),
 * nunca "obra errada gravada" — e a linha que chegar como `movie` é recusada
 * na porta do `fetchWork`.
 */
const SEASON_SLUG_RE = /temporada/i;

/** Pares loc/lastmod de um sitemap de obra, bloco a bloco. */
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
 * Locs de `post-sitemap*` do índice. `category-sitemap*` e `post_tag-sitemap*`
 * saem aqui pelo NOME do arquivo (18 das 45 entradas do índice real) e o host
 * alheio sai pelo allowlist do site — o loc do índice é INPUT do site, então
 * host de fora nunca é nem consultado.
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

/** O caminho É de página de obra (a home `/` e `feed`/`wp-json` não são). */
export function isWorkPath(href: URL): boolean {
  if (!WORK_PATH_RE.test(href.pathname)) return false;
  return !NOT_WORK_SEGMENTS.has(decodeURIComponent(href.pathname.slice(1, -1)).toLowerCase());
}

/** Loc de post → URL de obra, ou `null` se não for página do site. */
export function toWorkUrl(loc: string, base: string, isDetailHost: (h: string | null) => boolean): URL | null {
  let href: URL;
  try { href = new URL(loc, base); } catch { return null; }
  return isWorkPath(href) && isDetailHost(href.hostname) ? href : null;
}

/**
 * Tipo da página pelo slug — a única fonte disponível: o `post-sitemap` é único
 * e não traz tipo, e o `<h1>` só é lido DEPOIS, na fila.
 */
export function kindFromSlug(href: URL | string): CrawlPageKind {
  return isSeasonSlug(href) ? 'tv_show' : 'movie';
}

/** `true` quando o slug é de página de temporada (pack). */
export function isSeasonSlug(href: URL | string): boolean {
  let pathname: string;
  try {
    pathname = typeof href === 'string' ? new URL(href).pathname : href.pathname;
  } catch {
    return false;
  }
  return SEASON_SLUG_RE.test(decodeURIComponent(pathname));
}

// --- O nome da obra no `<h1>` deste site ------------------------------------

/** Ano em parênteses, em qualquer posição do título. */
const YEAR_PAREN_RE = /[（(]\s*((?:19|20)\d{2})\s*[)）]/;
/** Ruído de VITRINA que o theme gruda no título, na ordem em que aparece.
 *  Cada entrada existe porque está no acervo real medido (a lista de tokens do
 *  slug dá a frequência: `torrent` 435, `bluray` 351, `download` 338, `720p`
 *  304, `dublado` 271, `1080p` 258, `dual`+`audio` 214, `legendado` 119…).
 *  NADA aqui é removido do título da RELEASE — o `releaseTitle` do profile
 *  limpa o que é vitrine; aqui a régua é o NOME da obra. */
const NOISE_RES: readonly RegExp[] = [
  // 1. Temporada: é estrutura de release, não nome de obra. Tira o ordinal e a
  //    palavra ("1ª Temporada Completa Mini Série" → "O Caçador"), para que a
  //    página de PACK ainda identifique a SÉRIE no TMDB — é o que a sonda de
  //    série mede.
  /\b\d{0,2}\s*[ªºa]?\s*temporadas?(?:\s+(?:complet[ao]s?|inteiras?))?/gi,
  /\bmini\s*s[ée]ries?\b/gi,
  // 2. Fonte e codec. "3D" e "HSBS" NÃO entram: "Sea Rex 3D: Journey to a
  //    Prehistoric World" só casa no TMDB com o 3D no nome. `rip` em minúscula
  //    também não: no `<h1>` ele só aparece dentro de "WebRip"/"BRRip", que a
  //    regra já pega — e é por isso que `Rip` MAIÚSCULO é regra separada (abaixo).
  /\b(?:blu[\s-]?ray|bd[\s-]?rip|br[\s-]?rip|web[\s-]?dl|web[\s-]?rip|dvd[\s-]?rip|dvd[\s-]?scr|webcam|hdtv|hd[\s-]?ts|cam[\s-]?rip|remux)\b/gi,
  // 3. Canais de áudio ("5.1", "5.1CH", "6ch", "2.0") e marcas de faixa.
  /\b\d[\s.,]?\d?\s*(?:ch|canais?)\b/gi,
  /\b(?:5\.1|7\.1|7\.2|2\.0|ddp|atmos)\b/gi,
  // 4. Áudio e idioma. `Dual` sozinho e `Nacional` são rótulo do arquivo, não
  //    nome de obra. `original` NÃO entra (sozinho ele é nome: "Original Sin"),
  //    e o `áudio original` cai no `áudio` logo abaixo. A borda é ESPAÇO/PONTUAÇÃO
  //    explícita, e não `\b`: em JavaScript `\b` é definido por `[A-Za-z0-9_]`, e
  //    acento não é caractere de palavra — `\b[aá]udio` nunca casaria em
  //    "Dual Áudio" (borda espaço/letra acentuada não é transição), que é
  //    exatamente a forma que o site publica.
  /(?:^|[-\s([/|—–])(?:dublad[oa]s?|legendad[oa]s?|dual|multi\s*[aá]udio|[aá]udio|legenda|embutida|nacional)(?=$|[-)\s\]/|—–.,;:!])/gi,
  // 5. Vitrine: o que o site oferece, não o que a obra é. Só as formas do
  //    acervo medido — `mirrors`/`links` saem de propósito ("Mirrors" é filme).
  /\b(?:torrents?|download|baixar|gr[aá]tis|online|assistir|completo|completa|mega|gdrive)\b/gi,
  // 6. Qualidade e container soltos ("1080p", "4K", "FULL HD", "HD").
  /\b(?:full\s*hd|ultra\s*hd|\d{3,4}\s*[pi]|\b4k\b|\b8k\b|\bhd\b|\bsd\b)\b/gi,
];
/**
 * Ruído que o site publica em CAIXA ALTA e que também é palavra de nome: vai
 * numa lista separada, SEM a flag `i`, porque é exatamente a caixa que
 * denuncia a vitrine. Medido em 2026-09-28 na sonda de 40 (cada entrada
 * citando o `<h1>` real que vazava e ia para `no-work`):
 *
 *   "Deadpool Torrent – Bluray Rip 720p | 1080p Legendado Download (2016)"
 *   "Contra o Tempo Torrent – BluRay Rip 720p e 1080p Dual Áudio 5.1 (2011)"
 *   "Arábia Torrent (2018) Nacional WEB-DL 1080p FULL Download"
 *
 * `Rip` e `FULL` saem; "Mirrors" e "Full Metal Jacket" (com a caixa do nome)
 * continuam de pé, que é o motivo de esta lista não usar `\b`-insensível.
 */
const NOISE_CAPS_RES: readonly RegExp[] = [/\bRip\b/g, /\bFULL\b/g];
/**
 * Conector órfão no FIM do nome: o site escreve "… 720p e 1080p" e "Dublado e
 * Legendado", e as regras de qualidade/áudio apagam os dois vizinhos, deixando
 * o "e" grudado no nome ("Introspectum Motel e", "Contra o Tempo e"). Só o
 * "e" FINAL sai: um nome português que termine na conjunção "e" não existe, e
 * "Deuses e Monstros" (o "e" no meio) nunca é tocado.
 */
const TRAILING_CONNECTOR_RE = /\s+e$/i;
/**
 * Separador órfão que sobra da limpeza. O `+` no grupo de repetição era um
 * erro: exigia DOIS separadores seguidos, e a forma DOMINANTE do site é o
 * separador ÚNICO cercado de espaço ("… – Bluray", "5.1 / Dublado", "… –"),
 * que ficava no nome ("Deadpool – Rip", "Noturno / FULL"). O `:` fica DE
 * FORA de propósito: ele é separador de NOME ("Sea Rex 3D: Journey to a
 * Prehistoric World", "Chainsaw Man – O Filme: Arco da Reze"), e a régua não
 * tem nenhum ganho medido em removê-lo. A classe põe o hífen PRIMEIRO de
 * propósito: `–-` seria intervalo de caractere invertido e a regex nem compila.
 */
const ORPHAN_SEP_RE = /\s*[-–—/|&+]\s*(?:[-–—/|&+]\s*)*/g;
const EDGE_SEP_RE = /^[–\-—/|:&+\s]+|[–\-—/|:&+\s]+$/g;

/** O que o `<h1>` diz, já decodificado e colapsado. */
function h1Text(html: string): string {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ?? '';
  return decodeEntities(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Resultado da leitura do `<h1>`: o NOME da obra, o ano e o texto cru. */
export interface WorkTitle {
  title: string;
  year: number | null;
  /** Texto do `<h1>` como o site publica — é o que o `releaseTitle` do profile
   *  limpa para o título da release, e precisa ser o CRU para sair igual ao card
   *  vivo (uma segunda limpeza aqui produziria uma terceira régua). */
  raw: string;
}

/**
 * Nome da obra e ano a partir do `<h1>` do post. O ano sai do PRIMEIRO
 * parênteses de 4 dígitos (o site o põe no meio: "… 1ª Temporada Bluray 720p
 * (2008) Dublado"), e o resto do título é o nome com o ruído de vitrine fora.
 *
 * O ano SÓ é aceito entre parênteses, e é decisão: um ano solto no slug/título
 * seria indistinguível do número que faz parte do nome ("Blade Runner 2049",
 * "O Caçador 2"). Parêntese é declaração do site, não dígito solto — e página sem
 * ano declarado é `pagina-sem-ano` na identificação, que é o estado honesto
 * (sem ano não há com que discriminar homônimo de qualquer época).
 *
 * Em caso de dúvida a régua erra para o lado de NÃO achar nome: título demais
 * que sobrou vira `nome-sem-casamento` no TMDB (a URL aparece como `no-work` no
 * painel) e nunca obra errada gravada.
 */
export function workTitleYear(html: string): WorkTitle {
  const raw = h1Text(html);
  const yearMatch = YEAR_PAREN_RE.exec(raw);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  let title = raw;
  if (yearMatch) title = `${title.slice(0, yearMatch.index)} ${title.slice(yearMatch.index + yearMatch[0].length)}`;
  for (const re of NOISE_RES) title = title.replace(re, ' ');
  for (const re of NOISE_CAPS_RES) title = title.replace(re, ' ');
  // O colapso de espaço vem ANTES das regras de borda: a limpeza deixa cauda de
  // espaços ("Contra o Tempo e   "), e `\s+e$` não casaria com "e" seguido de
  // espaço. Depois das bordas, colapsa de novo (o `trim` do conector abre espaço).
  title = title.replace(ORPHAN_SEP_RE, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(TRAILING_CONNECTOR_RE, '').trim().replace(EDGE_SEP_RE, '').replace(/\s+/g, ' ').trim();
  return { title, year, raw };
}
