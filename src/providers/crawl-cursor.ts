// Cursor incremental POR KIND (F2 da Fase 7 de séries). Extraído de
// `crawler.ts` pela catraca de linhas: a política de avanço/migração é PURA
// sobre o store — o motor só chama. Filmes e séries têm sitemaps, falhas e
// ciclos independentes: um cursor único fazia a série refém do filme (e
// vice-versa). Chaves duráveis no `crawl_state`: `cursor:movie` e
// `cursor:tv_show`; o cursor LEGADO único (Fase 6) migra para `cursor:movie`
// uma vez, preservando a carga de filmes de instalação existente — séries sem
// cursor começam `initial` para o próprio kind quando a descoberta for
// ligada, sem "Zerar site".
//
// Na MESMA casa mora o cursor opaco de LISTAGEM (Fase 8, fim do arquivo):
// site sem sitemap é percorrido por listagem paginada, e a página em que a
// varredura parou é estado de retomada do mesmo tipo — a diferença é que o
// cursor de listagem é por LISTAGEM, não por kind de obra.
import * as store from '../utils/crawl-store.js';
import * as log from '../utils/logger.js';
import { crawlUrlKey } from '../utils/crawl-url-key.js';
import { maxLastmod } from './crawl-pauses.js';
import type { CrawlDiscovery, CrawlPageKind } from './crawl-types.js';

export type CrawlKind = 'movie' | 'tv_show';

/** Chaves de estado durável por kind. */
export const CURSOR_STATE_KEY: Record<CrawlKind, string> = {
  movie: 'cursor:movie',
  tv_show: 'cursor:tv_show',
};
/** Chave LEGADA (Fase 6, cursor único): migrada para `cursor:movie` no start. */
export const LEGACY_CURSOR_KEY = 'cursor';

export type CursorMap = Record<CrawlKind, string>;

/**
 * Fase e corte POR KIND da rodada de descoberta: filme incremental com o SEU
 * cursor, série com o dela (série sem cursor começa `initial`, mesmo com
 * filmes andando). A coluna única da rodada (`crawl_run`) registra o filme,
 * que domina o progresso do painel.
 */
export function discoveryCuts(cursors: CursorMap): {
  phase: 'initial' | 'incremental';
  sinceByKind: Record<CrawlKind, string | null>;
} {
  const incremental: Record<CrawlKind, boolean> = {
    movie: cursors.movie !== '',
    tv_show: cursors.tv_show !== '',
  };
  return {
    phase: incremental.movie ? 'incremental' : 'initial',
    sinceByKind: {
      movie: incremental.movie ? cursors.movie : null,
      tv_show: incremental.tv_show ? cursors.tv_show : null,
    },
  };
}

/**
 * Restaura os cursores do `crawl_state` e migra o legado. Idempotente:
 * `cursor:movie` existente vence; o valor legado permanece intocado (a fonte
 * da verdade passa a ser a chave nova).
 */
export function loadCursorsFromStore(siteId: string, cursors: CursorMap): void {
  const savedMovie = store.engine().getState(siteId, CURSOR_STATE_KEY.movie);
  if (savedMovie != null && savedMovie !== '') {
    cursors.movie = savedMovie;
  } else {
    const legacy = store.engine().getState(siteId, LEGACY_CURSOR_KEY);
    if (legacy) {
      cursors.movie = legacy;
      store.engine().setState(siteId, CURSOR_STATE_KEY.movie, legacy);
      log.info(`[crawl] cursor legado migrado para cursor:movie (${legacy})`);
    }
  }
  const savedTv = store.engine().getState(siteId, CURSOR_STATE_KEY.tv_show);
  if (savedTv != null && savedTv !== '') cursors.tv_show = savedTv;
  if (cursors.movie) log.info(`[crawl] cursor movie restaurado do crawl.db (${cursors.movie})`);
  if (cursors.tv_show) log.info(`[crawl] cursor tv_show restaurado do crawl.db (${cursors.tv_show})`);
}

/**
 * Avanço seguro POR KIND: o cursor de cada tipo anda só com a descoberta DELE
 * completa — parcial de um sitemap não trava o avanço do outro. Sem
 * `completeByKind` (adaptador legado), o `complete` geral vale para ambos.
 * Retorna os kinds que avançaram (o motor usa para log/métrica).
 */
