// O PASSO de um site: descoberta quando devida, senão UMA página. Extraído do
// `crawler.ts` pela catraca de linhas na Fase 8 (multi-site): o que era estado
// global passou a ser POR SITE, e o passo passou a receber o `SiteRuntime` e a
// `CrawlerSiteConfig` do site escolhido.
//
// Nada aqui decide QUAL site roda (isso é `crawl-site-select.ts`), nem o ritmo
// global e o freio de tráfego (`crawler.ts`). O passo só:
//  1. roda as recuperações one-shot do site (inflight órfã, `simulated`);
//  2. abre/fecha a rodada de descoberta conforme o cursor de cada kind;
//  3. processa UMA página, alimentando a política de pausa do site e o custo
//     real (a Fase 7+: a página de série custa cards + saltos, não 1).
import * as store from '../utils/crawl-store.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import config from '../config.js';
import { seriesLimitsOf, type CrawlerSiteConfig } from '../utils/crawler-live-schema.js';
import { DEFAULT_RETRY_BASE_MS } from '../utils/crawl-store-rules.js';
import { advanceCursors, discoveryCuts } from './crawl-cursor.js';
import { initialLoadDone } from './crawl-coverage.js';
import { processCrawlPage, requestCostOf } from './crawl-page.js';
import { freshCycle } from './crawl-cycle.js';
import * as recovery from './crawl-recovery.js';
import {
  autoPauseSite, beginStepFence, invalidateStep, STEP_TIMEOUT_REASON,
  type SiteRuntime, type StepFence,
} from './crawl-site-runtime.js';
import type { AutoPauseReason, PauseLimits } from './crawl-pauses.js';
import type { CrawlSite, CrawlUrlRow } from './crawl-types.js';

export interface CrawlStepDeps {
  /** Marca o instante da requisição no ritmo GLOBAL (o motor é quem guarda). */
  markRequest(at: number): void;
  /** Cobra o custo no teto horário AGREGADO do processo (soma dos sites). */
  /** `siteId`: site de ritmo próprio não entra no teto agregado. */
  onCost(cost: number, siteId: string): void;
  /**
   * Custo ESTIMADO de uma rodada de descoberta enquanto o adaptador não mede
   * (`CRAWL_DISCOVERY_COST`): sitemap de filme + de série, na ordem de grandeza
   * do Vaca. É estimativa declarada, não medição — por isso é knob, e por isso
   * o adaptador pode overriding por rodada com `CrawlDiscovery.requestCost`.
   * Função, e não valor: o knob é lido NO MOMENTO do passo (o `.env` pode
   * mudar e o teste precisa poder isolar o custo).
   */
  discoveryCost(): number;
}

function limits(cfg: CrawlerSiteConfig): PauseLimits {
  return { errorPauseStreak: cfg.errorPauseStreak, layoutCanary: cfg.layoutCanary };
}

/**
 * Prazo do passo de LINHA do site. Faixa FlareSolverr tem orçamento próprio
 * (a cadeia do protetor pelo Flare é bem mais lenta que a API do Mico, de onde
 * sai o default global); nunca fica abaixo do global.
 */
export function stepDeadlineFor(siteId: string): number {
  const base = Math.max(1, Math.trunc(Number(config.crawl.stepDeadlineMs) || 0));
  const flareSites: readonly string[] = config.crawl.flareSites ?? [];
  if (!flareSites.includes(siteId)) return base;
  return Math.max(base, Math.trunc(Number(config.crawl.flareStepDeadlineMs) || 0));
}

