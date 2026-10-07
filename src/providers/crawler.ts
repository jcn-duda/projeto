// Motor da raspagem total (Fase 3/4; Fase 8 MULTI-SITE). Orquestra fila,
// ritmo, teto, freio, retomada, pausa automática e ciclo descoberta/incremental
// para VÁRIOS sites, em PARALELO limitado (`crawl-dispatch.ts`). Adaptadores em
// `crawl-sites/*`.
//
// GLOBAL (aqui, e só aqui): o conjunto `inflight` (um passo por site, até
// `CRAWL_MAX_PARALLEL`, faixa única do FlareSolverr), o freio de tráfego e o
// TETO HORÁRIO AGREGADO — o orçamento de educação do processo inteiro. POR SITE
// (`SiteRuntime`): pausa, cursores, rodada, ciclo, custo, teto próprio e o
// `lastActiveAt`, que dá a justiça da escolha E o ritmo (`delayMs`) do site.
// Invariantes preservadas: cursor incremental POR KIND só com a descoberta do
// kind completa; retomada de `inflight`; pausa auto/manual; knobs ao vivo e por
// site (`siteOverrides`); gate da sonda.
import * as crawlerLive from '../utils/crawler-live.js';
import * as store from '../utils/crawl-store.js';
import type { CrawlEngine, SiteCounters } from '../utils/crawl-store.js';
import * as activity from './activity.js';
import { createCrawlStepper } from './crawl-step.js';
import * as recovery from './crawl-recovery.js';
import { buildCrawlerStatus, type CrawlSiteRuntimeView, type CrawlerStatusInput } from './crawl-status.js';
import { createCrawlActions } from './crawl-actions.js';
import * as registry from './crawl-sites/registry.js';
import { createCrawlScheduler } from './crawl-scheduler.js';
import { cursorsView, primeCursors } from './crawl-cursor-load.js';
import {
  cadenceDelayMs, knownSites, siteConfigOf, withCadence, type CrawlerEffectiveConfig, type CrawlerSiteConfig,
} from '../utils/crawler-live-schema.js';
import { readVerdict, probeGate, probeGateOpen } from './crawl-probe-gate.js';
import {
  ensureRuntime, forgetRun, idleFractionOf, pauseSite, type SiteRuntime, type SiteRuntimeMap,
} from './crawl-site-runtime.js';
import { createHourCounter } from './crawl-rate.js';
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { AutoPauseReason } from './crawl-pauses.js';
import type { CrawlSite } from './crawl-types.js';
import { applySkipReasons, skipReasonFor, type SelectDeps, type SiteCandidate } from './crawl-site-select.js';
import { pickBatch } from './crawl-dispatch.js';

// --- Estado do motor ---------------------------------------------------------

let started = false;
/** Sites com passo EM VOO (o paralelo; substitui o antigo `busy` único). */
const inflight = new Set<string>();
/** Pausa MANUAL GLOBAL: não persiste — restart volta ao `.env`. */
let paused = false;
/** Site que serviu a última requisição (o topo do status é a visão dele). */
let activeSiteId = '';
/** Runtime por site (criado sob demanda; sobrevive à troca de config). */
const runtimes: SiteRuntimeMap = new Map();
/** Teto horário AGREGADO do processo (soma do custo real de todos os sites). */
const hourPages = createHourCounter();

const stepper = createCrawlStepper({
  // O ritmo é POR SITE (`lastActiveAt`, gravado no mesmo instante pelo passo).
  markRequest: () => {},
  onCost: (cost, siteId) => { if (!registry.isOwnPace(siteId)) hourPages.note(cost); },
  discoveryCost: () => config.crawl.discoveryCost,
});

/** Sites do motor: `CRAWL_SITES` + os ligados/desligados no painel. */
const configuredSites = knownSites;

function runtimeFor(id: string): SiteRuntime {
  return ensureRuntime(runtimes, id);
}

/** Contadores sem abrir o `crawl.db` (o status não pode abrir nada). */
const EMPTY_COUNTERS: SiteCounters = {
  total: 0,
  byStatus: { pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0 },
};

/** A engine pode expor `hasDue` (consulta exata de vencido); até lá, contadores. */
function hasDue(siteId: string, now: number): boolean {
  const engine = store.currentEngine() as (CrawlEngine & { hasDue?: (s: string, n: number) => boolean }) | null;
  if (engine && typeof engine.hasDue === 'function') return engine.hasDue(siteId, now);
  const by = engine?.counters(siteId).byStatus ?? EMPTY_COUNTERS.byStatus;
  return (by.pending || 0) + (by.error || 0) + (by.inflight || 0) + (by.partial || 0) > 0;
}

