// Núcleo de DESCOBERTA POR LISTAGEM paginada, comum aos sites BR que não
// publicam sitemap. Quem extrai as URLs da página é INJETADO (`readPage`):
// aqui mora só a regra de paginação, de fim e de custo. O HTML é do site.
//
// ## Por que um núcleo, e não mais um `discover()` por site
//
// O RedeTorrent e o BLUDV têm o que chamar de descoberta COMPLETA: ler o índice
// devolve o acervo inteiro e o cursor de data decide o que é novo. Uma
// LISTAGEM não tem essa propriedade — é uma janela deslizante sobre um acervo
// ordenado, e o fim dela é um FATO OBSERVADO (a página calça o calcanhar), não
// uma declaração do site.
//
// Medido no HDRTorrent em 2026-09-29 (bisseção sobre `/pagina/N/`):
// `/pagina/1/` … `/pagina/2122/` são reais e sequenciais, com 20 cards cada;
// `/pagina/2123/` é a ÚLTIMA e tem 15; e `/pagina/2124/` … `/pagina/99999/`
// devolvem SEMPRE a 2123. Separar "cheguei ao fim" de "o site me devolveu a
// última página de novo" é o que estas regras fazem, e vale para qualquer site
// que pagina — daí o núcleo.
//
// ## O corte NÃO é por data, e isso é uma decisão medida
//
// Os sites de sitemap cortam por `lastmod <= since`: a data do `<lastmod>` é a
// data real da linha. A listagem do HDRTorrent não traz data de publicação —
// o card só carrega `meta[itemprop=datePublished]`, que é o ANO DA OBRA
// (medido: "Presidente Curtis" 2026, "Os Irregulares de Baker Street" 2021,
// "Doutor Estranho Animação" 2008). O `og:published_time` do POST é a data
// real, mas vive no post: buscá-lo para cada card custaria 20 requisições por
// página e anularia o propósito da listagem.
//
// Usar o ano como `lastmod` faria o motor cortar o acervo pela ordem do ANO em
// vez da ordem de PUBLICAÇÃO, e a varredura pararia no posto errado. Por isso
// `lastmod` sai vazio: `maxLastmod` já tolera string vazia, e data inventada é
// pior que data ausente.
//
// ## O corte é a ÂNCORA do cursor de listagem, e ela é do repositório
//
// Como a listagem é DA MAIS NOVA PARA A MAIS ANTIGA e CRESCE pela frente, o
// "já coberto" é o POST mais antigo já enfileirado — o `readListingPage` do
// `crawl-cursor.ts` guarda isso, e a página 1 de amanhã tem posts que não
// existiam hoje. Este núcleo não reimplementa isso: ele entrega a página ao
// `readListingPage` e obedece ao veredito (âncora achada, fim de listagem
// declarado, ou teto de rodada).
//
// ## Trava de fim (a que o dado medido impõe)
//
// A trava primária é a CONTAGEM de URLs da página: uma página inteira do
// acervo tem o tamanho cheio (`expectedPerPage`, medido em 20 no HDRTorrent,
// `/pagina/1..2122`) e a página calcanhar tem menos — 14 em `/pagina/99999/`.
// Abaixo do cheio é fim de catálogo.
//
// A segunda trava é a PÁGINA JÁ VISTA: se a página voltou cheia e TODA repetida
// do que a rodada já entregou, o site devolveu a mesma página de sempre
// (inversão). Ela é indispensável porque a primeira, sozinha, não impede isso —
// uma página cheia repetida passaria como avanço, e o round gastaria o teto
// inteiro achando que andou.
//
// ## Página sem card reconhecido é FALHA, nunca "vazio e completo"
//
// É a regra que o AGENTS registra para o RedeTorrent: `urls: []` com
// `complete: true` faz o cursor do crawler avançar por cima de acervo nunca
// lido, e essa combinação é silenciosa por definição. Página sem NENHUM card
// entra em `failures`, não consome o cursor (o retry relê a MESMA página) e
// derruba o `complete`.
//
// ## Pureza
//
// O núcleo não conhece o HTML de ninguém: `readPage` é injetado e
// `expectedPerPage` é medido no site. Paginação, contagem, corte e custo são
// daqui. Erro de rede nunca derruba: vira `failures` e a rodada fecha com o
// que já entregou.
import {
  listingRoundExhausted, readListingPage,
  type ListingCursor,
} from '../crawl-cursor.js';
import type { CrawlPageKind, DiscoveredUrl } from '../crawl-types.js';

