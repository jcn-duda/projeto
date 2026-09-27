// Cursor incremental POR KIND (F2 da Fase 7 de séries). Extraído de
// `crawler.ts` pela catraca de linhas: a política de avanço/migração é PURA
// sobre o store — o motor só chama. Filmes e séries têm sitemaps, falhas e
// ciclos independentes: um cursor único fazia a série refém do filme (e
// vice-versa). Chaves duráveis no `crawl_state`: `cursor:movie` e
// `cursor:tv_show`; o cursor LEGADO único (Fase 6) migra para `cursor:movie`
// uma vez, preservando a carga de filmes de instalação existente — séries sem
// cursor começam `initial` para o próprio kind quando a descoberta for
// ligada, sem "Zerar site".
import * as store from '../utils/crawl-store.js';
import * as log from '../utils/logger.js';
import { maxLastmod } from './crawl-pauses.js';
import type { CrawlDiscovery } from './crawl-types.js';

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