/** Deps da seleção — sempre sobre o SNAPSHOT do tick, nunca `effective()`. */
function selectDeps(live: CrawlerEffectiveConfig): SelectDeps {
  return {
    counters: (id) => store.currentEngine()?.counters(id) ?? EMPTY_COUNTERS,
    probeOpen: (id) => probeGateOpen(siteConfigOf(live, id).requireProbe, readVerdict(store.currentEngine(), id)),
    globalCapHit: () => hourPages.current() >= live.maxPerHour,
    hasDue,
  };
}

// Timer rearmável: cadência viva = MENOR `delayMs` dos sites (`withCadence`);
// o delay global atrasaria o site rápido.
const scheduler = createCrawlScheduler({
  isStarted: () => started,
  tick: () => tick(),
  warn: (message) => log.warn('[crawl] tick falhou:', message),
  onDisabled: () => log.info('[crawl] desativado pela config ao vivo (enabled=false)'),
});

/** Resolve o adaptador do site e reflete o resultado no runtime dele. */
async function resolveSite(id: string): Promise<CrawlSite | null> {
  const rt = runtimeFor(id);
  const site = await registry.ensureSite(id);
  if (!site) {
    rt.ready = false;
    rt.adapterFailedAt = Date.now();
    rt.skipReason = 'sem-adaptador';
    return null;
  }
  rt.ready = true;
  rt.adapterFailedAt = 0;
  rt.label = site.label;
  return site;
}

/** Um passo de UM site, fora da trava global: o conjunto `inflight` é a trava. */
async function runSite(chosen: SiteCandidate): Promise<void> {
  try {
    const site = await resolveSite(chosen.id);
    if (!site) return;
    activeSiteId = chosen.id;
    await stepper.step(chosen.runtime, site, chosen.config);
  } catch (err) {
    log.warn(`[crawl] ${chosen.id}: passo falhou:`, log.errorMessage(err));
  } finally {
    inflight.delete(chosen.id);
  }
}

/**
 * Um ciclo do motor: inicia até `CRAWL_MAX_PARALLEL` sites (`crawl-dispatch.ts`)
 * e espera SÓ os que ele iniciou — o timer é `setInterval` e não espera, então o
 * ciclo seguinte já pode ocupar a vaga de quem terminou. Exportado para o teste.
 */
async function tick(): Promise<void> {
  const live = crawlerLive.effective();
  // Rearma antes de retorno precoce (cadência não fica presa a freio/pausa).
  scheduler.rearm(withCadence(live));
  if (!live.enabled || paused) return;
  const ids = configuredSites(live);
  if (ids.length === 0) return;
  // O gate lê `crawl_state` e o store pode não estar aberto (boot desligado não
  // abre): sem abrir aqui, `probeOpen` veria `null` e barraria todo site com
  // `requireProbe` sem nada abrir a engine — o fail-closed trancando a si.
  if (ids.some((id) => siteConfigOf(live, id).requireProbe) && !store.currentEngine()) store.engine();
  const { chosen, all, paced } = pickBatch({
    ids, inflight, maxParallel: config.crawl.maxParallel, flareSites: new Set(config.crawl.flareSites),
    runtimeOf: runtimeFor, configOf: (id) => siteConfigOf(live, id), deps: selectDeps(live), now: Date.now(),
  });
  // Site que DEVE trabalho e não foi servido: "aguarda a vez" (ou o próprio
  // ritmo), não "sem trabalho" — a diferença que o painel precisa mostrar.
  const picked = new Set(chosen.map((c) => c.id));
  applySkipReasons(all.map((candidate) => (!picked.has(candidate.id) && candidate.due
    ? { ...candidate, skipReason: paced.has(candidate.id) ? 'ritmo' as const : 'aguarda-rodizio' as const }
    : candidate)));
  const runs: Promise<void>[] = [];
  for (const candidate of chosen) {
    const rt = candidate.runtime;
    rt.attempts += 1;
    if (!registry.isOwnPace(candidate.id) && activity.recentUserTraffic(candidate.config.idleWindowMs)) {
      rt.trafficBlocks += 1;
      rt.skipReason = 'trafego';
      continue;
    }
    // Entra no conjunto ANTES de qualquer `await`: dois ciclos se cruzam aqui.
    inflight.add(candidate.id);
    runs.push(runSite(candidate));
  }
  await Promise.all(runs);
}

/**
 * O site pode trabalhar AGORA? É o kill-switch do motor (`enabled` global)
 * E o override do site: `wasEnabled` acompanha ISTO, porque a virada que
 * dispara a recuperação é o painel religando o motor, não o toggle do site.
 */
function siteActive(live: CrawlerEffectiveConfig, cfg: CrawlerSiteConfig): boolean {
  return live.enabled && cfg.enabled;
}

