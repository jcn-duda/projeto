// Regras PURAS do HDRTorrent (hdrtorrents.net) para o motor de raspagem.
// Separadas de `hdrtorrents.ts` pela catraca de linhas e porque são o que o
// teste fixa sem rede: o que é página de obra, que tipo o card declara, como
// a ficha `<dt>/<dd>` vira texto e qual `tt` é o da obra.
//
// ## O site
//
// WordPress com listagem paginada em `/pagina/N/` e SEM sitemap utilizável.
// O post é `https://hdrtorrents.net/<slug>/` na RAIZ (sem `/filmes/` nem
// `/series/` como prefixo), o card traz `meta[itemprop=datePublished]` com o
// ANO DA OBRA e `badge-tipo`/`badge-qualidade`, e os magnets são diretos em
// `.download-row`.
//
// ## Slug: a única forma estável de reconhecer obra
//
// Medido em 2026-09-29 em 156 cards únicos de 8 páginas reais: **156 de 156**
// terminam em `-torrent-download/`. E as rotas de taxonomia do site —
// `/filmes/`, `/series/`, `/desenhos/`, `/lancamentos/` (medido, todas as de 1
// segmento) — não terminam assim. É o que separa "post" de "página de
// navegação" sem lista de exclusão que envelheceria a cada rota nova.
const WORK_SLUG_RE = /^\/[a-z0-9][a-z0-9-]*-torrent-download\/$/i;

/** Temporada no slug: `-14a-temporada`, `-3-temporada`, `-1-temporada-`. */
const SEASON_SLUG_RE = /-\d{1,2}a?-temporada/i;

/** `card.type` do profile → kind do motor. `null` quando o site não declara:
 *  aí o chamador decide (medido: 0 cards sem badge em 8 páginas). */
export function kindFromCardType(type: string | null | undefined): 'movie' | 'tv_show' | null {
  const text = String(type || '').toLowerCase();
  if (!text) return null;
  // "Desenho" é o tipo do card de ANIMAÇÃO, e o site usa o mesmo badge para
  // série de desenho ("Invencível", "Star Wars: The Bad Batch") e para o
  // desenho que é um filme. Medido em 8 páginas: 4 cards `Desenhos` com
  // temporada no slug, 0 sem — o slug desempata, e é ele que vale.
  if (/s[ée]rie/.test(text)) return 'tv_show';
  if (/desenho|anima/.test(text)) return null;
  if (/filme/.test(text)) return 'movie';
  return null;
}

/**
 * Tipo da página pelo SLUG, para quando o badge não desempata. Medido em 8
 * páginas reais (160 cards): `Filmes` nunca veio com `-temporada` no slug e
 * `Séries` nunca veio sem — os dois marcadores concordam sempre, então o slug
 * é a evidência de reserva que não erra, e não um palpite.
 */
export function kindFromWorkSlug(url: string | null | undefined): 'movie' | 'tv_show' {
  return isSeasonSlug(url) ? 'tv_show' : 'movie';
}

/**
 * O slug declara TEMPORADA (`-14a-temporada`, `-3-temporada`). É a coerência
 * de tipo entre a fila e a página: um pack de temporada pedido como `movie`
 * gravaria obra que não existe no catálogo, e uma página de filme pedida como
 * `tv_show` perderia a temporada na identificação.
 */
export function isSeasonSlug(url: string | URL | null | undefined): boolean {
  return SEASON_SLUG_RE.test(typeof url === 'string' ? url : (url?.pathname ?? ''));
}

/** O caminho é de PÁGINA DE OBRA (`/<slug>-torrent-download/`). */
export function isWorkPath(href: URL | string): boolean {
  let path: string;
  if (typeof href === 'string') {
    try { path = new URL(href).pathname; } catch { path = href; }
  } else {
    path = href.pathname;
  }
  return WORK_SLUG_RE.test(path);
}

/** Conta cards brutos pelo marcador de bloco medido nas fixtures do site. */
export function countListingCards(html: string | null | undefined): number {
  return [...String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').matchAll(
    /<a\b[^>]*\bclass=["'][^"']*\bmedia-card-link\b[^"']*["'][^>]*>/gi,
  )].length;
}

/**
 * Ficha do post vira TEXTO antes das regras compartilhadas. O site escreve a
 * ficha como `<dt>Rótulo</dt><dd>valor</dd>` (medido nos 3 posts reais), e as
 * regras de `shared.ts` foram escritas para `<b>Rótulo:</b> valor`: sem esta
 * normalização, `parseOriginalTitle` e `fichaYear` devolvem `null` e a página
 * cai em `pagina-sem-ano`.
 *
 * É normalização por MARCAÇÃO, não uma régua nova — a mesma saída que o BLUDV
 * faz trocando `<em>` por espaço. O `<span class="sep">·</span>` do subtítulo
 * do `<h1>` também sai: o `·` não está na lista de separadores órfãos da
 * `work-name.ts` e sobrava no título limpo (medido: "Os Irregulares de Baker
 * Street · ·").
 */
export function fichaText(html: string): string {
  return String(html || '')
    .replace(/<span class="sep">[\s\S]*?<\/span>/gi, ' ')
    .replace(/<\/?(?:dt|dd)\b[^>]*>/gi, ' ')
    .replace(/<\/?time\b[^>]*>/gi, ' ');
}

/** `imdb.com/title/tt…` e `imdb.com/pt/title/tt…` (medido: o site usa as duas). */
const IMDB_TITLE_RE = /(?:https?:)?\/\/(?:www\.|m\.)?imdb\.com\/(?:[a-z]{2}\/)?title\/(tt\d{5,})([^"'\s<>]*)/gi;
/** Widget de recomendação (mesma forma do redetorrent, mesma disciplina). */
const IMDB_WIDGET_PATH_RE = /\/(?:ref_|list|listicle)(?:[/?]|$)/i;

/** O IMDb inclui a referência do plugin na query, não necessariamente no path. */
function isWidgetReference(suffix: string): boolean {
  if (IMDB_WIDGET_PATH_RE.test(suffix)) return true;
  try {
    const url = new URL(`https://www.imdb.com/title/tt0000000${suffix.replace(/&amp;/gi, '&')}`);
    return [...url.searchParams].some(([key, value]) => (
      key.toLowerCase() === 'ref_' && /^tt_plg(?:_|$)/i.test(value)
    ));
  } catch {
    return false;
  }
}

/**
 * IMDb da obra: um `tt` único na página é o da obra; dois ou nenhum é
 * ambíguo (widget) e a identificação cai para título+ano. NUNCA "o primeiro
 * `tt` da página" — o `ref_=tt_` do WordPress aponta para obra alheia.
 *
 * Medido nos 3 posts reais capturados: 1 `tt` por página, sempre o da obra
 * ("Os Irregulares de Baker Street" → tt10893694, "Código de Conduta" →
 * tt37692332, "Presidente Curtis" → tt37692332 via `/pt/title/`), e nenhum
 * widget `ref_=tt_`.
 */
export function parseImdbId(html: string): string | null {
  const found = new Set(
    [...String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').matchAll(IMDB_TITLE_RE)]
      .filter((m) => !isWidgetReference(m[2] ?? ''))
      .map((m) => m[1]),
  );
  return found.size === 1 ? [...found][0] : null;
}

/** Slug da URL de listagem, para o cursor e o log. */
export function listingPath(base: string): string {
  try { return new URL(base).pathname; } catch { return '/'; }
}
