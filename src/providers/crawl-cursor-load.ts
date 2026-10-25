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
//
// O `crawl.db` é do sidecar Rust: a vista do CARD (`cursorsView`) não lê mais o
// banco — ela serve a última resposta de `GET /crawl/cursor?site=<id>` e pede
// um refresh em fundo. O status do painel é SÍNCRONO (`crawler.status()`), e
// esperar HTTP ali seguraria o `/dashboard-status.json` inteiro. Sem resposta
// da ponte, a leitura local do `crawl_state` continua valendo (é o MESMO banco
// que o sidecar lê, então o fallback não inventa estado). A carga do motor
// (`primeCursors`) e o avanço (`advanceCursors`) seguem locais nesta fatia.
import config from '../config.js';
import type { CrawlEngine } from '../utils/crawl-store.js';
import { CURSOR_STATE_KEY, LEGACY_CURSOR_KEY, loadCursorsFromStore, type CursorMap } from './crawl-cursor.js';
import type { SiteRuntime } from './crawl-site-runtime.js';

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

/** Carrega os cursores do site uma vez por processo (idempotente). */
export function primeCursors(rt: SiteRuntime): void {
  if (rt.cursorsLoaded) return;
  rt.cursorsLoaded = true;
  loadCursorsFromStore(rt.id, rt.cursors);
}

/**
 * Cursores para o CARD do painel. Com a carga feita, a memória; sem ela (site
 * nunca ativo neste processo), a vista da ponte do sidecar — e, enquanto ela
 * não chega (ou se nunca responder), a leitura quieta do `crawl_state`. O
 * status só LÊ: nem carrega o runtime nem migra o cursor legado (quem migra é
 * a carga de verdade). Sem isso o card de um site desligado dizia "carga
 * inicial" com cursor gravado no banco.
 */
export function cursorsView(rt: SiteRuntime, engine: CrawlEngine): CursorMap {
  if (rt.cursorsLoaded) return { ...rt.cursors };
  void refreshCursorsView(rt.id);
  const fromBridge = bridge.get(rt.id);
  if (fromBridge) return { ...fromBridge };
  const movie = engine.getState(rt.id, CURSOR_STATE_KEY.movie) || engine.getState(rt.id, LEGACY_CURSOR_KEY) || '';
  const tvShow = engine.getState(rt.id, CURSOR_STATE_KEY.tv_show) || '';
  return { movie, tv_show: tvShow };
}

/** Estado limpo entre casos de teste (o mapa da ponte é do processo). */
export function _resetForTest(): void {
  bridge.clear();
  inflight.clear();
}