export function advanceCursors(
  siteId: string,
  discovery: CrawlDiscovery,
  cursors: CursorMap,
): { movie: boolean; tv_show: boolean } {
  const completeByKind = discovery.completeByKind ?? {
    movie: discovery.complete,
    tv_show: discovery.complete,
  };
  const advanced = { movie: false, tv_show: false };
  for (const kind of ['movie', 'tv_show'] as const) {
    const max = maxLastmod(discovery.urls.filter((u) => u.kind === kind));
    if (max && completeByKind[kind] !== false) {
      cursors[kind] = max;
      // Fase 6: cursor durável — restart retoma incremental sem refazer a
      // carga inicial inteira.
      store.engine().setState(siteId, CURSOR_STATE_KEY[kind], max);
      advanced[kind] = true;
    }
  }
  return advanced;
}

// --- Cursor opaco de LISTAGEM (Fase 8) --------------------------------------
//
// Site sem sitemap útil é percorrido por LISTAGEM paginada ("página 2 de 40"),
// e essa paginação é estado de retomada: se o container reinicia no meio do
// varredura, a listagem recomeça da página 1 e relê o que já leu. O cursor
// guarda a página corrente por listagem, no `crawl_state` (durável, escopado
// por site) — o mesmo caminho do cursor incremental, com a diferença de que um
// é por KIND de obra e o outro é por LISTAGEM.
//
// Por que opaco: o token é `lc1.<base64url(json)>` e NINGUÉM fora daqui sabe
// o formato. O adaptador entrega o token, pede o próximo e grava o que
// recebeu; mudar a representation (adicionar campo, trocar o número da versão)
// não toca quem consome, e um token forjado/obsoleto volta `null` em vez de ser
// interpretado pela metade — cursor corrompido recomeça da listagem, que é o
// lado barato (a listagem é reidempotente por `url_key`).
//
// O cursor NÃO entra na `crawl_url`: página de listagem não é conteúdo, e
// guardá-la ali faria a fila reenfileirar `/page/2` como se fosse um post.
//
// ÂNCORA (o que impede a varredura eterna). Uma listagem BR é ordenada do mais
// novo para o mais antigo, então ela CRESCE pela frente: a página 1 de amanhã
// tem posts que não existiam hoje, e "página 2" deixou de ser a página 2. Um
// cursor só com número de página releria as mesmas páginas para sempre sem
// chegar ao fim. A âncora é o POST mais ANTIGO já lido (guardado pelo CAMINHO,
// então sobrevive à troca de domínio do site): o round caminha até achar aquele
// post e ali PARA — o que está acima é novo, o que está abaixo já foi
// enfileirado. A âncora só avança quando o round fecha, e o round fecha na
// âncora achada, no fim de listagem declarado, ou no TETO de páginas — o que
// fecha por teto devolve `complete: false`, porque um round que não achou a
// âncora NÃO pode afirmar que cobriu a listagem.

/** Prefixo/versão do token. Trocar a versão invalida os tokens antigos. */
export const LISTING_CURSOR_TAG = 'lc1';
/** Teto de tamanho do token lido: estado do operador, não entrada de usuário —
 * o limite existe para um `crawl_state` corrompido não virar parse caro. */
const LISTING_CURSOR_MAX_LEN = 1024;

/**
 * Teto de páginas por ROUND (0 desliga): o round que não acha a âncora é
 * cortado no teto, para a listagem não virar varredura sem fim dentro de um
 * ciclo — ele fecha e volta no ciclo incremental, mais barato que insistir.
 * Dimensionado contra o teto por hora do motor. O operador ajusta por CHAMADA
 * (`opts.roundMaxPages`); o knob de ambiente fica fora de propósito — este
 * módulo é puro e não lê config.
 */
export const LISTING_ROUND_MAX_PAGES = 20;

/** Onde a listagem parou. `page` é 1-based: a primeira página a ler é 1. */
export interface ListingCursor {
  v: 1;
  /** Site dono — o estado já é escopado por site, mas o token viaja sozinho. */
  site: string;
  kind: CrawlPageKind;
  /** Caminho raiz da listagem (identidade, sem query): mesma régua da fila. */
  path: string;
  /** Página a ler na retomada (1-based). */
  page: number;
  /** Posts já enfileirados desta listagem (orçamento já gasto). */
  seen: number;
  /** ÂNCORA: caminho do post mais antigo já lido, o marco que fecha o round.
   * `''` = nenhum (primeiro round: fecha pelo fim da listagem ou pelo teto). */
  anchor: string;
  /** Páginas já lidas no round em curso (zera quando o round fecha). */
  roundPage: number;
  /** Rounds fechados (diagnóstico do painel; não decide retomada). */
  rounds: number;
  /** Última gravação (diagnóstico; não decide retomada). */
  updatedAt: number;
}

