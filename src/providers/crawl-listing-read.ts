// Leitura de UMA página da listagem paginada — o único verbo que move o
// cursor (`ListingCursor`, em `crawl-cursor.ts`). Extraído de lá pela catraca
// de 400 linhas quando a regra da ÂNCORA mudou (2026-09-30).
//
// Duas fases, e a âncora só vale na segunda:
//  - CARGA INICIAL (`sweep` ausente): anda da página 1 até o fim. O cursor só
//    avança, então a âncora do round anterior NUNCA prova cobertura: quando ela
//    reaparece é deslizamento da listagem (post novo no topo empurra tudo uma
//    posição). Medido na VPS: o Apache achou a "âncora" na página 42, fechou a
//    rodada como completa e esperou 1 h — a carga inteira levaria ~4 dias e meio.
//  - INCREMENTAL (`sweep: true`): ao chegar ao fim, a próxima passada começa na
//    página 1 e fecha ao reencontrar o post mais NOVO da passada anterior
//    (`head` → `anchor`). Antes não havia volta à página 1: depois da carga,
//    post novo do site nunca seria lido.
import { crawlUrlKey } from '../utils/crawl-url-key.js';
import {
  LISTING_ROUND_MAX_PAGES, listingCursorExhausted, listingRoundExhausted, restartListingRound, type ListingCursor,
} from './crawl-cursor.js';

/** Uma página lida da listagem, como o adaptador a viu. */
export interface ListingPageRead {
  /**
   * Posts da página NA ORDEM DO SITE (primeiro = mais novo, padrão WordPress).
   * A ordem não é enfeite: o marco do round é o ÚLTIMO post lido, e ele só
   * significa "li até aqui" se for o mais antigo da página.
   */
  posts: readonly string[];
  /** Quantos posts entraram na fila (orçamento gasto). Default: `posts.length`. */
  enqueued?: number;
  /** O adaptador viu o FIM da listagem (link de "próxima" ausente/vazio). */
  endOfListing?: boolean;
}

export interface ListingReadOptions {
  /** Teto de páginas por round; 0 = sem teto. Default: `LISTING_ROUND_MAX_PAGES`. */
  roundMaxPages?: number;
  /** Teto ABSOLUTO de profundidade (`0` = sem teto); ver `listingCursorExhausted`. */
  maxPages?: number;
}

/** Por que o round parou. `walk` = a página foi lida e o round continua. */
export type ListingReadReason = 'anchor-found' | 'end-of-listing' | 'round-cap' | 'page-cap' | 'walk';

export interface ListingReadResult {
  /** Cursor para gravar — o MESMO objeto quando nada foi consumido. */
  cursor: ListingCursor;
  /** O round cobriu a listagem? Só a âncora achada ou o fim declarado fecham. */
  complete: boolean;
  reason: ListingReadReason;
  /** A âncora do round apareceu nesta página. */
  anchorFound: boolean;
  /** A página foi consumida (posição e orçamento contados)? */
  advanced: boolean;
}

/** Caminho utilizável de um post da listagem (`''`/`/` não são marco). */
function postKey(post: unknown): string {
  const key = crawlUrlKey(String(post ?? ''));
  return key && key !== '/' ? key : '';
}

/** O marco do round: o post mais ANTIGO lido (último da página, na ordem do site). */
function closingAnchor(posts: readonly string[]): string {
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const key = postKey(posts[i]);
    if (key) return key;
  }
  return '';
}

const int = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

/**
 * Consome UMA página e decide o destino do round, nesta ordem: (1) round já
 * esgotado por token incoerente ⇒ nada consumido, round reinicia; (2) `maxPages`
 * estourado ⇒ nada consumido; (3) fim declarado, ou âncora achada no INCREMENTAL
 * ⇒ `complete` e a próxima passada começa na página 1, incremental, com a âncora
 * no post mais novo desta; (4) teto do round ⇒ fecha `round-cap` sem cobertura
 * (no incremental SEM âncora — cursor que acabou de virar — o teto é a
 * cobertura: as páginas do topo foram relidas); (5) senão, `walk`. `page` e
 * `seen` nunca recuam, exceto na volta à página 1 de uma passada coberta.
 */
export function readListingPage(
  cursor: ListingCursor,
  page: ListingPageRead,
  now: number,
  opts: ListingReadOptions = {},
): ListingReadResult {
  const roundMax = int(opts.roundMaxPages ?? LISTING_ROUND_MAX_PAGES);
  if (listingRoundExhausted(cursor, roundMax)) {
    return { cursor: restartListingRound(cursor, now), complete: false, reason: 'round-cap', anchorFound: false, advanced: false };
  }
  if (listingCursorExhausted(cursor, opts.maxPages)) {
    return { cursor, complete: false, reason: 'page-cap', anchorFound: false, advanced: false };
  }
  const posts = Array.isArray(page?.posts) ? page.posts : [];
  const keys = posts.map(postKey);
  const sweep = cursor.sweep === true;
  const anchorFound = sweep && cursor.anchor !== '' && keys.includes(cursor.anchor);
  const endOfListing = page?.endOfListing === true;
  const pageNo = Math.max(1, Math.trunc(Number(cursor.page) || 1));
  // O post mais novo da passada: o primeiro da página 1.
  const head = cursor.head || (pageNo === 1 ? keys.find(Boolean) || '' : '');
  const roundPage = int(cursor.roundPage) + 1;
  const reachedCap = roundMax > 0 && roundPage >= roundMax;
  const complete = anchorFound || endOfListing || (sweep && cursor.anchor === '' && reachedCap);
  const close = complete || reachedCap;
  const seen = int(cursor.seen) + int(page?.enqueued ?? posts.length);
  const rounds = close ? int(cursor.rounds) + 1 : int(cursor.rounds);
  const { head: _previous, ...base } = cursor;
  const next: ListingCursor = complete
    // Sem `head` (cursor gravado antes deste campo) a âncora da carga inicial é
    // um post do MEIO do catálogo: como parada do incremental, ela faria a
    // passada reler quase tudo. Vazia, o incremental cobre as páginas do topo.
    ? { ...base, page: 1, seen, roundPage: 0, rounds, updatedAt: now, sweep: true, anchor: head || (sweep ? cursor.anchor : '') }
    : {
      ...base,
      page: pageNo + 1,
      seen,
      roundPage: close ? 0 : roundPage,
      // Na carga inicial o marco segue o fim do trecho lido (diagnóstico); no
      // incremental ele é a parada da passada e não se move até ela fechar.
      anchor: close && !sweep ? (closingAnchor(posts) || cursor.anchor) : cursor.anchor,
      rounds,
      updatedAt: now,
      ...(head ? { head } : {}),
    };
  return {
    cursor: next,
    complete,
    reason: anchorFound ? 'anchor-found' : endOfListing ? 'end-of-listing' : reachedCap ? 'round-cap' : 'walk',
    anchorFound,
    advanced: true,
  };
}
