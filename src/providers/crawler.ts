// Fachada do raspador no Node. Os NOVE sites (oito cards do Jackett + o Mico)
// são raspados pelo sidecar Rust (`adom-crawl`); o loop TS que escolhia site,
// ritmava e processava página saiu depois da Fase 6, quando nenhum site
// sobrou com adaptador TS. Aqui ficam só as peças que o painel consome:
//
// - `status()`: cards, catálogo e contadores lidos do `crawl.db` (o mesmo banco
//   que o sidecar escreve) — o bloco `crawl` junta a foto do sidecar por cima;
// - `setPaused()`: pausa manual global/por site, guardada no runtime do card;
// - as ações locais (`crawl-actions.ts`): a simulação, que sem adaptador TS
//   responde `sem-adaptador`. "Reprocessar sem obra", "Reprocessar erros" e
//   "Zerar site" vão ao sidecar (`dashboard-actions-crawl.ts`).
//
// O `start()` só PEDE ao sidecar a limpeza one-shot de `simulated` (resto do
// dry-run do motor TS, que o sidecar não tem) via
// `POST /crawl/requeue-simulated`; a retomada de `inflight` é do próprio
// sidecar no boot dele. O Node não escreve mais no `crawl.db`.
import config from '../config.js';
import * as crawlerLive from '../utils/crawler-live.js';
import * as store from '../utils/crawl-store.js';
import type { CrawlEngine } from '../utils/crawl-store.js';
import { buildCrawlerStatus, type CrawlSiteRuntimeView, type CrawlerStatusInput } from './crawl-status.js';
import { createCrawlActions } from './crawl-actions.js';
import * as registry from './crawl-sites/registry.js';
import { cursorsView, _resetForTest as resetCursorsView } from './crawl-cursor-load.js';
import { knownSites, siteConfigOf, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import { readVerdict, probeGate } from './crawl-probe-gate.js';
import {
  ensureRuntime, idleFractionOf, pauseSite, type SiteRuntime, type SiteRuntimeMap,
} from './crawl-site-runtime.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { AutoPauseReason } from './crawl-pauses.js';

let started = false;
/** Pausa MANUAL GLOBAL: não persiste — restart volta ao `.env`. */
let paused = false;
/** Runtime por site (criado sob demanda; sobrevive à troca de config). */
const runtimes: SiteRuntimeMap = new Map();

function runtimeFor(id: string): SiteRuntime {
  return ensureRuntime(runtimes, id);
}

/** ids dos sites vivos (`CRAWL_SITES` + os ligados no painel), sem credencial. */
function siteIds(): string[] {
  return knownSites(crawlerLive.effective());
}

/**
 * Pedido ao sidecar (dono do `crawl.db`) para devolver à fila a linha
 * `simulated` de um dry-run antigo do motor TS. FIRE-AND-FORGET de propósito: o
 * boot do Node não pode falhar (nem atrasar) porque o sidecar não respondeu —
 * quem escreve no banco é ele, e repetir o pedido é no-op.
 */
function requeueSimulatedInSidecar(site: string): void {
  const url = `http://127.0.0.1:${config.crawl.sidecarPort}/crawl/requeue-simulated`;
  void fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.jackett.testToken ? { 'X-Indexer-Test-Token': config.jackett.testToken } : {}),
    },
    body: JSON.stringify({ site }),
    signal: AbortSignal.timeout(config.crawl.sidecarStatusTimeoutMs),
  }).then((resp) => {
    if (!resp.ok) log.debug(`[crawl] requeue-simulated de ${site}: sidecar respondeu HTTP ${resp.status}`);
  }).catch(() => {
    // sidecar fora do ar: silêncio (o sidecar devolve a fila sozinho no boot).
  });
}

/**
 * Boot: linha `simulated` de um dry-run antigo do motor TS volta a `pending`
 * para o sidecar gravá-la. Idempotente (tocar só `simulated` repete como no-op)
 * e só com o site ativo e o dry-run desligado — a mesma condição de antes.
 */
function start(): void {
  if (started) return;
  started = true;
  const live = crawlerLive.effective();
  if (!live.enabled) {
    log.info('[crawl] desativado (enabled=false)');
    return;
  }
  for (const id of siteIds()) {
    const cfg = siteConfigOf(live, id);
    if (cfg.enabled && cfg.dryRun === false) requeueSimulatedInSidecar(id);
  }
  log.info('[crawl] sidecar Rust é dono de todos os sites; o Node serve status e ações do painel');
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

// As ações locais (simular/reprocessar sem obra) moram em `crawl-actions.ts`; a fachada
// injeta as closures — o módulo não importa `crawler.ts`, sem ciclo.
const { simulate, reprocessNoWork } = createCrawlActions({
  effective: () => crawlerLive.effective(),
  isPaused: () => paused,
  count: (name, value) => metrics.count(name, value),
});

/**
 * Engine do STATUS: o painel precisa do `crawl.db` mesmo com o raspador
 * DESLIGADO (o card de site novo mostra "sonda não rodada"). Abre só se não
 * houver nenhuma — abertura idempotente, e o status só LÊ. Sem site
 * configurado não abre: criar o arquivo seria efeito colateral do painel.
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
    cursors: cursorsView(id, engine),
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
    // O gate lê crawl_state pela mesma engine do card (sem ela virava null).
    probe: probeGate(cfg.requireProbe, readVerdict(engine, id)),
    lastActiveAt: rt.lastActiveAt,
    // A seleção de site é do sidecar; daqui só sai a exclusão pela config do
    // operador (pausa e teto do sidecar chegam pela foto dele no bloco `crawl`).
    skipReason: live.enabled && cfg.enabled ? null : 'desabilitado',
    site: registry.siteInfo(id),
  };
}

/** Foto para o painel (montagem em crawl-status.ts). */
function status() {
  const live = crawlerLive.effective();
  const configured = siteIds();
  const engine = statusEngine(configured.length);
  const input: CrawlerStatusInput = {
    // engine é null só sem site configurado (lista vazia de todo modo).
    sites: engine ? configured.map((id) => siteView(id, live, engine)) : [],
    globalPaused: paused,
    active: configured[0] || null,
    // O custo por hora é contado pelo sidecar (foto em `sidecar` no bloco).
    pagesThisHourTotal: 0,
    maxPerHourTotal: live.maxPerHour,
  };
  return buildCrawlerStatus(engine, live, configured, input);
}

/** Estado limpo entre casos (o processo sobe `start()` uma vez só). */
export function _resetForTest(): void {
  started = false;
  paused = false;
  runtimes.clear();
  resetCursorsView();
}

export { start, status, setPaused, simulate, reprocessNoWork };
export default { start, status, setPaused, simulate, reprocessNoWork };
