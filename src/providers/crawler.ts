// Motor da raspagem total (Fase 3/4): orquestra fila, ritmo, teto, freio,
// retomada, pausa automática e ciclo descoberta/incremental. Adaptadores em
// `crawl-sites/*`. Invariantes: serial (1 site/URL); `delayMs`+`maxPerHour`+
// freio de tráfego; cursor incremental só com `complete`; retomada de
// `inflight` no start E na 1ª passagem após religar ao vivo (enabled
// false→true, mesmo com pending na fila); pausa auto (streak/canário) +
// manual. Fase 4: knobs ao vivo (`crawler-live`). Fase 6: cursor incremental
// PERSISTIDO no `crawl.db` (`crawl_state`) — restart retoma incremental sem
// recarregar o acervo; descoberta PARCIAL não agenda como completa (volta no
// retry curto, não no intervalo inteiro).
import * as crawlerLive from '../utils/crawler-live.js';
import * as store from '../utils/crawl-store.js';
import * as activity from './activity.js';
import { CrawlPausePolicy, maxLastmod } from './crawl-pauses.js';
import { processCrawlPage } from './crawl-page.js';
import { buildCrawlerStatus } from './crawl-status.js';
import { createCrawlActions } from './crawl-actions.js';
import { createCrawlScheduler } from './crawl-scheduler.js';
import { createHourCounter } from './crawl-rate.js';
import { DEFAULT_RETRY_BASE_MS } from '../utils/crawl-store-rules.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { AutoPauseReason, PauseLimits } from './crawl-pauses.js';
import type { CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { CrawlSite, CrawlUrlRow } from './crawl-types.js';

// --- Registro de adaptadores -------------------------------------------------

let testSiteFactory: ((id: string) => CrawlSite | null) | null = null;

/** Fábrica de teste vence; produção resolve Vaca por import dinâmico. */
async function resolveSite(id: string): Promise<CrawlSite | null> {
  if (testSiteFactory) return testSiteFactory(id);
  if (id === 'vacatorrent') {
    const { vacaCrawlSite } = await import('./crawl-sites/vaca.js');
    return vacaCrawlSite();
  }
  return null;
}

// --- Estado do motor ---------------------------------------------------------

let started = false;
let busy = false;
/** Pausa MANUAL: não persiste — restart volta ao .env. */
let paused = false;
/** Pausa automática (streak/canário): limpa só por `setPaused(false)`. */
let autoPause: { reason: AutoPauseReason; at: number; detail: string } | null = null;
let activeSite: CrawlSite | null = null;
let activeSiteId = '';
let adapterWarned = false;
let cursor = '';
/** Chave do cursor incremental no estado durável do site (`crawl_state`). */
const CURSOR_KEY = 'cursor';
let openRunId: number | null = null;
let nextDiscoverAt = 0;
/** A descoberta da rodada aberta veio parcial (Fase 6: fecha em retry curto). */
let discoveryPartial = false;
let lastRequestAt = 0;
/** 1ª passagem após enabled false→true: requeue inflight mesmo com pending. */
let needInflightRecovery = false;
let liveWasEnabled = false;

interface CycleCounters {
  pages: number; done: number; noTorrent: number; noWork: number; errors: number; releases: number;
  newReleases: number; discoveryAdded: number; discoveryRefreshed: number; discoveryFailures: number;
}

function freshCycle(): CycleCounters {
  return {
    pages: 0, done: 0, noTorrent: 0, noWork: 0, errors: 0, releases: 0,
    newReleases: 0, discoveryAdded: 0, discoveryRefreshed: 0, discoveryFailures: 0,
  };
}

let cycle = freshCycle();
const policy = new CrawlPausePolicy();
const hourPages = createHourCounter();

function limits(live: CrawlerEffectiveConfig): PauseLimits {
  return { errorPauseStreak: live.errorPauseStreak, layoutCanary: live.layoutCanary };
}

function triggerAutoPause(reason: AutoPauseReason, detail: string): void {
  autoPause = { reason, at: Date.now(), detail: String(detail || '').slice(0, 200) };
  metrics.count(reason === 'layout' ? 'crawl.paused.layout' : 'crawl.paused.error-streak');
  log.warn(`[crawl] pausa automática (${reason}):`, autoPause.detail);
}

/** Garante o adaptador do site ativo (resolve uma vez e memoiza). */
async function ensureActiveSite(siteId: string): Promise<CrawlSite | null> {
  if (activeSite && activeSiteId === siteId) return activeSite;
  try {
    const site = await resolveSite(siteId);
    if (!site) {
      if (!adapterWarned) { adapterWarned = true; log.warn(`[crawl] site sem adaptador: ${siteId}`); }
      return null;
    }
    activeSite = site;
    activeSiteId = siteId;
    adapterWarned = false;
    return site;
  } catch (err: unknown) {
    if (!adapterWarned) {
      adapterWarned = true;
      log.error(`[crawl] adaptador ${siteId} indisponível:`, log.errorMessage(err));
    }
    return null;
  }
}

/** Fecha a rodada aberta (se houver) e agenda a próxima descoberta. */
function closeRun(nextDelayMs: number): void {
  if (openRunId == null) return;
  store.engine().finishRun(openRunId, Date.now(), { ...cycle });
  openRunId = null;
  nextDiscoverAt = Date.now() + Math.max(0, nextDelayMs);
  cycle = freshCycle();
}

/** Rodada de descoberta: upsert no store e, se completa, avanço do cursor. */
async function runDiscovery(site: CrawlSite, live: CrawlerEffectiveConfig): Promise<void> {
  const now = Date.now();
  lastRequestAt = now;
  const phase = cursor ? 'incremental' : 'initial';
  openRunId = store.engine().startRun(site.id, phase, cursor, now);
  cycle = freshCycle();
  discoveryPartial = false;
  try {
    const discovery = await site.discover(phase === 'incremental' ? cursor : null);
    const report = store.engine().upsertUrls(site.id, discovery.urls, now);
    cycle.discoveryAdded = report.added;
    cycle.discoveryRefreshed = report.refreshed;
    if (discovery.complete) {
      // Cursor só anda com descoberta COMPLETA: parcial pode ter perdido o
      // lastmod novo, e avançar por cima disso o deixaria invisível para sempre.
      const max = maxLastmod(discovery.urls);
      if (max) {
        cursor = max;
        // Fase 6: cursor durável — restart retoma incremental sem refazer a
        // carga inicial inteira.
        store.engine().setState(site.id, CURSOR_KEY, max);
      }
      policy.observeSiteSuccess();
      metrics.count('crawl.discovery.ok');
      if (report.added) metrics.count('crawl.discovery.added', report.added);
    } else {
      cycle.discoveryFailures = discovery.failures.length;
      // Parcial NÃO agenda como completa: quando a fila desta rodada drenar,
      // a releitura volta no prazo curto de retry (ver `step`), não no ciclo
      // incremental inteiro — o pedaço perdido do sitemap não espera 1h.
      discoveryPartial = true;
      metrics.count('crawl.discovery.partial');
      log.warn('[crawl] descoberta parcial:', discovery.failures.join(' | ').slice(0, 400));
    }
  } catch (err: unknown) {
    const message = log.errorMessage(err);
    cycle.discoveryFailures += 1;
    metrics.count('crawl.discovery.error');
    log.warn('[crawl] descoberta falhou:', message);
    const reason = policy.observeSiteFailure(message, limits(live));
    if (reason) triggerAutoPause(reason, message);
    // Falha total: fecha a rodada e re-tenta em breve (base do backoff do store),
    // em vez de esperar o ciclo incremental inteiro.
    closeRun(DEFAULT_RETRY_BASE_MS);
  }
}

/** Processa UMA página reclamada e alimenta a política de pausa. */
async function processClaimed(site: CrawlSite, row: CrawlUrlRow, live: CrawlerEffectiveConfig): Promise<void> {
  lastRequestAt = Date.now();
  hourPages.note();
  const outcome = await processCrawlPage(site, row, { dryRun: live.dryRun, maxTries: live.maxTries });
  cycle.pages += 1;
  if (outcome.kind === 'done') {
    cycle.done += 1;
    cycle.releases += outcome.releases;
    cycle.newReleases += outcome.addedNew ?? 0;
  } else if (outcome.kind === 'no-torrent') cycle.noTorrent += 1;
  else if (outcome.kind === 'no-work') cycle.noWork += 1;
  else cycle.errors += 1;
  const reason = policy.observePage(row.url, {
    kind: outcome.kind, siteLevelError: outcome.siteLevelError, releases: outcome.releases,
  }, limits(live));
  if (reason) triggerAutoPause(reason, outcome.detail || row.url);
}

/** Um passo: descoberta quando devida, senão uma página. */
async function step(site: CrawlSite, live: CrawlerEffectiveConfig): Promise<void> {
  // Religar: órfã volta ANTES do takeNext (mesmo com pending — idle path não cobre).
  if (needInflightRecovery) {
    needInflightRecovery = false;
    const n = store.engine().requeueInflight(site.id, 0, Date.now());
    if (n > 0) log.info(`[crawl] ${n} URL(s) inflight retomada(s) ao religar`);
  }
  if (openRunId == null) {
    const counters = store.engine().counters(site.id);
    if (counters.total === 0 || Date.now() >= nextDiscoverAt) {
      await runDiscovery(site, live);
      return;
    }
    // Ocioso: tick serial ⇒ inflight aqui é órfão; devolve e tenta o vencido.
    if (counters.byStatus.inflight > 0) {
      const recovered = store.engine().requeueInflight(site.id, 0, Date.now());
      if (recovered > 0) log.warn(`[crawl] ${recovered} URL(s) inflight órfã(s) devolvida(s)`);
    }
    if (counters.byStatus.error > 0 || counters.byStatus.inflight > 0) {
      const row = store.engine().takeNext(site.id, Date.now());
      if (row) await processClaimed(site, row, live);
    }
    return;
  }

  const row = store.engine().takeNext(site.id, Date.now());
  if (!row) {
    // Fila esgotada: fecha a rodada (initial OU incremental); parcial agenda
    // retry curto, nunca como se a descoberta tivesse coberto tudo.
    closeRun(discoveryPartial ? DEFAULT_RETRY_BASE_MS : live.incrementalIntervalMin * 60_000);
    return;
  }
  await processClaimed(site, row, live);
}

// Timer rearmável (Fase 4): cadência viva; painel muda sem restart.
const scheduler = createCrawlScheduler({
  isStarted: () => started,
  tick: () => tick(),
  warn: (message) => log.warn('[crawl] tick falhou:', message),
  onDisabled: () => log.info('[crawl] desativado pela config ao vivo (enabled=false)'),
});

/** Um ciclo do motor. Exportado para o teste dirigir o passo sem timer real. */
async function tick(): Promise<void> {
  const live = crawlerLive.effective();
  // Rearma antes de retorno precoce (cadência não fica presa a freio/pausa).
  scheduler.rearm(live);
  if (!live.enabled || paused || autoPause || busy) return;
  const siteId = String(live.sites[0] || '');
  if (!siteId) return;
  const site = await ensureActiveSite(siteId);
  if (!site) return;
  if (hourPages.current() >= live.maxPerHour) return;
  if (activity.recentUserTraffic(live.idleWindowMs)) return;
  if (Date.now() - lastRequestAt < live.delayMs) return;
  busy = true;
  try {
    await step(site, live);
  } finally {
    busy = false;
  }
}

/** Arma o motor. Sticky; só ativa com a config viva habilitada. */
function start(): void {
  if (started) return;
  started = true;
  crawlerLive.onConfigChange(() => {
    const next = crawlerLive.effective();
    if (next.enabled && !liveWasEnabled) needInflightRecovery = true;
    liveWasEnabled = next.enabled;
    scheduler.sync(next);
  });
  const live = crawlerLive.effective();
  liveWasEnabled = live.enabled;
  if (!live.enabled) {
    log.info('[crawl] desativado (enabled=false)');
    return;
  }
  const siteId = String(live.sites[0] || '');
  if (!siteId) {
    log.warn('[crawl] nenhum site configurado em CRAWL_SITES');
    return;
  }
  // Start: processo novo ⇒ todo inflight é órfão. Painel usa needInflightRecovery.
  const recovered = store.engine().requeueInflight(siteId, 0, Date.now());
  if (recovered) log.info(`[crawl] ${recovered} URL(s) inflight retomada(s) do processo anterior`);
  needInflightRecovery = false;
  // Fase 6: cursor durável — restart retoma o incremental do estado
  // persistido, sem reprocessar o acervo como carga inicial.
  const savedCursor = store.engine().getState(siteId, CURSOR_KEY);
  if (savedCursor) {
    cursor = savedCursor;
    log.info(`[crawl] cursor incremental restaurado do crawl.db (${savedCursor})`);
  }
  scheduler.rearm(live);
  log.info(`[crawl] motor armado (site=${siteId}, delay=${live.delayMs}ms, dryRun=${live.dryRun})`);
}

/** Pausa manual; desligar limpa também a pausa automática (consentimento do operador). */
function setPaused(value: boolean): { paused: boolean; autoPause: { reason: AutoPauseReason } | null } {
  paused = Boolean(value);
  if (!paused) autoPause = null;
  metrics.count(paused ? 'crawl.pause' : 'crawl.resume');
  return { paused, autoPause: autoPause ? { reason: autoPause.reason } : null };
}

// --- Fase 4: ações do painel -------------------------------------------------

/** ids dos sites vivos (config ao vivo), sem credencial. */
function siteIds(): string[] {
  return crawlerLive.effective().sites.map((s) => String(s || '')).filter(Boolean);
}

/** Descarta o ciclo aberto (o "Zerar site" apaga a rodada do store). */
function forgetActiveRun(): void {
  openRunId = null;
  cycle = freshCycle();
  cursor = '';
  nextDiscoverAt = 0;
  discoveryPartial = false;
}

// As ações (simular/reprocessar/zerar) moram em `crawl-actions.ts`; o motor
// injeta as closures — o módulo não importa `crawler.ts`, sem ciclo.
const { simulate, reprocessErrors, resetSite } = createCrawlActions({
  effective: () => crawlerLive.effective(),
  isBusy: () => busy,
  isPaused: () => paused || Boolean(autoPause),
  ensureSite: (id) => ensureActiveSite(id),
  forgetActiveRun,
  count: (name, value) => metrics.count(name, value),
});

// --- Status ------------------------------------------------------------------

/** Foto do motor para o painel — sem credencial e sem segredo. A montagem do
 * formato (cards por site, ETA, listas) mora em `crawl-status.ts` (pura). */
function status() {
  const live = crawlerLive.effective();
  const configuredSites = siteIds();
  return buildCrawlerStatus(store.currentEngine(), live, configuredSites, {
    activeSiteId,
    activeLabel: activeSite ? activeSite.label : null,
    paused,
    autoPause,
    cursor,
    nextDiscoveryAt: nextDiscoverAt,
    pagesThisHour: hourPages.current(),
    openRunId,
    errorStreak: policy.errorStreakCount,
    canaryStreak: policy.canaryStreakCount,
    cycle: { ...cycle },
    currentSiteNewReleases: cycle.newReleases,
    siteReady: Boolean(activeSite),
  });
}

// --- Ganchos de teste --------------------------------------------------------

/** Injeta adaptadores dublês (o motor não toca o Vaca real). */
export function _setSitesForTest(factory: ((id: string) => CrawlSite | null) | null): void {
  testSiteFactory = factory;
  activeSite = null;
  activeSiteId = '';
  adapterWarned = false;
}

/** Zera o relógio da próxima descoberta (o teste não espera 60 min). */
export function _forceDiscoveryForTest(): void {
  nextDiscoverAt = 0;
}

/** Estado limpo entre casos (o processo sobe `start()` uma vez só). */
export function _resetForTest(): void {
  scheduler.disarm();
  started = false;
  busy = false;
  paused = false;
  autoPause = null;
  activeSite = null;
  activeSiteId = '';
  adapterWarned = false;
  cursor = '';
  openRunId = null;
  nextDiscoverAt = 0;
  discoveryPartial = false;
  lastRequestAt = 0;
  cycle = freshCycle();
  hourPages.clear();
  policy.reset();
  testSiteFactory = null;
  needInflightRecovery = false;
  liveWasEnabled = false;
  crawlerLive.onConfigChange(null);
}

export { start, tick, status, setPaused, simulate, reprocessErrors, resetSite };
export default { start, tick, status, setPaused, simulate, reprocessErrors, resetSite };
