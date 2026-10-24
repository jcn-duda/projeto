// Regras PURAS do Apache Torrents (apachetorrents.com) para o motor de
// raspagem. Separadas de `apachetorrent.ts` porque são o que o teste fixa sem
// rede: o que é página de obra, o que o card declara, que tipo o POST declara,
// qual `tt` é o da obra, qual é o título original e qual o tamanho.
//
// ## O site
//
// Não é WordPress: é um catálogo PHP próprio, que só divide com o HDRTorrent
// o tema (mesmo `capa-item`, mesma ficha). O card traz o marcador de TIPO POR
// EXTENSO no texto ("(Filme de 2019)", "(Série de 2026)", "(Desenho de
// 2026)", "(Música de 1961)"), a listagem é `/pagina/N/` e o post é
// `https://apachetorrents.com/<slug>-baixar-torrent/` na RAIZ. O slug de
// temporada é `-1a-temporada`, `-3-temporada`, `-4a-temporada` (com sufixos
// livres depois: "-legendada", "-completa").
//
// ## O card da listagem (medido em 2026-09-29, página 1 real)
//
// ```html
// <div class="capa-item">
//   <a href="https://apachetorrents.com/as-rainhas-da-torcida-baixar-torrent/"
//      title="As Rainhas da Torcida Torrent Dublado / Dual Áudio Download"
//      aria-label="As Rainhas da Torcida Torrent Dublado / Dual Áudio — Baixar Torrent (2019)">
//     <img ...>
//   </a>
//   <h2 class="capa-titulo">
//     <a href="https://apachetorrents.com/as-rainhas-da-torcida-baixar-torrent/"
//        title="As Rainhas da Torcida Torrent Dublado / Dual Áudio">
//       As Rainhas da Torcida Torrent Dublado / Dual Áudio <br/>(Filme de 2019)  </a>
//   </h2>
// </div>
// ```
//
// Três coisas do formato medido que a regra abaixo obedece:
//
// 1. **O MESMO post aparece 2× no card** (link da capa + link do título), com
//    href IDÊNTICO. Varrendo `<a href>` sem dedupe, a página de 20 cards
//    devolveria 40 e o `walkListing` contaria 40 numa página cheia de 20 —
//    nenhuma página do acervo passaria a ser reconhecida como "calcanhar".
// 2. **Os href são ABSOLUTOS** (medido hoje; o plano antigo dizia relativos).
//    `new URL(href, base)` cobre as duas formas sem bifurcação.
// 3. **O tipo só aparece no texto do `<h2>`** (o atributo `title` do link do
//    título não o traz, e o `aria-label` da capa traz só o ano). Se o `<h2>`
//    faltar, o tipo não é declarado — e aí quem decide é o slug.
//
// ## `Desenho` é AMBÍGUO, e o slug desempata (medido)
//
// O tipo `Desenho` cobre série de desenho E desenho que é filme, então ele não
// decide sozinho. Medido na taxonomia `/desenhos/` (20 cards reais): 16 com
// temporada no slug e 4 sem — o pack da série inteira ("Bom-Bom e Mau-Mau -
// Completa"), um long ("O Surfista Prateado (Série de TV)"), "Mulher-Aranha" e
// "O Rastro do Ouro". Ou seja: 16/20 o slug acerta, e os 4 restantes são o
// ambíguo que nenhuma marcação do card resolve. O `ItemList` de
// `application/ld+json` que a página publica CONFLITA com o card em NENHUM dos
// 20 cards da página 1 capturada (11 `Movie` + 9 `TVSeries`, e os 9 `TVSeries`
// são exatamente os 7 `(Série de …)` + os 2 `(Desenho de …)` com temporada) — o
// card mais o slug chegam no mesmo veredito, e é o card+slug que a lista usa.
// A suíte prende esse acordo card a card (`crawl-apachetorrent.test.ts`).
//
// ## `(Música de 1961)` NÃO é obra — o card é pulado
//
// O site publica o mesmo card para material que não é vídeo (medido: 1 em 120
// cards de 6 páginas reais, "Bob Dylan - Discografia (Música de 1961)"). Sem o
// corte, o card entraria como `movie`, gastaria uma requisição de post no
// crawler e voltaria `no-work`. O corte é pela MARCAÇÃO do site — o tipo
// declarado que não é da lista de obras do próprio site. Ele não pode zerar o
// acervo em silêncio: página em que NENHUM card é reconhecido vira
// `listing-pagina-N:nenhum-card` (`listing-discover.ts`), que é falha visível,
// não lista vazia.
import { decodeEntities } from '../../utils/title-normalization.js';
import type { CrawlPageKind } from '../crawl-types.js';
import { isImdbWidgetReference } from './shared.js';

