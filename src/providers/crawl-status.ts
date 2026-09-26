// Montagem do STATUS do crawler para o painel (Fase 4 do plano "Raspagem
// total"). Extraído de `crawler.ts` pela catraca de 400 linhas: são funções
// PURAS sobre uma foto do motor — não tocam rede, store nem o timer. O motor
// captura o próprio estado e entrega aqui; assim o formato do card é testável
// sem subir o motor.
import type { CrawlEngine } from '../utils/crawl-store.js';
import type { CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { CrawlRunRow } from './crawl-types.js';

/** Estado escalar do motor necessário para montar o status. */
export interface CrawlMotorState {
  activeSiteId: string;
  activeLabel: string | null;
  paused: boolean;
  autoPause: { reason: string; at: number; detail: string } | null;
  cursor: string;
  pagesThisHour: number;
  openRunId: number | null;
  errorStreak: number;
  canaryStreak: number;
  cycle: Record<string, number>;
  /** `newReleases` do ciclo corrente (só vale para o site ativo). */
  currentSiteNewReleases: number;
  siteReady: boolean;
}

export interface SiteStatus {
  id: string;
  label: string;
  phase: 'initial' | 'incremental' | null;
  total: number;
  byStatus: Record<string, number>;
  progressPercent: number;
  /** Magnets (releases) vistos nas páginas do site. */
  magnetsFound: number;
  /** Novos no índice no ciclo corrente/última rodada. */
  newReleases: number;
  pendingRemaining: number;
  ratePerHour: number;
  etaHours: number | null;
  latestRun: CrawlRunRow | null;
  recentWorks: Array<{ url: string; imdb: string | null; releases: number; checkedAt: number }>;
  noWork: Array<{ url: string; checkedAt: number }>;
  errors: Array<{ url: string; error: string; tries: number; checkedAt: number }>;
  errorGroups: Array<{ reason: string; count: number }>;
}

/** Ritmo efetivo: o menor entre o teto por hora e o que o delay permite. */
export function rateFor(live: CrawlerEffectiveConfig): number {
  const byDelay = live.delayMs > 0 ? 3_600_000 / live.delayMs : live.maxPerHour;
  return Math.max(1, Math.min(byDelay, live.maxPerHour));
}

// Tetos das LISTAS do card. O painel mostra resumo, não o site inteiro: sem
// limite explícito, um `crawl.db` grande devolveria milhares de linhas por site
// a cada poll (~10s). São constantes exportadas para o teste medir as chamadas.
export const STATUS_LIST_LIMIT = 10;
export const STATUS_ERROR_GROUPS_LIMIT = 10;

/** Card de UM site. `null` quando o store ainda não abriu (nada a mostrar). */
export function buildSiteStatus(
  siteId: string,
  engine: CrawlEngine,
  live: CrawlerEffectiveConfig,
  state: CrawlMotorState,
): SiteStatus {
  const counters = engine.counters(siteId);
  const latest = engine.latestRun(siteId);
  const rate = rateFor(live);
  const remaining = counters.byStatus.pending + counters.byStatus.error + counters.byStatus.inflight;
  return {
    id: siteId,
    label: state.activeSiteId === siteId && state.activeLabel ? state.activeLabel : siteId,
    phase: latest?.phase ?? null,
    total: counters.total,
    byStatus: { ...counters.byStatus },
    progressPercent: counters.total > 0 ? Math.round((counters.byStatus.done / counters.total) * 100) : 0,
    magnetsFound: engine.sumReleases(siteId),
    newReleases: state.activeSiteId === siteId
      ? state.currentSiteNewReleases
      : (Number(latest?.counters?.newReleases) || 0),
    pendingRemaining: remaining,
    ratePerHour: Math.round(rate),
    etaHours: remaining > 0 ? Math.round((remaining / rate) * 10) / 10 : 0,
    latestRun: latest,
    recentWorks: engine.listByStatus(siteId, 'done', STATUS_LIST_LIMIT).map((r) => ({
      url: r.url, imdb: r.imdb, releases: r.releases, checkedAt: r.checkedAt,
    })),
    noWork: engine.listByStatus(siteId, 'no-work', STATUS_LIST_LIMIT).map((r) => ({ url: r.url, checkedAt: r.checkedAt })),
    errors: engine.listByStatus(siteId, 'error', STATUS_LIST_LIMIT).map((r) => ({
      url: r.url, error: r.error, tries: r.tries, checkedAt: r.checkedAt,
    })),
    errorGroups: engine.errorGroups(siteId, STATUS_ERROR_GROUPS_LIMIT),
  };
}

/** Foto completa do motor: topo (site ativo) + um card por site configurado. */
export function buildCrawlerStatus(
  engine: CrawlEngine | null,
  live: CrawlerEffectiveConfig,
  configuredSites: string[],
  state: CrawlMotorState,
) {
  const siteId = state.activeSiteId || String(configuredSites[0] || '');
  const sites = engine
    ? configuredSites.map((id) => buildSiteStatus(id, engine, live, state))
    : [];
  // O topo REUSA o card do site ativo em vez de repetir `counters`/`latestRun`:
  // o poll vital do painel não paga a mesma query duas vezes por ciclo.
  const active = sites.find((s) => s.id === siteId) ?? null;
  return {
    enabled: live.enabled,
    dryRun: live.dryRun,
    paused: state.paused,
    autoPause: state.autoPause,
    site: siteId || null,
    siteReady: state.siteReady,
    sitesConfigured: configuredSites,
    engine: engine ? engine.kind : null,
    cursor: state.cursor || null,
    pagesThisHour: state.pagesThisHour,
    maxPerHour: live.maxPerHour,
    delayMs: live.delayMs,
    idleWindowMs: live.idleWindowMs,
    errorStreak: state.errorStreak,
    canaryStreak: state.canaryStreak,
    runOpen: state.openRunId != null,
    cycle: { ...state.cycle },
    counters: active ? { total: active.total, byStatus: active.byStatus } : null,
    latestRun: active ? active.latestRun : null,
    sites,
  };
}
