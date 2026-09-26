// Motor da raspagem total dos sites BR (plano "Raspagem total", Fase 3). O
// adaptador de cada site sabe DESCOBRIR URLs e PROCESSAR uma página
// (`crawl-sites/*`); aqui mora a ORQUESTRAÇÃO: fila, ritmo, teto horário,
// freio de tráfego, retomada, pausa automática, status e o desfecho do ciclo
// de descoberta/incremental.
//
// Invariantes da fase (não negociáveis):
//
//   - UM site e UMA URL por vez. O processo é serial de propósito: o crawl não
//     disputa FlareSolverr nem a busca ao vivo (o adaptador usa fetch DIRETO).
//     O piloto configura um site (`CRAWL_SITES`); ids extras ficam para a fase
//     multi-site e são ignorados com aviso.
//   - Ritmo: `CRAWL_DELAY_MS` entre requisições ao site (o timer do start usa o
//     mesmo valor como cadência) + teto `CRAWL_MAX_PER_HOUR` + freio
//     `activity.recentUserTraffic(CRAWL_IDLE_WINDOW_MS)` — tráfego de usuário
//     preempta a raspagem.
//   - Descoberta: upsert idempotente no `crawl.db`. O cursor incremental SÓ
//     avança com `complete: true`; descoberta parcial pode ter perdido o
//     lastmod que mudou, então o cursor fica e o próximo ciclo relê.
//   - Retomada: no start, TODO `inflight` é órfão do processo anterior (processo
//     novo não tem requisição em voo) e volta a `pending`.
//   - Pausa automática: streak de erros de site e canário de layout (política
//     pura em `crawl-pauses.ts`); qualquer um dos dois + a pausa manual param
//     o tick.
//
// Cursor em MEMÓRIA: após restart o ciclo recomeça como carga inicial
// (relê o sitemap inteiro, upsert idempotente) — não é perda de dados, só uma
// passada de descoberta a mais; documentado e sem novo verbo no store.
import config from '../config.js';
import * as store from '../utils/crawl-store.js';
import * as activity from './activity.js';
import { CrawlPausePolicy, maxLastmod } from './crawl-pauses.js';
import { processCrawlPage } from './crawl-page.js';
import { DEFAULT_RETRY_BASE_MS } from '../utils/crawl-store-rules.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { AutoPauseReason, PauseLimits } from './crawl-pauses.js';
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
let timer: NodeJS.Timeout | null = null;
let activeSite: CrawlSite | null = null;
let activeSiteId = '';
let adapterWarned = false;
let cursor = '';
let openRunId: number | null = null;
let nextDiscoverAt = 0;
let lastRequestAt = 0;

interface CycleCounters {
  pages: number; done: number; noTorrent: number; noWork: number; errors: number; releases: number;
  discoveryAdded: number; discoveryRefreshed: number; discoveryFailures: number;
}

function freshCycle(): CycleCounters {
  return {
    pages: 0, done: 0, noTorrent: 0, noWork: 0, errors: 0, releases: 0,
    discoveryAdded: 0, discoveryRefreshed: 0, discoveryFailures: 0,
  };
}

let cycle = freshCycle();
const policy = new CrawlPausePolicy();
const hourPages = new Map<number, number>();

function limits(): PauseLimits {
  return { errorPauseStreak: config.crawl.errorPauseStreak, layoutCanary: config.crawl.layoutCanary };
}

/** Cadência do timer: acompanha o delay, com piso (não martelar) e teto. */
function intervalMs(): number {
  return Math.max(500, Math.min(config.crawl.delayMs, 60_000));
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
function closeRun(siteId: string, nextDelayMs: number): void {
  if (openRunId == null) return;
  store.engine().finishRun(openRunId, Date.now(), { ...cycle });
  openRunId = null;
  nextDiscoverAt = Date.now() + Math.max(0, nextDelayMs);
  cycle = freshCycle();
}

/** Rodada de descoberta: upsert no store e, se completa, avanço do cursor. */
async function runDiscovery(site: CrawlSite): Promise<void> {
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
    const reason = policy.observeSiteFailure(message, limits());
    if (reason) triggerAutoPause(reason, message);
    // Falha total: fecha a rodada e re-tenta em breve (base do backoff do store),
    // em vez de esperar o ciclo incremental inteiro.
    closeRun(site.id, DEFAULT_RETRY_BASE_MS);
  }
}