/** Um candidato da listagem: a URL e o tipo que o SITE declarou nela. */
export interface ListingPost {
  url: string;
  /**
   * Tipo declarado pelo SITE neste card. `null` quando o site não declara —
   * aí `defaultKind` do adaptador manda. O núcleo não deduz tipo de nada: quem
   * lê o card é o site.
   */
  kind?: CrawlPageKind | null;
}

/** Uma página da listagem, como o ADAPTADOR a viu. */
export interface ListingPageRead {
  /**
   * Candidatos da página, NA ORDEM DO SITE (primeiro = mais novo). A ordem não
   * é enfeite: a âncora do round é a ÚLTIMA linha, e "li até aqui" só
   * significa alguma coisa se ela for a mais antiga da página.
   */
  posts: ListingPost[];
}

/** Teto de uma rodada: até onde ela anda antes de devolver o controle. */
export interface ListingBudget {
  /**
   * Teto de PÁGINAS por rodada, repassado ao `readListingPage` como
   * `roundMaxPages`. A primeira rodada é `complete: false` e continua na
   * seguinte: o acervo do HDRTorrent tem 2123 páginas (medido), e uma
   * varredura que não as lê todas não pode afirmar que cobriu.
   */
  maxPagesPerRound: number;
}

export interface ListingWalkInput {
  /** Lê a página `page` (1-based, como o site numera). */
  readPage(page: number): Promise<ListingPageRead>;
  /** Tamanho CHEIO de uma página do acervo, medido no site. */
  expectedPerPage: number;
  /** Teto da rodada. */
  budget: ListingBudget;
  /** Série desligada: candidatos `tv_show` são lidos (o orçamento foi gasto no
   *  site) mas não entram na fila. Mesma política dos sites com sitemap. */
  seriesEnabled: boolean;
  /** Kind quando o card não declara tipo. */
  defaultKind: CrawlPageKind;
  /** Onde a listagem parou (cursor durável do motor). */
  cursor: ListingCursor;
  /** Relógio injetado: o núcleo não lê `Date.now()` em teste. */
  now: number;
}

/** O que a varredura viu — o adaptador converte em `CrawlDiscovery`. */
export interface ListingWalkResult {
  /** URLs INÉDITAS, na ordem em que a listagem as entregou. */
  urls: DiscoveredUrl[];
  /** Motivos curtos das páginas que falharam (nunca credencial). */
  failures: string[];
  /**
   * Requisições REAIS ao site nesta rodada — o `requestCost` que o motor cobra
   * no teto por hora. Inclui a página que FALHOU: o request saiu, e é ele que
   * queima orçamento do site (a mesma razão pela qual o `withRequestCost` do
   * `fetchWork` conta o salto que deu erro).
   */
  requests: number;
  /** Páginas que o cursor CONSUMIU (as que entraram no round de verdade). */
  pagesConsumed: number;
  /** A varredura provou que não existe página depois da última que leu. */
  endOfListing: boolean;
  /** O cursor durável para a próxima rodada gravar. */
  cursor: ListingCursor;
  /** Por que o round fechou — o vocabulário do `readListingPage`. */
  reason: string;
  /** A varredura cobriu o acervo (âncora ou fim de listagem, sem falha)? */
  complete: boolean;
}

/**
 * Anda a listagem a partir de `cursor.page` até o fim do acervo (ou o teto da
 * rodada), entregando URLs inéditas. A contagem de URLs é a trava primária de
 * fim; a página já vista é a segunda, e ela é o que impede a inversão.
 *
 * `readPage` é quem fala com o site: aqui não há fetch, timeout nem retry — só
 * a decisão sobre a página que chegou. O round fecha por `readListingPage`
 * (âncora / fim declarado / teto), e é esse veredito que define `complete`.
 */
