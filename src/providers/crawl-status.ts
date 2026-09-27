// Montagem do STATUS do crawler para o painel (Fase 4 do plano "Raspagem
// total"). Extraído de `crawler.ts` pela catraca de 400 linhas: são funções
// PURAS sobre uma foto do motor — não tocam rede, store nem o timer. O motor
// captura o próprio estado e entrega aqui; assim o formato do card é testável
// sem subir o motor.
import type { CrawlEngine } from '../utils/crawl-store.js';
import { parseProgress } from '../utils/crawl-store-rules.js';
import type { CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { CrawlRunRow } from './crawl-types.js';

/** Estado escalar do motor necessário para montar o status. */
export interface CrawlMotorState {
  activeSiteId: string;
  activeLabel: string | null;
  paused: boolean;
  autoPause: { reason: string; at: number; detail: string } | null;
  /** Cursor incremental POR KIND (F2). `cursor` (filme) segue no status por
   * compat; o mapa completo é o campo canônico. */
  cursors: { movie: string; tv_show: string };
  /** Próxima descoberta agendada (epoch ms); 0 = devida. Fase 6. */
  nextDiscoveryAt: number;
  pagesThisHour: number;
  openRunId: number | null;
  errorStreak: number;
  canaryStreak: number;
  cycle: Record<string, number>;
  /** `newReleases` do ciclo corrente (só vale para o site ativo). */
  currentSiteNewReleases: number;
  siteReady: boolean;
  /** Custo médio observado (requisições por página) desde o boot; `null`
   * quando nenhuma página foi medida ainda — o ETA honesto é "—". */
  avgRequestCost?: number | null;
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
  /** Páginas lidas em dry-run aguardando gravação real (contagem do store). */
  simulatedAwaiting: number;
  /** Páginas de série em andamento (Fase 7 v2) com o progresso x/y. */
  partialWork: Array<{ url: string; done: number; total: number; checkedAt: number }>;
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

/**
 * Motivo ESTÁVEL de agrupamento (M2): a truncagem de série grava detalhes no
 * `error` (cards 2/4, botões 40/40 variam por página) e viraria um grupo por
 * página no painel. O motivo canônico é o rótulo antes do `:`; o detalhe
 * segue visível na lista de erros recentes, no log e na métrica
 * `crawl.page.series-truncated`.
 */
export function stableErrorReason(rawError: string): string {
  const text = String(rawError || '').trim();
  if (/^series_truncated\b/i.test(text)) return 'series_truncated';
  // Estouro de progresso (Fase 7 v2): o detalhe (cards x/y) varia — o motivo
  // estável agrupa; convive com o legado `series_truncated` (linhas `error`
  // antigas) e com o estouro novo.
  if (/^series_stall\b/i.test(text)) return 'series_stall';
  return text || 'erro';
}

/** Agrupa os motivos crus pelo motivo estável, somando as ocorrências e
 * mantendo a ordem de frequência (desempate: motivo estável primeiro). */
function mergeErrorGroups(
  groups: Array<{ reason: string; count: number }>,
): Array<{ reason: string; count: number }> {
  const merged = new Map<string, number>();
  let order: string[] = [];
  for (const g of groups) {
    const key = stableErrorReason(g.reason);
    if (!merged.has(key)) order.push(key);
    merged.set(key, (merged.get(key) || 0) + g.count);
  }
  // Mesma ordenação do store (count desc), com desempate determinístico.
  return [...order]
    .sort((a, b) => (merged.get(b) || 0) - (merged.get(a) || 0) || (a < b ? -1 : a > b ? 1 : 0))
    .map((reason) => ({ reason, count: merged.get(reason) || 0 }));
}

/** Card de UM site. `null` quando o store ainda não abriu (nada a mostrar). */
export function buildSiteStatus(
  siteId: string,
  engine: CrawlEngine,
  live: CrawlerEffectiveConfig,
  state: CrawlMotorState,
): SiteStatus {
  const counters = engine.counters(siteId);
  const latest = engine.latestRun(siteId);
  // `rateFor` é o teto de REQUISIÇÕES por hora (a Fase 7 cobra o custo real
  // da página de série no balde horário). ETA (M2): pendência de páginas ×
  // custo médio observado ÷ req/h — converter 1:1 subestimava séries em ~10×.
  // Sem custo observado nenhum (motor recém-armado), o ETA é null: mostra
  // "—" em vez de horas inventadas.
  const rate = rateFor(live);
  const avgCost = typeof state.avgRequestCost === 'number' && Number.isFinite(state.avgRequestCost) && state.avgRequestCost > 0
    ? state.avgRequestCost
    : null;
  // `simulated` é trabalho restante: a página foi lida em dry-run e ainda
  // precisa de uma passada com gravação. `partial` idem: página de série em
  // andamento (Fase 7 v2).
  const remaining = counters.byStatus.pending + counters.byStatus.error
    + counters.byStatus.inflight + counters.byStatus.simulated + counters.byStatus.partial;
  const etaHours = remaining > 0
    ? (avgCost != null ? Math.round(((remaining * avgCost) / rate) * 10) / 10 : null)
    : 0;
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
    etaHours,
    latestRun: latest,
    recentWorks: engine.listByStatus(siteId, 'done', STATUS_LIST_LIMIT).map((r) => ({
      url: r.url, imdb: r.imdb, releases: r.releases, checkedAt: r.checkedAt,
    })),
    noWork: engine.listByStatus(siteId, 'no-work', STATUS_LIST_LIMIT).map((r) => ({ url: r.url, checkedAt: r.checkedAt })),
    /** Páginas lidas em dry-run aguardando gravação (dry-run desligar reenfileira). */
    simulatedAwaiting: counters.byStatus.simulated,
    // Séries em andamento (Fase 7 v2): x/y cards lidos, do progresso gravado.
    partialWork: engine.listByStatus(siteId, 'partial', STATUS_LIST_LIMIT).map((r) => {
      const p = parseProgress(r.progress);
      return {
        url: r.url,
        done: p ? p.doneCards.length : 0,
        total: p ? p.totalCards : 0,
        checkedAt: r.checkedAt,
      };
    }),
    errors: engine.listByStatus(siteId, 'error', STATUS_LIST_LIMIT).map((r) => ({
      url: r.url, error: r.error, tries: r.tries, checkedAt: r.checkedAt,
    })),
    // Motivo estável no agrupamento (M2): `series_truncated: …(cards 2/4…)`
    // varia por página — o painel agrupa pelo rótulo, o detalhe fica na lista.
    errorGroups: mergeErrorGroups(engine.errorGroups(siteId, STATUS_ERROR_GROUPS_LIMIT)),
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
    // Compat: cursor de filme; o mapa por kind (`cursors`) é o canônico (F2).
    cursor: state.cursors.movie || null,
    cursors: { ...state.cursors },
    nextDiscoveryAt: state.nextDiscoveryAt,
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