/** Processa UMA página reclamada e alimenta a política de pausa. */
async function processClaimed(site: CrawlSite, row: CrawlUrlRow): Promise<void> {
  lastRequestAt = Date.now();
  notePage();
  const outcome = await processCrawlPage(site, row);
  cycle.pages += 1;
  if (outcome.kind === 'done') { cycle.done += 1; cycle.releases += outcome.releases; }
  else if (outcome.kind === 'no-torrent') cycle.noTorrent += 1;
  else if (outcome.kind === 'no-work') cycle.noWork += 1;
  else cycle.errors += 1;
  const reason = policy.observePage(row.url, outcome, limits());
  if (reason) triggerAutoPause(reason, outcome.detail || row.url);
}

/** Um passo: descoberta quando devida, senão uma página. */
async function step(site: CrawlSite): Promise<void> {
  if (openRunId == null) {
    const counters = store.engine().counters(site.id);
    if (counters.total === 0 || Date.now() >= nextDiscoverAt) {
      await runDiscovery(site);
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
      if (row) await processClaimed(site, row);
    }
    return;
  }

  const row = store.engine().takeNext(site.id, Date.now());
  if (!row) {
    closeRun(site.id, config.crawl.incrementalIntervalMin * 60_000);
    return;
  }
  await processClaimed(site, row);
}

/**
 * Um ciclo do motor. Exportado para o teste dirigir o passo sem timer real.
 * Os guards rodam ANTES de qualquer requisição para o freio não ser furado.
 */
async function tick(): Promise<void> {
  if (!config.crawl.enabled || paused || autoPause || busy) return;
  const cfg = config.crawl;
  const siteId = String(cfg.sites[0] || '');
  if (!siteId) return;
  const site = await ensureActiveSite(siteId);
  if (!site) return;
  if (pagesThisHour() >= cfg.maxPerHour) return;
  if (activity.recentUserTraffic(cfg.idleWindowMs)) return;
  if (Date.now() - lastRequestAt < cfg.delayMs) return;
  busy = true;
  try {
    await step(site);
  } finally {
    busy = false;
  }
}

/** Arma o motor. Sticky e só liga com CRAWL_ENABLED=true. */
function start(): void {
  if (started) return;
  started = true;
  if (!config.crawl.enabled) {
    log.info('[crawl] desativado (CRAWL_ENABLED=false)');
    return;
  }
  const siteId = String(config.crawl.sites[0] || '');
  if (!siteId) {
    log.warn('[crawl] nenhum site configurado em CRAWL_SITES');
    return;
  }
  // Retomada: processo novo não tem requisição em voo, então TODO inflight é
  // órfão do processo anterior — volta a pending e é reclamado no tick.
  const recovered = store.engine().requeueInflight(siteId, 0, Date.now());
  if (recovered) log.info(`[crawl] ${recovered} URL(s) inflight retomada(s) do processo anterior`);
  timer = setInterval(() => { tick().catch((err) => log.warn('[crawl] tick falhou:', log.errorMessage(err))); }, intervalMs());
  timer.unref();
  log.info(`[crawl] motor armado (site=${siteId}, delay=${config.crawl.delayMs}ms, dryRun=${config.crawl.dryRun})`);
}

/** Pausa manual; desligar limpa também a pausa automática (consentimento do operador). */
function setPaused(value: boolean): { paused: boolean; autoPause: { reason: AutoPauseReason } | null } {
  paused = Boolean(value);
  if (!paused) autoPause = null;
  return { paused, autoPause: autoPause ? { reason: autoPause.reason } : null };
}

/** Foto do motor para o painel — sem credencial e sem segredo. */
function status() {
  const cfg = config.crawl;
  const engine = store.currentEngine();
  const siteId = activeSiteId || String(cfg.sites[0] || '');
  return {
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    paused,
    autoPause: autoPause ? { reason: autoPause.reason, at: autoPause.at, detail: autoPause.detail } : null,
    site: siteId || null,
    siteReady: Boolean(activeSite),
    engine: engine ? engine.kind : null,
    cursor: cursor || null,
    pagesThisHour: pagesThisHour(),
    maxPerHour: cfg.maxPerHour,
    delayMs: cfg.delayMs,
    idleWindowMs: cfg.idleWindowMs,
    errorStreak: policy.errorStreakCount,
    canaryStreak: policy.canaryStreakCount,
    runOpen: openRunId != null,
    cycle: { ...cycle },
    counters: engine && siteId ? engine.counters(siteId) : null,
    latestRun: engine && siteId ? engine.latestRun(siteId) : null,
  };
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
  if (timer) clearInterval(timer);
  timer = null;
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
}

export { start, tick, status, setPaused };
export default { start, tick, status, setPaused };
