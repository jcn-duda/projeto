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
import { CURSOR_STATE_KEY, decodeListingCursor, listingCursorKey, type CrawlKind } from './crawl-cursor.js';

/** Caminho da listagem dos sites sem sitemap (HDRTorrent e ApacheTorrent). */
const LISTING_PATH = '/pagina/';

/** Carga inicial concluída: cursor de sitemap gravado ou listagem em `sweep`. */
export function initialLoadDone(engine: store.CrawlEngine, site: string): boolean {
  const listing = engine.getState(site, listingCursorKey('movie', LISTING_PATH));
  if (listing) return decodeListingCursor(listing)?.sweep === true;
  return Boolean(engine.getState(site, CURSOR_STATE_KEY.movie));
}

/**
 * Carga inicial concluída POR KIND. Filme mantém a nuance do cursor de LISTAGEM
 * (sites sem sitemap varridos por `/pagina/`); os demais kinds (só `tv_show`)
 * têm apenas o cursor de sitemap do kind. É a base do skip POR KIND do Mico no
 * colhedor: uma série NÃO pode ser dada por coberta só porque o cursor de FILME
 * andou (ver `crawlCoversKind`).
 */
export function initialLoadDoneFor(engine: store.CrawlEngine, site: string, kind: CrawlKind): boolean {
  if (kind === 'movie') return initialLoadDone(engine, site);
  return Boolean(engine.getState(site, CURSOR_STATE_KEY[kind]));
}

// Memo curto: o colhedor pergunta a cada obra, e a resposta muda em minutos,
// não em segundos. Sem ele seriam N contagens no SQLite por colheita.
const MEMO_MS = 60_000;
let memo: { at: number; value: Set<string> } | null = null;
// Memo separado do caminho POR KIND (skip do Mico): mesma janela, outra chave.
let kindMemo: { at: number; value: Map<string, boolean> } | null = null;

/** Ids dos cards cobertos agora. Nunca lança: erro de leitura = nada coberto. */
export function crawlCoveredIndexers(now = Date.now()): Set<string> {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const covered = computeCovered();
  memo = { at: now, value: covered };
  return covered;
}

/**
 * O RASPADOR cobre `siteId` para O KIND `kind` agora. Caminho NOVO e separado
 * de `crawlCoveredIndexers` (este é baseado em FILME e alimenta o filtro de
 * indexers Jackett em `harvest-worker.ts` — mantido intacto): aplica os MESMOS
 * gates, mas a carga inicial é a do KIND (`initialLoadDoneFor`). Usado SÓ pelo
 * skip do Mico no colhedor, para que a SÉRIE não seja pulada só porque o cursor
 * de FILME andou (série desligada ou em falha total → nenhum `cursor:tv_show`).
 */
export function crawlCoversKind(siteId: string, kind: CrawlKind, now = Date.now()): boolean {
  const key = `${siteId}\u0000${kind}`;
  const fresh = kindMemo && now - kindMemo.at < MEMO_MS ? kindMemo : null;
  if (fresh) {
    const hit = fresh.value.get(key);
    if (hit !== undefined) return hit;
  }
  const value = fresh ? fresh.value : new Map<string, boolean>();
  const result = computeCoversKind(siteId, kind);
  value.set(key, result);
  kindMemo = { at: fresh ? fresh.at : now, value };
  return result;
}

export function _resetCoverageMemoForTest(): void {
  memo = null;
  kindMemo = null;
}

/**
 * Gates de cobertura de UM site (fora a carga inicial): motor/site ligados, sem
 * dry-run e fila pequena. Compartilhado por `computeCovered` (filme) e
 * `computeCoversKind` (por kind) para que os dois caminhos NÃO divirjam.
 */
function coverGatesPass(
  live: ReturnType<typeof crawlerLive.effective>,
  engine: store.CrawlEngine,
  site: string,
): boolean {
  const cfg = siteConfigOf(live, site);
  if (!cfg.enabled || cfg.dryRun) return false;
  const by = engine.counters(site).byStatus;
  // `error` fica FORA: é página que o site quebra (RedeTorrent na VPS: 107,
  // quase todas HTTP 500 permanente), não acervo esperando leitura —
  // contá-la deixaria o site "atrasado" para sempre.
  const backlog = (by.pending || 0) + (by.partial || 0) + (by.inflight || 0);
  return backlog <= config.crawl.coverMaxPending;
}

function computeCovered(): Set<string> {
  const covered = new Set<string>();
  if (!config.crawl.coverHarvest) return covered;
  try {
    const live = crawlerLive.effective();
    const engine = store.currentEngine();
    if (!live.enabled || !engine) return covered;
    for (const site of knownSites(live)) {
      if (!coverGatesPass(live, engine, site)) continue;
      if (initialLoadDone(engine, site)) covered.add(site);
    }
  } catch {
    covered.clear();
  }
  return covered;
}

function computeCoversKind(siteId: string, kind: CrawlKind): boolean {
  if (!config.crawl.coverHarvest) return false;
  try {
    const live = crawlerLive.effective();
    const engine = store.currentEngine();
    if (!live.enabled || !engine) return false;
    if (!knownSites(live).includes(siteId)) return false;
    if (!coverGatesPass(live, engine, siteId)) return false;
    return initialLoadDoneFor(engine, siteId, kind);
  } catch {
    return false;
  }
}