/** Chave durável da listagem no `crawl_state`. Aceita URL ou caminho: a
 * normalização do `crawlUrlKey` torna as duas a mesma chave. */
export function listingCursorKey(kind: CrawlPageKind, listing: string): string {
  return `listing:${kind}:${crawlUrlKey(listing)}`;
}

/** Cursor zerado — "nunca li esta listagem". */
export function startListingCursor(site: string, kind: CrawlPageKind, listing: string, now: number): ListingCursor {
  return {
    v: 1, site: String(site || ''), kind, path: crawlUrlKey(listing),
    page: 1, seen: 0, anchor: '', roundPage: 0, rounds: 0, updatedAt: now,
  };
}

export function encodeListingCursor(cursor: ListingCursor): string {
  const json = JSON.stringify({
    v: 1, s: String(cursor.site || ''), k: cursor.kind === 'tv_show' ? 'tv_show' : 'movie',
    p: crawlUrlKey(cursor.path), n: Math.max(1, Math.trunc(Number(cursor.page) || 1)),
    c: Math.max(0, Math.trunc(Number(cursor.seen) || 0)), a: cursor.anchor,
    r: Math.max(0, Math.trunc(Number(cursor.roundPage) || 0)),
    d: Math.max(0, Math.trunc(Number(cursor.rounds) || 0)),
    t: Math.max(0, Math.trunc(Number(cursor.updatedAt) || 0)),
  });
  return `${LISTING_CURSOR_TAG}.${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function isNonNegInt(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

/**
 * Âncora vinda do token: `''` quando AUSENTE (token gravado antes de a âncora
 * existir é lido como "sem marco", não como token ruim — o round passa a fechar
 * pelo fim/teto) e `null` quando PRESENTE e inútil (corrupção: recomeçar a
 * listagem é o lado barato).
 */
function parseAnchor(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  if (!value.trim()) return '';
  const key = crawlUrlKey(value);
  return key && key !== '/' ? key : null;
}

/** `null` para qualquer coisa fora de forma — nunca lança, nunca adota lixo. */
export function decodeListingCursor(token: string): ListingCursor | null {
  const text = String(token || '');
  if (!text || text.length > LISTING_CURSOR_MAX_LEN) return null;
  const dot = text.indexOf('.');
  if (dot <= 0 || text.slice(0, dot) !== LISTING_CURSOR_TAG) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text.slice(dot + 1), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = parsed as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || p.v !== 1) return null;
  if (p.k !== 'movie' && p.k !== 'tv_show') return null;
  const site = String(p.s || '');
  const path = crawlUrlKey(String(p.p || ''));
  if (!site || !path || path === '/') return null;
  if (!isNonNegInt(p.n, 1) || !isNonNegInt(p.c, 0) || !isNonNegInt(p.t, 0)) return null;
  const anchor = parseAnchor(p.a);
  if (anchor === null) return null;
  // Contadores ausentes = 0 (token anterior à âncora); presentes e fora de
  // forma = token corrompido.
  const roundPage = p.r === undefined || p.r === null ? 0 : p.r;
  const rounds = p.d === undefined || p.d === null ? 0 : p.d;
  if (!isNonNegInt(roundPage, 0) || !isNonNegInt(rounds, 0)) return null;
  return { v: 1, site, kind: p.k, path, page: p.n, seen: p.c, anchor, roundPage, rounds, updatedAt: p.t };
}

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

/** O round já leu o que podia? O chamador PARA de buscar páginas aqui. */
export function listingRoundExhausted(cursor: ListingCursor, roundMaxPages = LISTING_ROUND_MAX_PAGES): boolean {
  const cap = Math.max(0, Math.trunc(Number(roundMaxPages) || 0));
  return cap > 0 && Math.max(0, Math.trunc(Number(cursor.roundPage) || 0)) >= cap;
}

/** A listagem acabou para este ciclo? `maxPages` = 0 (ou ausente) não limita. */
export function listingCursorExhausted(cursor: ListingCursor, maxPages = 0): boolean {
  const cap = Math.max(0, Math.trunc(Number(maxPages) || 0));
  return cap > 0 && cursor.page > cap;
}

/** Reinicia o round em curso sem tocar no marco nem na posição — a recuperação
 * quando o `roundPage` gravado ficou incoerente (token de outra forma): sem ele
 * a listagem pararia para sempre, porque nada mais fecharia o round. */
export function restartListingRound(cursor: ListingCursor, now: number): ListingCursor {
  return { ...cursor, roundPage: 0, updatedAt: now };
}

/**
 * Consome UMA página lida e decide o destino do round. É o ÚNICO verbo que
 * move o cursor de listagem — não existe avanço sem âncora por fora, que é o
 * que mantinha a varredura relendo a mesma página para sempre.
 *
 * Regras, nesta ordem: (1) round já esgotado por token incoerente ⇒ nada é
 * consumido e o round reinicia; (2) `maxPages` estourado ⇒ a listagem foi
 * abandonada no limite de profundidade e nada é consumido; (3) âncora na página
 * OU fim declarado ⇒ o round FECHA com `complete: true` e o marco vira o post
 * mais antigo lido; (4) a página bateu o teto do round ⇒ o round FECHA por
 * `round-cap` com `complete: false` (não achou a âncora, logo não pode afirmar
 * cobertura) e o marco também avança, para o próximo round não reler o mesmo
 * trecho; (5) nada disso ⇒ a página é consumida e o round continua (`walk`).
 * `page` e `seen` nunca recuam (é a retomada) e número negativo não devolve
 * orçamento.
 */
export function readListingPage(
  cursor: ListingCursor,
  page: ListingPageRead,
  now: number,
  opts: ListingReadOptions = {},
): ListingReadResult {
  const roundMax = Math.max(0, Math.trunc(Number(opts.roundMaxPages ?? LISTING_ROUND_MAX_PAGES) || 0));
  // 1) round incoerente: reinicia sem consumir (senão a listagem trava).
  if (listingRoundExhausted(cursor, roundMax)) {
    return { cursor: restartListingRound(cursor, now), complete: false, reason: 'round-cap', anchorFound: false, advanced: false };
  }
  // 2) teto absoluto de profundidade: o ciclo acabou por decisão do operador.
  if (listingCursorExhausted(cursor, opts.maxPages)) {
    return { cursor, complete: false, reason: 'page-cap', anchorFound: false, advanced: false };
  }
  const posts = Array.isArray(page?.posts) ? page.posts : [];
  const keys = posts.map(postKey);
  const anchorFound = cursor.anchor !== '' && keys.includes(cursor.anchor);
  const endOfListing = page?.endOfListing === true;
  const roundPage = Math.max(0, Math.trunc(Number(cursor.roundPage) || 0)) + 1;
  const reachedCap = roundMax > 0 && roundPage >= roundMax;
  const close = anchorFound || endOfListing || reachedCap;
  const next: ListingCursor = {
    ...cursor,
    page: Math.max(1, Math.trunc(Number(cursor.page) || 1)) + 1,
    seen: Math.max(0, Math.trunc(Number(cursor.seen) || 0)) + Math.max(0, Math.trunc(Number(page?.enqueued ?? posts.length) || 0)),
    roundPage: close ? 0 : roundPage,
    // O marco só anda quando o round fecha: um round aberto não pode prometer
    // que leu até o fim. Sem post utilizável na página, o marco anterior fica.
    anchor: close ? (closingAnchor(posts) || cursor.anchor) : cursor.anchor,
    rounds: close ? Math.max(0, Math.trunc(Number(cursor.rounds) || 0)) + 1 : Math.max(0, Math.trunc(Number(cursor.rounds) || 0)),
    updatedAt: now,
  };
  return {
    cursor: next,
    complete: anchorFound || endOfListing,
    reason: anchorFound ? 'anchor-found' : endOfListing ? 'end-of-listing' : reachedCap ? 'round-cap' : 'walk',
    anchorFound,
    advanced: true,
  };
}

/** Lê o cursor durável da listagem. Ausente, ilegível ou de outra listagem
 * (mesmo site, caminho diferente) = `null`: o chamador recomeça da página 1. */
export function loadListingCursor(site: string, kind: CrawlPageKind, listing: string): ListingCursor | null {
  const raw = store.engine().getState(site, listingCursorKey(kind, listing));
  if (raw == null || raw === '') return null;
  const cursor = decodeListingCursor(raw);
  if (!cursor) return null;
  if (cursor.site !== String(site) || cursor.kind !== kind || cursor.path !== crawlUrlKey(listing)) return null;
  return cursor;
}

/** Grava o cursor (durável, escopado por site — o token já carrega site/kind). */
export function saveListingCursor(cursor: ListingCursor): void {
  store.engine().setState(cursor.site, listingCursorKey(cursor.kind, cursor.path), encodeListingCursor(cursor));
}

/** Apaga o cursor da listagem (o "Zerar site" já faz isso por site inteiro). */
export function clearListingCursor(site: string, kind: CrawlPageKind, listing: string): void {
  store.engine().setState(site, listingCursorKey(kind, listing), '');
}
