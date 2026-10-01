// Quais cards do Jackett o RASPADOR já cobre — o colhedor pula esses
// (2026-09-30). Raspador e colhedor alimentam o mesmo acervo, e para os sites BR
// o raspador lê o catálogo INTEIRO direto no site, enquanto o colhedor consulta
// o mesmo site pelo Jackett obra por obra (FlareSolverr, até 90 s nos lentos).
// Trabalho em dobro — mas só depois que o raspador ficou EM DIA com o site.
//
// Coberto = TUDO isto (a ausência de qualquer prova devolve o card ao colhedor):
//  - motor ligado, site ligado e FORA de simulação — em dry-run nada é gravado;
//  - carga inicial concluída: cursor de sitemap gravado (descoberta completa ao
//    menos uma vez) ou cursor de listagem já no modo incremental (`sweep`);
//  - fila pequena (`CRAWL_COVER_MAX_PENDING`, sem contar `error`): páginas descobertas e não lidas
//    ainda não estão no acervo, e o colhedor segue sendo quem as encontra.
// A busca AO VIVO não passa por aqui: abrir um título consulta o site como sempre.
import config from '../config.js';
import * as crawlerLive from '../utils/crawler-live.js';
import * as store from '../utils/crawl-store.js';
import { knownSites, siteConfigOf } from '../utils/crawler-live-schema.js';
import { CURSOR_STATE_KEY, decodeListingCursor, listingCursorKey } from './crawl-cursor.js';

/** Caminho da listagem dos sites sem sitemap (HDRTorrent e ApacheTorrent). */
const LISTING_PATH = '/pagina/';

/** Carga inicial concluída: cursor de sitemap gravado ou listagem em `sweep`. */
export function initialLoadDone(engine: store.CrawlEngine, site: string): boolean {
  const listing = engine.getState(site, listingCursorKey('movie', LISTING_PATH));
  if (listing) return decodeListingCursor(listing)?.sweep === true;
  return Boolean(engine.getState(site, CURSOR_STATE_KEY.movie));
}

// Memo curto: o colhedor pergunta a cada obra, e a resposta muda em minutos,
// não em segundos. Sem ele seriam N contagens no SQLite por colheita.
const MEMO_MS = 60_000;
let memo: { at: number; value: Set<string> } | null = null;

/** Ids dos cards cobertos agora. Nunca lança: erro de leitura = nada coberto. */
export function crawlCoveredIndexers(now = Date.now()): Set<string> {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const covered = computeCovered();
  memo = { at: now, value: covered };
  return covered;
}

export function _resetCoverageMemoForTest(): void {
  memo = null;
}

function computeCovered(): Set<string> {
  const covered = new Set<string>();
  if (!config.crawl.coverHarvest) return covered;
  try {
    const live = crawlerLive.effective();
    const engine = store.currentEngine();
    if (!live.enabled || !engine) return covered;
    for (const site of knownSites(live)) {
      const cfg = siteConfigOf(live, site);
      if (!cfg.enabled || cfg.dryRun) continue;
      const by = engine.counters(site).byStatus;
      // `error` fica FORA: é página que o site quebra (RedeTorrent na VPS: 107,
      // quase todas HTTP 500 permanente), não acervo esperando leitura —
      // contá-la deixaria o site "atrasado" para sempre.
      const backlog = (by.pending || 0) + (by.partial || 0) + (by.inflight || 0);
      if (backlog > config.crawl.coverMaxPending) continue;
      if (initialLoadDone(engine, site)) covered.add(site);
    }
  } catch {
    covered.clear();
  }
  return covered;
}