export function createCrawlStepper(deps: CrawlStepDeps) {
  function triggerAutoPause(rt: SiteRuntime, reason: AutoPauseReason, detail: string): void {
    autoPauseSite(rt, reason, detail);
    metrics.count(reason === 'layout' ? 'crawl.paused.layout' : 'crawl.paused.error-streak');
    log.warn(`[crawl] ${rt.id}: pausa automática (${reason}):`, rt.autoPause?.detail || '');
  }

  /** Fecha a rodada aberta (se houver) e agenda a próxima descoberta. */
  function closeRun(rt: SiteRuntime, nextDelayMs: number): void {
    if (rt.openRunId == null) return;
    store.engine().finishRun(rt.openRunId, Date.now(), { ...rt.cycle });
    rt.openRunId = null;
    rt.nextDiscoverAt = Date.now() + Math.max(0, nextDelayMs);
    rt.cycle = freshCycle();
  }

  /** Cobra o custo de uma página/rodada nos DOIS tetos: o do site e o
   *  agregado do processo. Custo zero (descoberta isenta por configuração) não
   *  é cobrado — o `HourCounter` tem piso 1, e "cobrar 1 do que custou 0"
   *  seria inventar requisição. */
  function charge(rt: SiteRuntime, cost: number): void {
    if (!(cost > 0)) return;
    rt.hourPages.note(cost);
    rt.cost.note(cost);
    deps.onCost(cost, rt.id);
  }

  /** Rodada de descoberta: upsert no store e, se completa, avanço do cursor. */
  async function runDiscovery(rt: SiteRuntime, site: CrawlSite, cfg: CrawlerSiteConfig, fence?: StepFence): Promise<void> {
    const now = Date.now();
    rt.lastActiveAt = now;
    deps.markRequest(now);
    rt.activeUrl = null;
    // F2: fase e corte POR KIND (ver `crawl-cursor.ts`) — série sem cursor
    // começa `initial` mesmo com filmes incrementais.
    const { phase: cutPhase, sinceByKind } = discoveryCuts(rt.cursors);
    // Site de LISTAGEM nunca grava `cursor:movie`: a fase vinha `initial` para
    // sempre e o painel mostrava "Carga inicial" com a listagem já em `sweep`.
    const phase = cutPhase === 'initial' && initialLoadDone(store.engine(), rt.id) ? 'incremental' : cutPhase;
    rt.openRunId = store.engine().startRun(rt.id, phase, rt.cursors.movie, now);
    rt.cycle = freshCycle();
    rt.discoveryPartial = false;
    let costed = false;
    try {
      const discovery = await site.discover(sinceByKind.movie, {
        series: seriesLimitsOf(cfg),
        sinceByKind,
        // Cerca de posse para a ESCRITA de descoberta do adaptador (marker
        // `full-sweep`/cursor de listagem) e freio cooperativo do laço de
        // páginas: um passo expirado não pode gravar marker tardio.
        isAborted: fence ? () => fence.aborted() : undefined,
        // Commit DIFERIDO: o adaptador devolve as marcações em `commit` e o
        // motor as grava DEPOIS do upsert — nunca antes de a fila persistir.
        deferCommit: true,
      });
      // Passo expirado (prazo do site vencido): a cerca está fechada — NÃO
      // grava upsert/cursor/custo e NÃO fecha a rodada (o vigia já a fechou).
      if (fence?.aborted()) return;
      // A descoberta faz requisições de verdade (sitemap de filme, de série, e
      // saltos do protetor): sem cobrança ela não entraria no teto por hora, que
      // é de REQUISIÇÕES. O adaptador que sabe contar declara o custo real da
      // rodada; senão vale a estimativa declarada em `CRAWL_DISCOVERY_COST`
      // (default 3). `0` é escolha legítima de operador (e o que os testes
      // usam para isolar o custo da PÁGINA, que tem caso próprio).
      const raw = deps.discoveryCost();
      const estimate = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
      const declared = Number(discovery.requestCost ?? estimate);
      const discoveryCost = Math.max(0, Math.trunc(Number.isFinite(declared) ? declared : estimate));
      costed = true;
      charge(rt, discoveryCost);
      const report = store.engine().upsertUrls(rt.id, discovery.urls, now);
      rt.cycle.discoveryAdded = report.added;
      rt.cycle.discoveryRefreshed = report.refreshed;
      // F2: o cursor de CADA kind anda só com a descoberta DELE completa —
      // parcial de um sitemap não trava o avanço seguro do outro.
      advanceCursors(rt.id, discovery, rt.cursors);
      // Commit DIFERIDO do adaptador: só AGORA, com a fila JÁ persistida
      // (`upsertUrls` acima) e a cerca AINDA aberta, os markers `full-sweep`/
      // cursor de listagem são gravados. Se a cerca tivesse fechado, o return
      // acima executaria antes do upsert — o commit nunca rodaria, e o marker
      // não ficaria adiantado sobre URLs descartadas.
      if (!fence?.aborted()) discovery.commit?.();
      if (discovery.complete) {
        rt.policy.observeSiteSuccess();
        metrics.count('crawl.discovery.ok');
        if (report.added) metrics.count('crawl.discovery.added', report.added);
      } else {
        rt.cycle.discoveryFailures = discovery.failures.length;
        // Parcial NÃO agenda como completa: a releitura volta no prazo curto de
        // retry (ver `step`). Os cursores dos kinds completos JÁ andaram (F2).
        rt.discoveryPartial = true;
        metrics.count('crawl.discovery.partial');
        log.warn(`[crawl] ${rt.id}: descoberta parcial:`, discovery.failures.join(' | ').slice(0, 400));
      }
    } catch (err: unknown) {
      if (fence?.aborted()) return;
      if (!costed) {
        costed = true;
        const raw = requestCostOf(err) ?? deps.discoveryCost();
        const fallback = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
        charge(rt, fallback);
      }
      const message = log.errorMessage(err);
      rt.cycle.discoveryFailures += 1;
      metrics.count('crawl.discovery.error');
      log.warn(`[crawl] ${rt.id}: descoberta falhou:`, message);
      const reason = rt.policy.observeSiteFailure(message, limits(cfg));
      if (reason) triggerAutoPause(rt, reason, message);
      // Falha total: re-tenta em breve (base do backoff), não no ciclo incremental.
      closeRun(rt, DEFAULT_RETRY_BASE_MS);
    }
  }

  /** Processa UMA página reclamada e alimenta a política de pausa do site. */
  async function processClaimed(rt: SiteRuntime, site: CrawlSite, row: CrawlUrlRow, cfg: CrawlerSiteConfig, fence?: StepFence): Promise<void> {
    const now = Date.now();
    rt.lastActiveAt = now;
    deps.markRequest(now);
    // A linha em voo fica registrada: se o passo estourar o prazo, o vigia
    // marca ESTA URL como `error step-timeout` (com progresso preservado).
    rt.activeUrl = row.url;
    const outcome = await processCrawlPage(site, row, {
      dryRun: cfg.dryRun, maxTries: cfg.maxTries, series: seriesLimitsOf(cfg),
      isAborted: fence ? () => fence.aborted() : undefined,
    });
    // Passo expirado: a recuperação já devolveu/marcou a linha. NÃO cobra,
    // NÃO conta ciclo, NÃO alimenta a política com o desfecho tardio.
    if (fence?.aborted()) return;
    rt.activeUrl = null;
    // Fase 7: o teto por hora cobra o custo REAL da página, não 1 por página.
    const cost = Math.max(1, Math.trunc(Number(outcome.requestCost ?? 1)));
    charge(rt, cost);
    rt.cycle.pages += 1;
    if (outcome.kind === 'done') {
      rt.cycle.done += 1;
      rt.cycle.releases += outcome.releases;
      rt.cycle.newReleases += outcome.addedNew ?? 0;
    } else if (outcome.kind === 'simulated') { rt.cycle.simulated += 1; rt.cycle.releases += outcome.releases; }
    // `partial` (Fase 7 v2) é trabalho em andamento, não erro: releases contam
    // no ciclo e NÃO caem no balde de erros.
    else if (outcome.kind === 'partial') {
      rt.cycle.partial += 1;
      rt.cycle.releases += outcome.releases;
      rt.cycle.newReleases += outcome.addedNew ?? 0;
    } else if (outcome.kind === 'no-torrent') rt.cycle.noTorrent += 1;
    else if (outcome.kind === 'no-work') rt.cycle.noWork += 1;
    else rt.cycle.errors += 1;
    const reason = rt.policy.observePage(row.url, {
      kind: outcome.kind, siteLevelError: outcome.siteLevelError, releases: outcome.releases,
    }, limits(cfg));
    if (reason) triggerAutoPause(rt, reason, outcome.detail || row.url);
  }

  /** Um passo do SITE escolhido. */
  async function step(rt: SiteRuntime, site: CrawlSite, cfg: CrawlerSiteConfig, fence?: StepFence): Promise<void> {
    if (fence?.aborted()) return;
    // Recuperações ANTES do takeNext (one-shot; simulated reabre rodada com
    // nextDiscoverAt = 0, senão o pending novo esperaria o ciclo incremental):
    if (rt.needInflightRecovery) { rt.needInflightRecovery = false; recovery.requeueInflight(rt.id); }
    if (rt.needSimulatedRecovery) {
      rt.needSimulatedRecovery = false;
      rt.simulatedRecoveryDone = true;
      if (recovery.requeueSimulated(rt.id)) { rt.nextDiscoverAt = 0; rt.discoveryPartial = false; }
    }
    if (rt.openRunId == null) {
      const counters = store.engine().counters(rt.id);
      if (counters.total === 0 || Date.now() >= rt.nextDiscoverAt) {
        // Fase DESCOBERTA: orçamento PRÓPRIO (dois catálogos em sequência no
        // Mico ~100 min). Trocado AQUI, depois das recuperações acima e antes
        // de qualquer await — nunca por predição de `nextDiscoverAt` velho.
        fence?.setBudget?.(config.crawl.discoveryDeadlineMs);
        await runDiscovery(rt, site, cfg, fence);
        return;
      }
      // Ocioso: tick serial ⇒ inflight aqui é órfão; devolve e tenta o vencido.
      if (counters.byStatus.inflight > 0) {
        const recovered = store.engine().requeueInflight(rt.id, 0, Date.now());
        if (recovered > 0) log.warn(`[crawl] ${rt.id}: ${recovered} URL(s) inflight órfã(s) devolvida(s)`);
      }
      // `partial` incluído: página de série em andamento com `next_at` futuro
      // (retry da base) tem que ser servida fora de uma rodada aberta, senão
      // One Piece/TWD esperariam o ciclo incremental inteiro entre passes.
      if (counters.byStatus.error > 0 || counters.byStatus.inflight > 0 || counters.byStatus.partial > 0) {
        const row = store.engine().takeNext(rt.id, Date.now());
        if (row) await processClaimed(rt, site, row, cfg, fence);
      }
      return;
    }

    const row = store.engine().takeNext(rt.id, Date.now());
    if (!row) {
      // Fila esgotada: fecha a rodada (initial OU incremental); parcial agenda
      // retry curto, nunca como se a descoberta tivesse coberto tudo.
      closeRun(rt, rt.discoveryPartial ? DEFAULT_RETRY_BASE_MS : cfg.incrementalIntervalMin * 60_000);
      return;
    }
    await processClaimed(rt, site, row, cfg, fence);
  }

  /**
   * Recuperação do passo expirado: a geração já foi invalidada (escritas tardias
   * descartadas), então devolve o estado para o site seguir.
   *  - linha presa (página) → `error step-timeout` (backoff RETENTÁVEL e
   *    progresso preservado pelo `applyResult`) e a rodada segue ABERTA para os
   *    próximos itens;
   *  - descoberta presa → fecha a rodada e rearma `nextDiscoverAt = 0` para a
   *    releitura da descoberta (nenhum upsert/cursor tardio entra).
   * Devolve quantas `inflight` órfãs voltaram à fila.
   */
  function recoverTimedOutStep(rt: SiteRuntime, cfg: CrawlerSiteConfig): number {
    const engine = store.engine();
    const stuck = rt.activeUrl;
    if (stuck) {
      engine.markResult(rt.id, stuck, { status: 'error', error: STEP_TIMEOUT_REASON }, Date.now(), { maxTries: cfg.maxTries });
    }
    rt.activeUrl = null;
    const requeued = engine.requeueInflight(rt.id, 0, Date.now());
    if (!stuck && rt.openRunId != null) {
      engine.finishRun(rt.openRunId, Date.now(), { ...rt.cycle });
      rt.openRunId = null;
      rt.cycle = freshCycle();
      rt.nextDiscoverAt = 0;
    }
    return requeued;
  }

  /**
   * Passo VIGIADO: corre `step` sob o prazo do site (`stepDeadlineFor`). Se vencer, a
   * cerca do passo é fechada e a recuperação da linha presa roda; a vaga do
   * site é liberada pelo `finally` do chamador. A rede já tem deadline próprio
   * (fetch+corpo); este é o backstop de await não-abortável. O timeout é um
   * `Promise.race` com escrita tardia BARrada pela cerca (nunca "libera a vaga
   * e deixa o passo velho escrever").
   */
  async function boundedStep(rt: SiteRuntime, site: CrawlSite, cfg: CrawlerSiteConfig): Promise<void> {
    const fence = beginStepFence(rt);
    let budgetMs = stepDeadlineFor(rt.id);
    let timer: NodeJS.Timeout | undefined;
    let resolveTimeout!: (value: 'timeout') => void;
    const timeout = new Promise<'timeout'>((resolve) => { resolveTimeout = resolve; });
    // Timer REFERENCIADO de propósito: o prazo precisa vencer mesmo se o único
    // trabalho pendente for a promessa presa (sem socket/timer) — é limpo no
    // `finally`. Re-armável para trocar pelo orçamento da FASE (descoberta).
    const arm = (ms: number): void => {
      budgetMs = Math.max(1, Math.trunc(Number(ms) || 0));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => resolveTimeout('timeout'), budgetMs);
    };
    fence.setBudget = arm;
    arm(budgetMs);
    // Rejeição pré-prazo sobe (o motor loga); pós-prazo é silenciada (o passo
    // foi invalidado e ninguém mais espera por ele).
    const guarded = step(rt, site, cfg, fence).catch((err: unknown) => { if (!fence.aborted()) throw err; });
    let result: 'done' | 'timeout';
    try {
      result = await Promise.race([guarded.then(() => 'done' as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === 'done') return;
    invalidateStep(rt);
    const requeued = recoverTimedOutStep(rt, cfg);
    metrics.count('crawl.step.timeout');
    log.warn(`[crawl] ${rt.id}: passo excedeu o prazo (${budgetMs}ms) — geração invalidada${requeued > 0 ? `, ${requeued} URL(s) devolvida(s)` : ''}`);
  }

  return { step, boundedStep, closeRun, runDiscovery, processClaimed, triggerAutoPause };
}
