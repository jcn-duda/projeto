// Carga dos cursores POR SITE a partir do `crawl_state`. Extraído de
// `crawler.ts` pela catraca de linhas e porque o motor passou a ter DOIS
// momentos de carga, não um:
//
// 1. boot com o site ativo (`primeSite`), como sempre;
// 2. site que fica ativo DEPOIS do boot — motor religado no painel, ou site do
//    catálogo ligado por override. Antes só o (1) existia: com o container
//    subindo desligado, o cursor gravado nunca era lido, a primeira rodada
//    saía `initial` e relia o sitemap inteiro em vez do incremental.
//
// A carga é única por processo (`cursorsLoaded`): depois dela a memória é a
// verdade (o `advanceCursors` persiste junto), e recarregar por cima de um
// "Zerar site" traria de volta um cursor que o operador acabou de descartar.
import type { CrawlEngine } from '../utils/crawl-store.js';
import { CURSOR_STATE_KEY, LEGACY_CURSOR_KEY, loadCursorsFromStore, type CursorMap } from './crawl-cursor.js';
import type { SiteRuntime } from './crawl-site-runtime.js';

/** Carrega os cursores do site uma vez por processo (idempotente). */
export function primeCursors(rt: SiteRuntime): void {
  if (rt.cursorsLoaded) return;
  rt.cursorsLoaded = true;
  loadCursorsFromStore(rt.id, rt.cursors);
}

/**
 * Cursores para o CARD do painel. Com a carga feita, a memória; sem ela (site
 * nunca ativo neste processo), leitura quiet do `crawl_state` — o status só
 * LÊ, então nem carrega o runtime nem migra o cursor legado (quem migra é a
 * carga de verdade). Sem isso o card de um site desligado dizia "carga
 * inicial" com cursor gravado no banco.
 */
export function cursorsView(rt: SiteRuntime, engine: CrawlEngine): CursorMap {
  if (rt.cursorsLoaded) return { ...rt.cursors };
  const movie = engine.getState(rt.id, CURSOR_STATE_KEY.movie) || engine.getState(rt.id, LEGACY_CURSOR_KEY) || '';
  const tvShow = engine.getState(rt.id, CURSOR_STATE_KEY.tv_show) || '';
  return { movie, tv_show: tvShow };
}