/** Viradas por site detectadas no painel (religar/desligar, dry-run). */
function onLiveConfigChange(): void {
  const live = crawlerLive.effective();
  for (const id of configuredSites(live)) {
    const cfg = siteConfigOf(live, id);
    const rt = runtimeFor(id);
    if (siteActive(live, cfg) && !rt.wasEnabled) {
      rt.needInflightRecovery = true;
      // Ligado DEPOIS do boot: sem isto o 1º ciclo sairia `initial` (sitemap inteiro).
      primeCursors(rt);
      // Boot desabilitado adiou a passada de `simulated`: roda na 1ª step.
      if (!rt.simulatedRecoveryDone && cfg.dryRun === false) rt.needSimulatedRecovery = true;
    }
    if (rt.wasDryRun === true && cfg.dryRun === false) rt.needSimulatedRecovery = true;
    rt.wasEnabled = siteActive(live, cfg);
    // A foto é o estado ATUAL: sem esta linha o flip voltaria a pedir a
    // recuperação `simulated` em toda mudança de config seguinte.
    rt.wasDryRun = cfg.dryRun;
  }
  scheduler.sync(withCadence(live));
}

/** Recuperações e cursores de um site no boot (processo novo). */
function primeSite(rt: SiteRuntime, cfg: CrawlerSiteConfig): void {
  // Start: processo novo ⇒ todo inflight é órfão. O painel usa a flag
  // `needInflightRecovery` no caminho ao vivo.
  recovery.requeueInflight(rt.id);
  rt.needInflightRecovery = false;
  // Restart já COM dry-run desligado: recupera `simulated` sobrevivente a crash
  // antes do switch (mesmo one-shot do caminho ao vivo).
  if (cfg.dryRun === false) { recovery.requeueSimulated(rt.id); rt.simulatedRecoveryDone = true; }
  // Fase 6/2: cursores duráveis POR KIND — restart retoma o incremental do
  // estado persistido, sem reprocessar o acervo.
  primeCursors(rt);
}

/** Arma o motor. Sticky; só ativa com a config viva habilitada. */
function start(): void {
  if (started) return;
  started = true;
  crawlerLive.onConfigChange(onLiveConfigChange);
  const live = crawlerLive.effective();
  const ids = configuredSites(live);
  for (const id of ids) {
    const cfg = siteConfigOf(live, id);
    const rt = runtimeFor(id);
    rt.wasEnabled = siteActive(live, cfg);
    rt.wasDryRun = cfg.dryRun;
    if (!siteActive(live, cfg)) continue;
    primeSite(rt, cfg);
  }
  if (!live.enabled) {
    log.info('[crawl] desativado (enabled=false)');
    return;
  }
  if (ids.length === 0) {
    log.warn('[crawl] nenhum site configurado em CRAWL_SITES');
    return;
  }
  scheduler.rearm(withCadence(live));
  log.info(`[crawl] motor armado (sites=${ids.join(',')}, delay=${cadenceDelayMs(live)}ms, dryRun=${live.dryRun})`);
}

/**
 * Pausa manual. Sem `siteId` é a pausa GLOBAL (compat); com `siteId`, só
 * daquele site. Desligar limpa também a pausa automática do alvo (consentimento
 * do operador, como sempre).
 *
 * Site fora de `CRAWL_SITES` é REJEITADO (`ok:false` + `error`): sem isso a
 * ação criaria runtime de um site que o operador nem configurou, e o painel
 * mostraria um card que nunca vai raspar.
 */
function setPaused(value: boolean, siteId?: string): {
  ok: boolean; paused: boolean; globalPaused: boolean; site: string | null;
  autoPause: { reason: AutoPauseReason } | null; error?: string;
} {
  const site = String(siteId || '').trim();
  if (site) {
    if (!siteIds().includes(site)) {
      return {
        ok: false, paused: false, globalPaused: paused, site, autoPause: null,
        error: `site "${site}" não está em CRAWL_SITES`,
      };
    }
    const rt = runtimeFor(site);
    pauseSite(rt, value);
    metrics.count(value ? 'crawl.pause.site' : 'crawl.resume.site');
    return {
      ok: true, paused: rt.paused, globalPaused: paused, site,
      autoPause: rt.autoPause ? { reason: rt.autoPause.reason } : null,
    };
  }
  paused = Boolean(value);
  if (!paused) {
    // A pausa global que sai leva junto a automática de TODOS os sites: é
    // consentimento do operador sobre o motor inteiro, não sobre um site.
    for (const rt of runtimes.values()) rt.autoPause = null;
  }
  metrics.count(paused ? 'crawl.pause' : 'crawl.resume');
  return { ok: true, paused, globalPaused: paused, site: null, autoPause: null };
}

// --- Fase 4/8: ações do painel -----------------------------------------------

/** ids dos sites vivos (config ao vivo), sem credencial. */
function siteIds(): string[] {
  return configuredSites(crawlerLive.effective());
}

