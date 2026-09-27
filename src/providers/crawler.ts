// Motor da raspagem total (Fase 3/4): orquestra fila, ritmo, teto, freio,
// retomada, pausa automática e ciclo descoberta/incremental. Adaptadores em
// `crawl-sites/*`. Invariantes: serial (1 site/URL); `delayMs`+`maxPerHour`+
// freio de tráfego; cursor incremental POR KIND (F2: `cursor:movie` /
// `cursor:tv_show` no `crawl_state`, com migração do cursor legado único) só
// com a descoberta do kind completa; retomada de
// `inflight` no start E na 1ª passagem após religar ao vivo (enabled
// false→true, mesmo com pending na fila); pausa auto (streak/canário) +
// manual. Fase 4: knobs ao vivo (`crawler-live`). Fase 6: cursor incremental
// PERSISTIDO no `crawl.db` (`crawl_state`) — restart retoma incremental sem
// recarregar o acervo; descoberta PARCIAL não agenda como completa (volta no
// retry curto, não no intervalo inteiro).
import * as crawlerLive from '../utils/crawler-live.js';
import * as store from '../utils/crawl-store.js';
import * as activity from './activity.js';
import { CrawlPausePolicy } from './crawl-pauses.js';
import { processCrawlPage } from './crawl-page.js';
import { freshCycle } from './crawl-cycle.js';
import type { CycleCounters } from './crawl-cycle.js';
import * as recovery from './crawl-recovery.js';
import { buildCrawlerStatus } from './crawl-status.js';
import { createCrawlActions } from './crawl-actions.js';
import * as registry from './crawl-sites/registry.js';
import { createCrawlScheduler } from './crawl-scheduler.js';
import { createCostMeter, createHourCounter } from './crawl-rate.js';
import { advanceCursors, discoveryCuts, loadCursorsFromStore, type CursorMap } from './crawl-cursor.js';
import { DEFAULT_RETRY_BASE_MS } from '../utils/crawl-store-rules.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { AutoPauseReason, PauseLimits } from './crawl-pauses.js';
import { seriesLimitsOf, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { CrawlSite, CrawlUrlRow } from './crawl-types.js';

// --- Estado do motor ---------------------------------------------------------

let started = false;
let busy = false;
/** Pausa MANUAL: não persiste — restart volta ao .env. */
let paused = false;
/** Pausa automática (streak/canário): limpa só por `setPaused(false)`. */
let autoPause: { reason: AutoPauseReason; at: number; detail: string } | null = null;
// Cursor incremental POR KIND (F2), chaves `cursor:movie`/`cursor:tv_show` —
// migração do legado e avanço seguro por kind em `crawl-cursor.ts`.
const cursors: CursorMap = { movie: '', tv_show: '' };
let openRunId: number | null = null;
let nextDiscoverAt = 0;
/** A descoberta da rodada aberta veio parcial (Fase 6: fecha em retry curto). */
let discoveryPartial = false;
let lastRequestAt = 0;
/** 1ª passagem após enabled false→true: requeue inflight mesmo com pending. */
let needInflightRecovery = false;
let liveWasEnabled = false;
/** Dry-run desligou (true→false): requeue das `simulated`, one-shot. LEGADO:
 * `done` antigas de dry-run não são recuperadas — ver crawl-recovery.ts. */
let needSimulatedRecovery = false;
let liveWasDryRun: boolean | null = null;
/** Passada de `simulated` já rodou neste processo. Boot DESABILITADO com
 * dry-run desligado adia a passada para a 1ª step pós-enable. */
let simulatedRecoveryDone = false;

let cycle = freshCycle();
const policy = new CrawlPausePolicy();
const hourPages = createHourCounter();
const costMeter = createCostMeter();

function limits(live: CrawlerEffectiveConfig): PauseLimits {
  return { errorPauseStreak: live.errorPauseStreak, layoutCanary: live.layoutCanary };
}

function triggerAutoPause(reason: AutoPauseReason, detail: string): void {
  autoPause = { reason, at: Date.now(), detail: String(detail || '').slice(0, 200) };
  metrics.count(reason === 'layout' ? 'crawl.paused.layout' : 'crawl.paused.error-streak');
  log.warn(`[crawl] pausa automática (${reason}):`, autoPause.detail);
}

/** Garante o adaptador do site ativo — memoização e resolução no registro
 * (`crawl-sites/registry.ts`); o motor só consome. */
const ensureActiveSite = registry.ensureActiveSite;

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
  // F2: fase e corte POR KIND (ver `crawl-cursor.ts`) — série sem cursor
  // começa `initial` mesmo com filmes incrementais.
  const { phase, sinceByKind } = discoveryCuts(cursors);
  openRunId = store.engine().startRun(site.id, phase, cursors.movie, now);
  cycle = freshCycle();
  discoveryPartial = false;
  try {
    const discovery = await site.discover(sinceByKind.movie, {
      series: seriesLimitsOf(live),
      sinceByKind,
    });
    const report = store.engine().upsertUrls(site.id, discovery.urls, now);
    cycle.discoveryAdded = report.added;
    cycle.discoveryRefreshed = report.refreshed;
    // F2: o cursor de CADA kind anda só com a descoberta DELE completa —
    // parcial de um sitemap não trava o avanço seguro do outro.
    advanceCursors(site.id, discovery, cursors);
    if (discovery.complete) {
      policy.observeSiteSuccess();
      metrics.count('crawl.discovery.ok');
      if (report.added) metrics.count('crawl.discovery.added', report.added);
    } else {
      cycle.discoveryFailures = discovery.failures.length;
      // Parcial NÃO agenda como completa: a releitura volta no prazo curto de
      // retry (ver `step`). Os cursores dos kinds completos JÁ andaram (F2).
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
    // Falha total: re-tenta em breve (base do backoff), não no ciclo incremental.
    closeRun(DEFAULT_RETRY_BASE_MS);
  }
}

/** Processa UMA página reclamada e alimenta a política de pausa. */
async function processClaimed(site: CrawlSite, row: CrawlUrlRow, live: CrawlerEffectiveConfig): Promise<void> {
  lastRequestAt = Date.now();
  const outcome = await processCrawlPage(site, row, { dryRun: live.dryRun, maxTries: live.maxTries, series: seriesLimitsOf(live) });
  // Fase 7: o teto por hora cobra o custo REAL da página, não 1 por página.
  const cost = Math.max(1, Math.trunc(Number(outcome.requestCost ?? 1)));
  hourPages.note(cost);
  costMeter.note(cost);
  cycle.pages += 1;
  if (outcome.kind === 'done') {
    cycle.done += 1;
    cycle.releases += outcome.releases;
    cycle.newReleases += outcome.addedNew ?? 0;
  } else if (outcome.kind === 'simulated') { cycle.simulated += 1; cycle.releases += outcome.releases; } else if (outcome.kind === 'no-torrent') cycle.noTorrent += 1;
  else if (outcome.kind === 'no-work') cycle.noWork += 1;
  else cycle.errors += 1;
  const reason = policy.observePage(row.url, {
    kind: outcome.kind, siteLevelError: outcome.siteLevelError, releases: outcome.releases,
  }, limits(live));
  if (reason) triggerAutoPause(reason, outcome.detail || row.url);
}

/** Um passo: descoberta quando devida, senão uma página. */
async function step(site: CrawlSite, live: CrawlerEffectiveConfig): Promise<void> {
  // Recuperações ANTES do takeNext (one-shot; simulated reabre rodada com
  // nextDiscoverAt = 0, senão o pending novo esperaria o ciclo incremental):
  if (needInflightRecovery) { needInflightRecovery = false; recovery.requeueInflight(site.id); }
  if (needSimulatedRecovery) {
    needSimulatedRecovery = false;
    simulatedRecoveryDone = true;
    if (recovery.requeueSimulated(site.id)) { nextDiscoverAt = 0; discoveryPartial = false; }
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
    if (next.enabled && !liveWasEnabled) {
      needInflightRecovery = true;
      // Boot desabilitado adiou a passada de `simulated`: roda na 1ª step.
      if (!simulatedRecoveryDone && next.dryRun === false) needSimulatedRecovery = true;
    }
    if (liveWasDryRun === true && next.dryRun === false) needSimulatedRecovery = true;
    liveWasEnabled = next.enabled; liveWasDryRun = next.dryRun;
    scheduler.sync(next);
  });
  const live = crawlerLive.effective();
  liveWasEnabled = live.enabled;
  liveWasDryRun = live.dryRun;
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
  recovery.requeueInflight(siteId);
  needInflightRecovery = false;
  // Restart já COM dry-run desligado: recupera `simulated` sobrevivente a crash
  // antes do switch (mesmo one-shot do caminho ao vivo). Boot DESABILITADO não
  // roda aqui — a passada fica para a primeira `step` após o false→true.
  if (live.dryRun === false) { recovery.requeueSimulated(siteId); simulatedRecoveryDone = true; }
  // Fase 6/2: cursores duráveis POR KIND — restart retoma o incremental do
  // estado persistido, sem reprocessar o acervo (migração do legado incluso).
  loadCursorsFromStore(siteId, cursors);
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
  cursors.movie = '';
  cursors.tv_show = '';
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
  const { site: activeSite, id: activeSiteId } = registry.active();
  return buildCrawlerStatus(store.currentEngine(), live, configuredSites, {
    activeSiteId,
    activeLabel: activeSite ? activeSite.label : null,
    paused,
    autoPause,
    cursors: { ...cursors },
    nextDiscoveryAt: nextDiscoverAt,
    pagesThisHour: hourPages.current(),
    openRunId,
    errorStreak: policy.errorStreakCount,
    canaryStreak: policy.canaryStreakCount,
    cycle: { ...cycle },
    currentSiteNewReleases: cycle.newReleases,
    siteReady: Boolean(activeSite),
    // ETA honesto (M1): custo médio observado; sem página medida é null.
    avgRequestCost: costMeter.avg(),
  });
}

// --- Ganchos de teste --------------------------------------------------------

/** Injeta adaptadores dublês (o motor não toca o Vaca real). */
export function _setSitesForTest(factory: ((id: string) => CrawlSite | null) | null): void {
  registry.setFactoryForTest(factory);
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
  registry.setFactoryForTest(null);
  cursors.movie = '';
  cursors.tv_show = '';
  openRunId = null;
  nextDiscoverAt = 0;
  discoveryPartial = false;
  lastRequestAt = 0;
  cycle = freshCycle();
  hourPages.clear();
  costMeter.reset();
  policy.reset();
  needInflightRecovery = false;
  liveWasEnabled = false;
  liveWasDryRun = null;
  needSimulatedRecovery = false;
  simulatedRecoveryDone = false;
  crawlerLive.onConfigChange(null);
}

export { start, tick, status, setPaused, simulate, reprocessErrors, resetSite };
export default { start, tick, status, setPaused, simulate, reprocessErrors, resetSite };
