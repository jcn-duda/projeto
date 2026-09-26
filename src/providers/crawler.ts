// Motor da raspagem total dos sites BR (plano "Raspagem total", Fase 3/4). O
// adaptador de cada site sabe DESCOBRIR URLs e PROCESSAR uma página
// (`crawl-sites/*`); aqui mora a ORQUESTRAÇÃO: fila, ritmo, teto horário,
// freio de tráfego, retomada, pausa automática, status e o desfecho do ciclo
// de descoberta/incremental.
//
// Invariantes da fase (não negociáveis):
//
//   - UM site e UMA URL por vez. O processo é serial de propósito: o crawl não
//     disputa FlareSolverr nem a busca ao vivo (o adaptador usa fetch DIRETO).
//   - Ritmo: `delayMs` entre requisições ao site (o timer usa o mesmo valor
//     como cadência) + teto `maxPerHour` + freio
//     `activity.recentUserTraffic(idleWindowMs)` — tráfego de usuário preempta.
//   - Descoberta: upsert idempotente no `crawl.db`. O cursor incremental SÓ
//     avança com `complete: true`; descoberta parcial pode ter perdido o
//     lastmod que mudou, então o cursor fica e o próximo ciclo relê.
//   - Retomada: no start, TODO `inflight` é órfão do processo anterior (processo
//     novo não tem requisição em voo) e volta a `pending`.
//   - Pausa automática: streak de erros de site e canário de layout (política
//     pura em `crawl-pauses.ts`); qualquer um dos dois + a pausa manual param
//     o tick.
//
// Fase 4: TODO knob de decisão vem da config ao VIVO (`crawler-live.ts`),
// capturada UMA vez por tick (snapshot coerente) e repassada adiante — ligar,
// pausar, mudar ritmo/dry-run pelo painel não exige restart. A pausa manual é
// volátil por desenho (restart volta ao `.env`); os knobs persistem em
// `cfg:v1:crawler`.
//
// Cursor em MEMÓRIA: após restart o ciclo recomeça como carga inicial (relê o
// sitemap inteiro, upsert idempotente) — não é perda de dados, só uma passada
// de descoberta a mais; documentado e sem novo verbo no store.
import * as crawlerLive from '../utils/crawler-live.js';
import * as store from '../utils/crawl-store.js';
import * as activity from './activity.js';
import { CrawlPausePolicy, maxLastmod } from './crawl-pauses.js';
import { processCrawlPage } from './crawl-page.js';
import { buildCrawlerStatus } from './crawl-status.js';
import { createCrawlActions } from './crawl-actions.js';
import { createCrawlScheduler } from './crawl-scheduler.js';
import { DEFAULT_RETRY_BASE_MS } from '../utils/crawl-store-rules.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { AutoPauseReason, PauseLimits } from './crawl-pauses.js';
import type { CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { CrawlSite, CrawlUrlRow } from './crawl-types.js';

// --- Registro de adaptadores -------------------------------------------------

let testSiteFactory: ((id: string) => CrawlSite | null) | null = null;

/** Adaptador do id: a fábrica de teste vence; produção resolve o Vaca por
 * import DINÂMICO para o motor não arrastar o grafo dos resolvers nos testes. */
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
/** Pausa MANUAL (operacional): não persiste — restart volta ao .env. */
let paused = false;
/** Pausa automática (streak/canário): limpa só por `setPaused(false)`. */
let autoPause: { reason: AutoPauseReason; at: number; detail: string } | null = null;
let activeSite: CrawlSite | null = null;
let activeSiteId = '';
let adapterWarned = false;
let cursor = '';
let openRunId: number | null = null;
let nextDiscoverAt = 0;
let lastRequestAt = 0;

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
const hourPages = new Map<number, number>();

function limits(live: CrawlerEffectiveConfig): PauseLimits {
  return { errorPauseStreak: live.errorPauseStreak, layoutCanary: live.layoutCanary };
}

/** Páginas processadas na hora civil atual (teto horário). */
function pagesThisHour(): number {
  const hour = Math.floor(Date.now() / 3_600_000);
  for (const bucket of [...hourPages.keys()]) {
    if (bucket < hour) hourPages.delete(bucket);
  }
  return hourPages.get(hour) || 0;
}

function notePage(): void {
  const hour = Math.floor(Date.now() / 3_600_000);
  hourPages.set(hour, (hourPages.get(hour) || 0) + 1);
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
  try {
    const discovery = await site.discover(phase === 'incremental' ? cursor : null);
    const report = store.engine().upsertUrls(site.id, discovery.urls, now);
    cycle.discoveryAdded = report.added;
    cycle.discoveryRefreshed = report.refreshed;
    if (discovery.complete) {
      // Cursor só anda com descoberta COMPLETA: parcial pode ter perdido o
      // lastmod novo, e avançar por cima disso o deixaria invisível para sempre.
      const max = maxLastmod(discovery.urls);
      if (max) cursor = max;
      policy.observeSiteSuccess();
      metrics.count('crawl.discovery.ok');
      if (report.added) metrics.count('crawl.discovery.added', report.added);
    } else {
      cycle.discoveryFailures = discovery.failures.length;
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
  notePage();
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
  if (openRunId == null) {
    const counters = store.engine().counters(site.id);
    if (counters.total === 0 || Date.now() >= nextDiscoverAt) {
      await runDiscovery(site, live);
      return; // a página sai no próximo tick (ritmo entre requisições)
    }
    // Ocioso: só resta erro em backoff/inflight órfão. Como o tick é serial,
    // inflight neste ponto é órfão (o claim é sempre seguido do markResult) —
    // devolve à fila e tenta o vencido, SEM abrir ciclo novo.
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
    closeRun(live.incrementalIntervalMin * 60_000);
    return;
  }
  await processClaimed(site, row, live);
}

// Timer REARMÁVEL (Fase 4): a cadência mora na config ao vivo e o painel pode
// mudá-la sem restart. A fábrica isola o setInterval do resto do motor.
const scheduler = createCrawlScheduler({
  isStarted: () => started,
  tick: () => tick(),
  warn: (message) => log.warn('[crawl] tick falhou:', message),
  onDisabled: () => log.info('[crawl] desativado pela config ao vivo (enabled=false)'),
});


/**
 * Um ciclo do motor. Exportado para o teste dirigir o passo sem timer real.
 * Os guards rodam ANTES de qualquer requisição para o freio não ser furado.
 */
async function tick(): Promise<void> {
  const live = crawlerLive.effective();
  // Rearma ANTES de qualquer retorno precoce para uma mudança de cadência não
  // ficar adiada por um freio/pausa. Com `enabled=false` o `rearm` é no-op (quem
  // desarma é o `sync` via `onConfigChange`), então isto não religa o motor.
  scheduler.rearm(live);
  if (!live.enabled || paused || autoPause || busy) return;
  const siteId = String(live.sites[0] || '');
  if (!siteId) return;
  const site = await ensureActiveSite(siteId);
  if (!site) return;
  if (pagesThisHour() >= live.maxPerHour) return;
  if (activity.recentUserTraffic(live.idleWindowMs)) return;
  if (Date.now() - lastRequestAt < live.delayMs) return;
  busy = true;
  try {
    await step(site, live);
  } finally {
    busy = false;
  }
}

/** Arma o motor. Sticky e só ativa com a config viva habilitada. */
function start(): void {
  if (started) return;
  started = true;
  // live → crawler (callback); crawler já importa live — sem ciclo.
  crawlerLive.onConfigChange(() => scheduler.sync(crawlerLive.effective()));
  const live = crawlerLive.effective();
  if (!live.enabled) {
    log.info('[crawl] desativado (enabled=false)');
    return;
  }
  const siteId = String(live.sites[0] || '');
  if (!siteId) {
    log.warn('[crawl] nenhum site configurado em CRAWL_SITES');
    return;
  }
  // Retomada: processo novo não tem requisição em voo, então TODO inflight é
  // órfão do processo anterior — volta a pending e é reclamado no tick.
  const recovered = store.engine().requeueInflight(siteId, 0, Date.now());
  if (recovered) log.info(`[crawl] ${recovered} URL(s) inflight retomada(s) do processo anterior`);
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
    pagesThisHour: pagesThisHour(),
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
  lastRequestAt = 0;
  cycle = freshCycle();
  hourPages.clear();
  policy.reset();
  testSiteFactory = null;
  crawlerLive.onConfigChange(null);
}

export { start, tick, status, setPaused, simulate, reprocessErrors, resetSite };
export default { start, tick, status, setPaused, simulate, reprocessErrors, resetSite };