export async function walkListing(input: ListingWalkInput): Promise<ListingWalkResult> {
  const { readPage, expectedPerPage, budget, seriesEnabled, defaultKind, now } = input;
  const urls: DiscoveredUrl[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  let cursor = input.cursor;
  let requests = 0;
  let pagesConsumed = 0;
  let endOfListing = false;
  let reason = 'walk';
  let complete = false;

  const full = Math.max(1, Math.trunc(expectedPerPage));

  while (pagesConsumed < Math.max(1, Math.trunc(budget.maxPagesPerRound))) {
    if (listingRoundExhausted(cursor, budget.maxPagesPerRound)) break;
    const page = Math.max(1, Math.trunc(cursor.page) || 1);

    let read: ListingPageRead;
    // A requisição CONTA mesmo quando ela falha: foi um request ao site, e é
    // ele que pesa no teto por hora. O cursor, ao contrário, não consome a
    // página que falhou — o retry relê a mesma.
    requests += 1;
    try {
      read = await readPage(page);
    } catch (err) {
      failures.push(`listing-pagina-${page}:${reasonOf(err)}`);
      break;
    }

    const posts = Array.isArray(read?.posts) ? read.posts : [];
    const fresh: ListingPost[] = [];
    const pageKeys: string[] = [];
    for (const post of posts) {
      const url = String(post?.url || '').trim();
      if (!url) continue;
      pageKeys.push(url);
      if (seen.has(url)) continue;
      seen.add(url);
      fresh.push({ url, kind: post.kind ?? defaultKind });
    }

    if (!pageKeys.length) {
      // Nenhum card reconhecido. Um `urls: []` com `complete: true` aqui faria
      // o cursor avançar por cima de acervo nunca lido.
      failures.push(`listing-pagina-${page}:nenhum-card`);
      break;
    }

    const counted = pageKeys.length < full;
    // Página inteira já vista com o tamanho cheio: o site devolveu a MESMA
    // página (inversão). Não prova fim de acervo, mas também não pode ser
    // relida para sempre — e o `counted` sozinho deixaria passar.
    const repeated = !fresh.length && !counted;

    for (const post of fresh) {
      // Série desligada: a página conta como lida (o orçamento foi gasto no
      // site), mas nenhuma URL dela entra na fila.
      if (post.kind === 'tv_show' && !seriesEnabled) continue;
      // `lastmod` vazio de propósito: a listagem publica o ANO da obra, não a
      // data de publicação (ver o cabeçalho). String vazia nunca é comparada.
      urls.push({ url: post.url, kind: post.kind as CrawlPageKind, lastmod: '' });
    }

    const consumed = readListingPage(
      cursor,
      { posts: pageKeys, endOfListing: counted },
      now,
      { roundMaxPages: budget.maxPagesPerRound },
    );
    if (!consumed.advanced) {
      // Token incoerente: o round reinicia sem consumir (a listagem pararia
      // para sempre). As URLs desta página já entraram acima.
      cursor = consumed.cursor;
      reason = consumed.reason;
      break;
    }
    cursor = consumed.cursor;
    pagesConsumed += 1;
    complete = consumed.complete;
    if (consumed.complete) { endOfListing = true; reason = consumed.reason; break; }
    // `repeated` com página cheia é a inversão de página: fecha o round sem
    // afirmar cobertura do acervo.
    if (repeated) { reason = 'already-seen-page'; break; }
    reason = consumed.reason;
  }

  return {
    urls,
    failures,
    requests,
    pagesConsumed,
    endOfListing,
    cursor,
    reason,
    // `readListingPage` só chama `complete` para âncora achada ou fim
    // declarado; teto de rodada nunca é cobertura. `failures` derruba de novo:
    // uma página que falhou não prova nada sobre as outras.
    complete: complete && failures.length === 0,
  };
}

/** Erro de terceiro vira motivo curto e sem espaço (vai para `failures`). */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return (raw || 'erro').trim().slice(0, 80).replace(/\s+/g, '-') || 'erro';
}