// As ações (simular/reprocessar/zerar) moram em `crawl-actions.ts`; o motor
// injeta as closures — o módulo não importa `crawler.ts`, sem ciclo.
const { simulate, reprocessErrors, reprocessNoWork, resetSite } = createCrawlActions({
  effective: () => crawlerLive.effective(),
  isBusy: () => inflight.size > 0,
  isPaused: () => paused,
  ensureSite: (id) => resolveSite(id),
  siteLabel: (id) => runtimeFor(id).label,
  forgetRun: (id) => forgetRun(runtimeFor(id)),
  activeSiteId: () => activeSiteId,
  count: (name, value) => metrics.count(name, value),
});

// --- Status ------------------------------------------------------------------

/**
 * Engine do STATUS: o painel precisa do `crawl.db` mesmo com o motor DESLIGADO
 * (`start()` com `enabled=false` não abre o store, e o card de site novo não
 * mostraria "sonda não rodada"). Reutiliza a do motor e abre só se não houver
 * nenhuma — abertura idempotente, e o status só LÊ. Sem site configurado não
 * abre: criar o arquivo seria efeito colateral do painel.
 */
function statusEngine(configured: number): CrawlEngine | null {
  const open = store.currentEngine();
  if (open) return open;
  return configured > 0 ? store.engine() : null;
}

/** Vista do runtime de um site para o card. */
function siteView(id: string, live: CrawlerEffectiveConfig, engine: CrawlEngine): CrawlSiteRuntimeView {
  const rt = runtimeFor(id);
  const cfg = siteConfigOf(live, id);
  return {
    id,
    label: rt.label || registry.siteInfo(id).label,
    ready: rt.ready,
    paused: rt.paused,
    autoPause: rt.autoPause,
    cursors: cursorsView(rt, engine),
    nextDiscoveryAt: rt.nextDiscoverAt,
    pagesThisHour: rt.hourPages.current(),
    openRunId: rt.openRunId,
    errorStreak: rt.policy.errorStreakCount,
    canaryStreak: rt.policy.canaryStreakCount,
    cycle: { ...rt.cycle },
    currentSiteNewReleases: rt.cycle.newReleases,
    avgRequestCost: rt.cost.avg(),
    idleFraction: idleFractionOf(rt),
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    siteConfig: cfg,
    // O gate lê `crawl_state` pela MESMA engine do card: com o motor ligado e
    // desligado o veredito é o mesmo. Sem a engine ele virava `null` — "nunca
    // rodou" para um site que já rodou.
    probe: probeGate(cfg.requireProbe, readVerdict(engine, id)),
    lastActiveAt: rt.lastActiveAt,
    skipReason: skipReasonFor(rt, cfg, live.enabled),
    site: registry.siteInfo(id),
  };
}

/** Foto do motor para o painel — sem credencial e sem segredo. A montagem do
 * formato (cards por site, ETA, listas) mora em `crawl-status.ts` (pura). */
function status() {
  const live = crawlerLive.effective();
  const configured = siteIds();
  const engine = statusEngine(configured.length);
  const input: CrawlerStatusInput = {
    // `engine` só é `null` quando não há site configurado — e aí a lista de
    // cards seria vazia de todo modo, por isso o `[]` explícito.
    sites: engine ? configured.map((id) => siteView(id, live, engine)) : [],
    globalPaused: paused,
    active: activeSiteId || configured[0] || null,
    pagesThisHourTotal: hourPages.current(),
    maxPerHourTotal: live.maxPerHour,
  };
  return buildCrawlerStatus(engine, live, configured, input);
}

// --- Ganchos de teste --------------------------------------------------------

/** Injeta adaptadores dublês (o motor não toca o site real). */
export function _setSitesForTest(factory: ((id: string) => CrawlSite | null) | null): void {
  registry.setFactoryForTest(factory);
}

/** Zera o relógio da próxima descoberta (o teste não espera 60 min). */
export function _forceDiscoveryForTest(siteId?: string): void {
  // Sem argumento: todos os sites conhecidos — os que já têm runtime E os
  // configurados (o teste pode forçar antes do primeiro tick).
  const ids = siteId ? [siteId] : [...new Set([...runtimes.keys(), ...siteIds()])];
  for (const id of ids) runtimeFor(id).nextDiscoverAt = 0;
}

/** Estado limpo entre casos (o processo sobe `start()` uma vez só). */
export function _resetForTest(): void {
  scheduler.disarm();
  started = false;
  inflight.clear();
  paused = false;
  activeSiteId = '';
  runtimes.clear();
  registry.setFactoryForTest(null);
  crawlerLive.onConfigChange(null);
  hourPages.clear();
}

export { start, tick, status, setPaused, simulate, reprocessErrors, reprocessNoWork, resetSite };
export default { start, tick, status, setPaused, simulate, reprocessErrors, reprocessNoWork, resetSite };
