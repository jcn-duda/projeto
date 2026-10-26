// Cursores POR SITE para o CARD do painel. O `crawl.db` é do sidecar Rust, que
// também descobre e anda os cursores (sitemap e listagem, `adom-crawl`
// `discovery/`): o Node só os MOSTRA.
//
// A vista serve a última resposta de `GET /crawl/cursor?site=<id>` e pede um
// refresh em fundo. O status do painel é SÍNCRONO (`crawler.status()`), e
// esperar HTTP ali seguraria o `/dashboard-status.json` inteiro. Sem resposta
// da ponte, a leitura local do `crawl_state` continua valendo (é o MESMO banco
// que o sidecar lê, então o fallback não inventa estado).
import config from '../config.js';
import type { CrawlEngine } from '../utils/crawl-store.js';

export type CrawlKind = 'movie' | 'tv_show';
export type CursorMap = Record<CrawlKind, string>;

/** Chaves do cursor incremental por kind no `crawl_state` (as do sidecar). */
const CURSOR_STATE_KEY: Record<CrawlKind, string> = {
  movie: 'cursor:movie',
  tv_show: 'cursor:tv_show',
};
/** Cursor único da Fase 6: instalação antiga pode tê-lo só nesta chave. */
const LEGACY_CURSOR_KEY = 'cursor';

/** Última vista devolvida pela ponte, por site. */
const bridge = new Map<string, CursorMap>();
/** Leituras em voo por site: o poll do painel não empilha GET do mesmo site. */
const inflight = new Map<string, Promise<void>>();

/**
 * `GET /crawl/cursor?site=<id>` no sidecar; guarda a vista quando ela vale.
 * Nunca lança: ponte fora do ar, prazo vencido ou `ok:false` são "sem vista
 * nova" — o card cai no fallback local e o painel continua de pé.
 */
async function readCursorFromSidecar(site: string): Promise<void> {
  const url = `http://127.0.0.1:${config.crawl.sidecarPort}/crawl/cursor?site=${encodeURIComponent(site)}`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(config.crawl.sidecarStatusTimeoutMs),
      headers: config.jackett.testToken ? { 'X-Indexer-Test-Token': config.jackett.testToken } : {},
    });
    if (!resp.ok) return;
    const body = await resp.json() as { ok?: unknown; movie?: unknown; tv_show?: unknown };
    if (body?.ok !== true) return;
    bridge.set(site, {
      movie: typeof body.movie === 'string' ? body.movie : '',
      tv_show: typeof body.tv_show === 'string' ? body.tv_show : '',
    });
  } catch {
    // sidecar fora do ar: silêncio de propósito (o fallback local cobre).
  }
}

/** Atualiza a vista do site na ponte; deduplicada e aguardável (teste). */
export function refreshCursorsView(site: string): Promise<void> {
  const current = inflight.get(site);
  if (current) return current;
  const job = readCursorFromSidecar(site).finally(() => inflight.delete(site));
  inflight.set(site, job);
  return job;
}

/**
 * Cursores para o CARD do painel: a vista da ponte do sidecar e, enquanto ela
 * não chega (ou se nunca responder), a leitura quieta do `crawl_state`. Só
 * LÊ: não migra o cursor legado (quem grava é o sidecar).
 */
export function cursorsView(site: string, engine: CrawlEngine): CursorMap {
  void refreshCursorsView(site);
  const fromBridge = bridge.get(site);
  if (fromBridge) return { ...fromBridge };
  const movie = engine.getState(site, CURSOR_STATE_KEY.movie) || engine.getState(site, LEGACY_CURSOR_KEY) || '';
  const tvShow = engine.getState(site, CURSOR_STATE_KEY.tv_show) || '';
  return { movie, tv_show: tvShow };
}

/** Estado limpo entre casos de teste (o mapa da ponte é do processo). */
export function _resetForTest(): void {
  bridge.clear();
  inflight.clear();
}