/** Card de obra reconhecido na listagem, já deduplicado e com tipo decidido. */
export interface ApacheListingCard {
  url: string;
  kind: CrawlPageKind;
}

/**
 * Slug de PÁGINA DE OBRA: `/<slug>-baixar-torrent/`, um segmento só.
 *
 * O sufixo é o discriminador, e ele é estável: as rotas de navegação que o
 * próprio site publica no rodapé e na taxonomia (`/lancamentos/`, `/filmes/`,
 * `/series/`, `/desenhos/`, `/genero/<x>/`, `/qualidade/<x>/`, `/pagina/N/`,
 * `/login.php`) nenhuma terminam assim. Sem uma lista de exclusão — que
 * envelheceria a cada rota nova —, o sufixo é o que separa post de navegação.
 */
const WORK_SLUG_RE = /^\/[^/?#]+-baixar-torrent\/$/i;

/** Temporada no slug: `-1a-temporada`, `-3-temporada`, `-14a-temporada`. */
const SEASON_SLUG_RE = /-\d{1,2}a?-temporada/i;

/**
 * Tipo declarado no card e no `item-lead` do post. O vocabulário é o do
 * próprio site (medido): `Filme`, `Série`, `Desenho` e — fora das obras — o
 * `Música` que manda o card para fora. `Documentário`/`Anime` entram na lista
 * porque o `yearMatch` do próprio profile (`apachetorrent-parsers.ts`) já os
 * enumera como variantes de obra; não foram vistos num card, e por isso não
 * têm regra própria.
 */
const WORK_TYPE_RE = /^\s*(?:Filme|S[ée]rie|Desenho|Document[áa]rio|Anime)\s*$/i;
/**
 * O que o card declara e o acervo NÃO tem. Só isto pula o card: o mesmo molde
 * "(X de AAAA)" aparece no NOME da obra — "Além da Imaginação - 2ª Temporada
 * (Clássica de 1960)" era pulado como se "Clássica" fosse tipo (2026-10-01).
 */
const NON_WORK_TYPE_RE = /^\s*(?:M[úu]sicas?|Jogos?|Games?|Programas?|Softwares?|Apps?|Aplicativos?|Livros?|Cursos?)\s*$/i;
/** O marcador por extenso do CARD, com o ANO do acervo entre parênteses:
 *  "(Filme de 2019)". */
const CARD_TYPE_RE = /\(\s*([^()]{2,20}?)\s+de\s+(?:19|20)\d{2}\s*\)/i;
/**
 * O marcador do POST no `item-lead`, SEM parênteses: "… Download Torrent Filme
 * de 2019 com qualidade …" (medido nos 4 posts reais). São duas formas porque
 * são dois lugares do site, e uma régua só erraria um deles.
 */
const LEAD_TYPE_RE = /\b(Filme|S[ée]rie|Desenho|Document[áa]rio|Anime)\s+de\s+(?:19|20)\d{2}\b/i;

/**
 * Markup limpo de comentário, `<script>` e `<style>` antes das regras.
 *
 * Não é capricho: o COMENTÁRIO de um recorte de fixture — e o comentário de
 * qualquer página do site — pode citar marcação (`<div class="infos">`) e
 * vira um alvo falso para toda regra que casa tag. `h1Text` de `work-name.ts`
 * faz a mesma normalização pelo mesmo motivo.
 */
function markupOf(html: string): string {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/** O caminho é de PÁGINA DE OBRA (`/<slug>-baixar-torrent/`). */
export function isWorkPath(href: URL | string): boolean {
  let path: string;
  if (typeof href === 'string') {
    try { path = new URL(href).pathname; } catch { path = href.split('?')[0].split('#')[0]; }
  } else {
    path = href.pathname;
  }
  return WORK_SLUG_RE.test(path);
}

/**
 * O slug declara TEMPORADA. É a coerência de tipo entre a fila e a página no
 * caminho que dá pra decidir ANTES de qualquer rede: grava pack de temporada
 * como filme é obra que não existe no catálogo.
 */
export function isSeasonSlug(url: URL | string | null | undefined): boolean {
  if (!url) return false;
  const path = typeof url === 'string'
    ? (() => { try { return new URL(url).pathname; } catch { return url; } })()
    : url.pathname;
  return SEASON_SLUG_RE.test(path);
}

/** Tipo pelo SLUG, para quando o card declara `Desenho` (ambíguo) ou nada. */
export function kindFromWorkSlug(url: URL | string | null | undefined): CrawlPageKind {
  return isSeasonSlug(url) ? 'tv_show' : 'movie';
}

/** Texto do card (o `<h2>` quando existe, senão os atributos de texto). */
function cardText(chunk: string): string {
  const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(chunk)?.[1];
  if (h2) return decodeEntities(h2.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const attrs = [...chunk.matchAll(/\b(?:aria-label|title)=["']([^"']*)["']/gi)]
    .map((m) => decodeEntities(m[1]))
    .join(' ');
  return attrs.replace(/\s+/g, ' ').trim();
}

/** Tipo que o CARD declara entre parênteses, ou `null` quando não declara. */
function declaredType(text: string): string | null {
  // O ÚLTIMO marcador: o do tipo fecha o card; um anterior é parte do nome.
  const all = [...text.matchAll(new RegExp(CARD_TYPE_RE.source, 'gi'))];
  return all.length ? all[all.length - 1][1].trim() : null;
}

/** Cards brutos da página (blocos `capa-item`), antes de qualquer filtro. */
export function countListingCards(html: string): number {
  return markupOf(html).split(/<div class=["']capa-item["']>/i).length - 1;
}

/**
 * Cards de obra de uma página de listagem, na ordem do site, JÁ deduplicados
 * e com o tipo decidido.
 *
 * O tipo vem do CARD (quem lê o card é o site) e o slug só desempata o
 * `Desenho`, que é ambíguo por definição. Card que declara tipo FORA das
 * obras do site (o `Música` medido) é PULADO — ver o cabeçalho. Link que não
 * resolve para página de obra é pulado pelo mesmo motivo: a taxonomia e a
 * paginação vivem na mesma página.
 */
export function parseListingCards(html: string, baseUrl: string): ApacheListingCard[] {
  const out: ApacheListingCard[] = [];
  const seen = new Set<string>();
  const chunks = markupOf(html).split(/<div class=["']capa-item["']>/i).slice(1);
  for (const chunk of chunks) {
    const text = cardText(chunk);
    const declared = declaredType(text);
    if (declared != null && NON_WORK_TYPE_RE.test(declared)) continue;
    const hrefs = [...chunk.matchAll(/<a\b[^>]*?\bhref=["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const href of hrefs) {
      let resolved: string;
      try { resolved = new URL(decodeEntities(href), baseUrl).href; } catch { continue; }
      // Dedupe: o mesmo post entra no card DUAS vezes (capa + título).
      if (seen.has(resolved)) continue;
      if (!isWorkPath(resolved)) continue;
      seen.add(resolved);
      const kind: CrawlPageKind = /^\s*filme\s*$/i.test(declared ?? '')
        ? 'movie'
        : /^\s*s[ée]rie\s*$/i.test(declared ?? '')
          ? 'tv_show'
          : kindFromWorkSlug(resolved);
      out.push({ url: resolved, kind });
    }
  }
  return out;
}

/**
 * Tipo que o POST declara no `<p class="item-lead">` ("… Download Torrent
 * Filme de 2019 com qualidade …", medido nos 4 posts reais capturados: 1
 * filme, 1 série e 2 desenhos). `null` quando o tipo é ambíguo (`Desenho`) ou
 * ausente — e aí quem decide é o slug.
 *
 * É a metade SIMÉTRICA da coerência de tipo: a URL sozinha prova que a página
 * é de temporada (o slug), mas NÃO prova que uma página sem temporada é de
 * filme — 2 de 120 cards de 6 páginas reais declaram `(Série de …)` sem
 * temporada no slug ("Avante - Nos Bastidores de X-Men 97 - Legendada", "Os
 * Filhos da Guerra"). Por isso a recusa de `filme_com_kind_tv_show` só pode
 * sair DEPOIS da leitura do post (ver `apachetorrent.ts`).
 */
export function pageKindOf(html: string): CrawlPageKind | null {
  const lead = /<p[^>]*class=["'][^"']*item-lead[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    .exec(markupOf(html))?.[1] ?? '';
  const declared = LEAD_TYPE_RE.exec(decodeEntities(lead.replace(/<[^>]+>/g, ' ')))?.[1] ?? null;
  if (declared == null || !WORK_TYPE_RE.test(declared)) return null;
  if (/^\s*filme\s*$/i.test(declared)) return 'movie';
  if (/^\s*s[ée]rie\s*$/i.test(declared)) return 'tv_show';
  return null;
}

/** `imdb.com/title/tt…` e `imdb.com/pt/title/tt…` (medido: o site usa as duas). */
const IMDB_TITLE_RE = /(?:https?:)?\/\/(?:www\.|m\.)?imdb\.com\/(?:[a-z]{2}\/)?title\/(tt\d{5,})([^"'\s<>]*)/gi;

/**
 * IMDb da obra: um `tt` único na página é o da obra; dois ou nenhum é
 * ambíguo (widget) e a identificação cai para título+ano. NUNCA "o primeiro
 * `tt` da página" — o `ref_=tt_` do WordPress aponta para obra alheia.
 *
 * Mesma régua do `hdrtorrents-discovery.ts` e dos outros sites, e a MESMA
 * justificativa para ela continuar por site: o `html` que chega aqui é o do
 * Apache (com o `ItemList` de `ld+json` que traz `url`, `image` e `genre`, e
 * não `tt`) e a folha de recorte é da lista. Medido nos 3 posts com IMDb
 * ("As Rainhas da Torcida" → tt5125894, "Detetive Chinatown" → tt34463310 via
 * `/pt/title/` e "Presidente Curtis" → tt37692332); o post de série sem IMDb
 * devolve `null`, que é o comportamento honesto.
 */
export function parseImdbId(html: string): string | null {
  const found = new Set(
    [...markupOf(html).matchAll(IMDB_TITLE_RE)]
      .filter((m) => !isImdbWidgetReference(m[2] ?? ''))
      .map((m) => m[1]),
  );
  return found.size === 1 ? [...found][0] : null;
}

/**
 * O bloco da ficha do post. A ficha é o `<div class="infos">` e o conteúdo
 * dela é UM `<p>` só (medido nos 4 posts reais), então o fim é o primeiro
 * `</p>` depois da abertura — sem ele, o corte seria ambíguo num HTML que
 * tem meia dúzia de `</div>` na mesma linha.
 */
function fichaOf(html: string): string {
  // A classe tem que TERMINAR em `infos`: o primeiro `<strong>` da ficha mora
  // num `span` de classe `infos-titulo`, e um `\b` solto deixaria essa classe
  // entrar como se fosse a ficha.
  return /<div[^>]*class=["'][^"']*\binfos["'][^>]*>([\s\S]*?)<\/p>/i
    .exec(markupOf(html))?.[1] ?? '';
}

/** Ficha `<strong>Rótulo</strong>: valor` — o formato que `work-name.ts` lê. */
const FICHA_FIELD_RE = /<strong>\s*([^<]{1,40}?)\s*<\/strong>\s*:\s*([^<]*)/gi;

/**
 * Título ORIGINAL que a ficha publica, e a diferença para o
 * `parseOriginalTitle` COMPARTILHADO de `shared.ts` (que é a régua dos
 * WordPress).
 *
 * O Apache não rotula o campo: o original é o PRIMEIRO `<strong>` da ficha, o
 * único sem `:` depois (medido nos 4 posts reais: `<strong>Poms</strong>`,
 * `<strong>Lanterns S01</strong>`, `<strong>President Curtis S01</strong>`,
 * e um título em CJK). O helper compartilhado reconhece o `movie-original` do
 * NerdFilmes e o `Título Original:` rotulado dos outros WordPress — nenhum dos
 * dois existe aqui, então ele devolveria `null` e o 2º nome da identificação
 * ia embora.
 *
 * O `S01`/`S02` colado no final é o CÓDIGO DA TEMPORADA da ficha ("Lanterns
 * S01"), não parte do nome: o `original_title` do catálogo é "Lanterns", e
 * "Lanterns S01" não casaria com ele pela régua estrita — pior, nem entraria
 * no desempate de homônimo que o original resolve.
 */
export function fichaOriginalTitle(html: string): string | null {
  const ficha = fichaOf(html);
  if (!ficha) return null;
  for (const match of ficha.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)) {
    if (/<strong>\s*[^<]{1,40}?\s*<\/strong>\s*:/i.test(match[0])) continue;
    const value = decodeEntities(match[1].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*S\d{1,2}$/i, '')
      .trim();
    if (value) return value;
  }
  return null;
}

/**
 * Tamanho por POST, na ficha (`<strong>Tamanho</strong>: 1.78 GB`, medido em
 * 3 dos 4 posts — o de desenho não publica). `null` quando não publica, e
 * nunca 0: o filtro de tamanho leria 0 como torrent de tamanho zero.
 *
 * Isto é uma divergência do "fonte BR não publica tamanho por botão" que vale
 * para os OUTROS sites: aqui o botão não traz, mas a ficha traz UM por post,
 * que é o mesmo número para todas as linhas. O que o site não faz é mentir
 * por botão, e por isso o valor entra por POST, no mesmo lugar onde o resto do
 * adaptador escreve as releases.
 */
export function fichaSizeBytes(html: string): number | null {
  for (const match of fichaOf(html).matchAll(FICHA_FIELD_RE)) {
    if (!/^\s*tamanho\s*$/i.test(match[1])) continue;
    const parsed = parseSizeText(match[2]);
    if (parsed != null) return parsed;
  }
  return null;
}

/** "1.78 GB" / "2,72 GB" → bytes. */
function parseSizeText(text: string | null | undefined): number | null {
  const match = String(text || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[
    match[2].toUpperCase() as 'KB' | 'MB' | 'GB' | 'TB'
  ];
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}
