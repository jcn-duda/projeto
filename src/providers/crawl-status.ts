// Montagem do STATUS do crawler para o painel (Fase 4 do plano "Raspagem
// total"; Fase 8 multi-site). Extraído de `crawler.ts` pela catraca de 400
// linhas: são funções PURAS sobre uma foto do motor — não tocam rede, store nem
// o timer. O motor captura o próprio estado e entrega aqui; assim o formato do
// card é testável sem subir o motor.
//
// COMPATIBILIDADE (Fase 8): o TOPO do bloco continua sendo a visão do site
// ATIVO (mesmos nomes, mesmos tipos de antes), e o detalhe por site vive em
// `sites[]` — um card por site CONFIGURADO, com o estado do runtime daquele
// site (pausa, ciclo, cursor, custo, teto, gate da sonda). Entrada legada
// (motor de site único, sem `sites`) continua aceito: as chamadas antigas
// montam uma vista única e o topo sai igual.
import type { CrawlEngine } from '../utils/crawl-store.js';
import { parseProgress } from '../utils/crawl-store-rules.js';
import { siteConfigOf, type CrawlerEffectiveConfig, type CrawlerSiteConfig } from '../utils/crawler-live-schema.js';
import type { ProbeGate } from './crawl-probe-gate.js';
import { siteCatalog } from './crawl-site-catalog.js';
import {
  legacyView, NEUTRAL_PROBE,
  type CrawlMotorState, type CrawlSiteRuntimeView, type CrawlerStatusInput, type SiteAutoPauseInfo, type SiteTableInfo,
} from './crawl-status-view.js';
import type { CrawlRunRow } from './crawl-types.js';

export type {
  CrawlMotorState, CrawlSiteRuntimeView, CrawlerStatusInput, SiteAutoPauseInfo, SiteTableInfo,
} from './crawl-status-view.js';
export { legacyView, NEUTRAL_PROBE } from './crawl-status-view.js';

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
  // --- Fase 8: estado do runtime daquele site ---
  /** Habilitado pelo `siteOverrides[id]` (herda o global quando ausente). */
  enabled: boolean;
  dryRun: boolean;
  /** Pausa manual DO SITE (a global fica no topo). */
  paused: boolean;
  /** Pausa automática DO SITE (streak de erro / canário de layout). */
  autoPause: { reason: string; at: number; detail: string } | null;
  /** Config efetiva (ritmo/teto próprios vêm daqui). */
  siteConfig: CrawlerSiteConfig;
  /** Gate da sonda: `ok:false` = o site não entra na rotação. */
  probe: ProbeGate;
  lastActiveAt: number;
  skipReason: string | null;
  runOpen: boolean;
  errorStreak: number;
  canaryStreak: number;
  cycle: Record<string, number>;
  cursor: string | null;
  cursors: { movie: string; tv_show: string };
  nextDiscoveryAt: number;
  pagesThisHour: number;
  maxPerHour: number;
  delayMs: number;
  /** Fração de ociosidade medida que o ETA usou (`null` = sem amostra). */
  idleFraction: number | null;
  /** De onde saiu o `etaHours` — o painel mostra, não recalcula no escuro. */
  etaBasis: 'medido' | 'sem-pendencia' | 'sem-custo-medido' | 'sem-ociosidade-medida';
  /** Tabela de sites: rótulo canônico e se HÁ adaptador nesta rodada. */
  site: { id: string; label: string; known: boolean; adapter: boolean; note: string | null };
}

/** Ritmo efetivo: o menor entre o teto por hora e o que o delay permite. */
export function rateFor(live: CrawlerEffectiveConfig): number {
  return rateOf(live.delayMs, live.maxPerHour);
}

/** Mesmo cálculo, sobre os números de UM site. */
export function rateOf(delayMs: number, maxPerHour: number): number {
  const byDelay = delayMs > 0 ? 3_600_000 / delayMs : maxPerHour;
  return Math.max(1, Math.min(byDelay, maxPerHour));
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

/**
 * Custo médio do SITE, em requisições por página — o que o ETA divide.
 *
 * É medido POR SITE (`view.avgRequestCost`), porque o custo é propriedade do
 * site: com o Vaca ativo e o NerdFilmes inativo, usar o custo do ativo dava ao
 * card do NerdFilmes o número do Vaca e um ETA otimista (1 h no lugar das 9 h
 * que a página de série custa). O `state` (escalar legado) é o FALLBACK do
 * caminho pré-Fase 8, em que existia um site só — e, com uma vista na mão, ele
 * NÃO é consulted: o custo de outro site é medida de outra obra, e usar isso
 * seria a mesma mentira com outro número. Sem custo medido, `null` (ETA "—").
 */
export function avgCostFor(view: CrawlSiteRuntimeView | undefined, state: CrawlMotorState): number | null {
  const own = view ? view.avgRequestCost : state.avgRequestCost;
  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : null;
}

/** Card de UM site. `null` quando o store ainda não abriu (nada a mostrar). */
export function buildSiteStatus(
  siteId: string,
  engine: CrawlEngine,
  live: CrawlerEffectiveConfig,
  state: CrawlMotorState,
  view?: CrawlSiteRuntimeView,
): SiteStatus {
  const counters = engine.counters(siteId);
  const latest = engine.latestRun(siteId);
  const siteConfig = view?.siteConfig ?? siteConfigOf(live, siteId);
  // `rateFor` é o teto de REQUISIÇÕES por hora (a Fase 7 cobra o custo real
  // da página de série no balde horário). ETA (M2): pendência de páginas ×
  // custo médio observado ÷ req/h — converter 1:1 subestimava séries em ~10×.
  // Sem custo observado nenhum (motor recém-armado), o ETA é null: mostra
  // "—" em vez de horas inventadas. O custo é o DO CARD (Fase 8), nunca o do
  // site ativo herdado pelo `state`.
  const rate = rateOf(siteConfig.delayMs, siteConfig.maxPerHour);
  const avgCost = avgCostFor(view, state);
  // OCIOSIDADE (Fase 8): o teto por hora só é verdade com o app ocioso, e o
  // freio de tráfego é justamente a janela que raspa a maior parte da noite.
  // Dividir a pendência por `rate` sem isso prometeu "12 h" numa VPS que
  // esperou a janela de 10 min. Sem amostra medida o ETA é `null` ("—"); a
  // forma legada (sem `view`, anterior à Fase 8) mantém a suposição de 100%.
  const idle = view ? view.idleFraction : 1;
  // `simulated` é trabalho restante: a página foi lida em dry-run e ainda
  // precisa de uma passada com gravação. `partial` idem: página de série em
  // andamento (Fase 7 v2).
  const remaining = counters.byStatus.pending + counters.byStatus.error
    + counters.byStatus.inflight + counters.byStatus.simulated + counters.byStatus.partial;
  const etaKnown = avgCost != null && idle != null;
  const etaHours = remaining > 0
    ? (etaKnown ? Math.round(((remaining * avgCost) / (rate * idle)) * 10) / 10 : null)
    : 0;
  const etaBasis: SiteStatus['etaBasis'] = remaining === 0 ? 'sem-pendencia'
    : avgCost == null ? 'sem-custo-medido'
      : idle == null ? 'sem-ociosidade-medida' : 'medido';
  const cursors = view?.cursors ?? state.cursors;
  return {
    id: siteId,
    label: view?.label ?? (state.activeSiteId === siteId && state.activeLabel ? state.activeLabel : siteId),
    phase: latest?.phase ?? null,
    total: counters.total,
    byStatus: { ...counters.byStatus },
    progressPercent: counters.total > 0 ? Math.round((counters.byStatus.done / counters.total) * 100) : 0,
    magnetsFound: engine.sumReleases(siteId),
    newReleases: view ? view.currentSiteNewReleases : (state.activeSiteId === siteId
      ? state.currentSiteNewReleases
      : (Number(latest?.counters?.newReleases) || 0)),
    pendingRemaining: remaining,
    ratePerHour: Math.round(rate),
    etaHours,
    etaBasis,
    idleFraction: idle,
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
    // --- Fase 8: o runtime daquele site ---
    enabled: view ? view.enabled : siteConfig.enabled,
    dryRun: view ? view.dryRun : siteConfig.dryRun,
    paused: view ? view.paused : (state.activeSiteId === siteId ? state.paused : false),
    autoPause: view ? view.autoPause : (state.activeSiteId === siteId ? state.autoPause : null),
    siteConfig,
    probe: view?.probe ?? NEUTRAL_PROBE,
    lastActiveAt: view?.lastActiveAt ?? 0,
    skipReason: view?.skipReason ?? null,
    runOpen: view ? view.openRunId != null : (state.activeSiteId === siteId ? state.openRunId != null : false),
    errorStreak: view ? view.errorStreak : (state.activeSiteId === siteId ? state.errorStreak : 0),
    canaryStreak: view ? view.canaryStreak : (state.activeSiteId === siteId ? state.canaryStreak : 0),
    cycle: view ? { ...view.cycle } : (state.activeSiteId === siteId ? { ...state.cycle } : {}),
    cursor: cursors.movie || null,
    cursors: { ...cursors },
    nextDiscoveryAt: view ? view.nextDiscoveryAt : (state.activeSiteId === siteId ? state.nextDiscoveryAt : 0),
    pagesThisHour: view ? view.pagesThisHour : (state.activeSiteId === siteId ? state.pagesThisHour : 0),
    maxPerHour: siteConfig.maxPerHour,
    delayMs: siteConfig.delayMs,
    site: view?.site ?? { id: siteId, label: siteId, known: false, adapter: true, note: null },
  };
}


/** Foto completa do motor: topo (visão do site ativo) + um card por site. */
export function buildCrawlerStatus(
  engine: CrawlEngine | null,
  live: CrawlerEffectiveConfig,
  configuredSites: string[],
  input: CrawlerStatusInput,
) {
  const siteId = input.active ?? input.activeSiteId ?? String(configuredSites[0] || '');
  // Fase 8: um card por site CONFIGURADO. A entrada legada (motor de site
  // único) monta a vista do site ATIVO e vistas neutras para o resto — o card
  // continua existindo para cada site configurado, como antes da Fase 8.
  const views: CrawlSiteRuntimeView[] = (input.sites && input.sites.length > 0)
    ? input.sites
    : configuredSites.map((id) => (id === siteId
      ? legacyView(input, live, id)
      : { ...legacyView({ ...input, activeSiteId: id, activeLabel: null }, live, id), ready: false }));
  // O estado escalar que o card legado recebe: o da vista ATIVA, para os campos
  // derivados (`newReleases`) virem do site certo. `avgRequestCost` vem junto
  // pela mesma foto, mas SÓ como fallback: com a vista na mão, o card lê o
  // custo do próprio site (`avgCostFor`) — o do ativo aqui daria ao site
  // inativo o ETA de outro.
  const activeView = views.find((v) => v.id === siteId) ?? views[0] ?? null;
  const legacyState: CrawlMotorState = {
    activeSiteId: activeView?.id ?? '',
    activeLabel: activeView?.label ?? null,
    paused: activeView?.paused ?? false,
    autoPause: activeView?.autoPause ?? null,
    cursors: activeView?.cursors ?? { movie: '', tv_show: '' },
    nextDiscoveryAt: activeView?.nextDiscoveryAt ?? 0,
    pagesThisHour: activeView?.pagesThisHour ?? 0,
    openRunId: activeView?.openRunId ?? null,
    errorStreak: activeView?.errorStreak ?? 0,
    canaryStreak: activeView?.canaryStreak ?? 0,
    cycle: activeView?.cycle ?? {},
    currentSiteNewReleases: activeView?.currentSiteNewReleases ?? 0,
    siteReady: activeView?.ready ?? false,
    avgRequestCost: activeView?.avgRequestCost ?? null,
  };
  const sites = engine
    ? views.map((view) => buildSiteStatus(view.id, engine, live, legacyState, view))
    : [];
  // O topo REUSA o card do site ativo em vez de repetir `counters`/`latestRun`:
  // o poll vital do painel não paga a mesma query duas vezes por ciclo.
  const active = sites.find((s) => s.id === siteId) ?? sites[0] ?? null;
  return {
    enabled: live.enabled,
    // O topo é a visão do site ATIVO: ritmo, teto e dry-run Effectivos saem do
    // card dele, e não do global — a diferença só aparece com `siteOverrides`.
    dryRun: active?.dryRun ?? live.dryRun,
    paused: input.globalPaused ?? input.paused ?? false,
    globalPaused: input.globalPaused ?? input.paused ?? false,
    site: siteId || null,
    active: siteId || null,
    siteReady: legacyState.siteReady,
    sitesConfigured: configuredSites,
    engine: engine ? engine.kind : null,
    // Compat: cursor de filme; o mapa por kind (`cursors`) é o canônico (F2).
    cursor: activeView?.cursors.movie || null,
    cursors: { ...(activeView?.cursors ?? { movie: '', tv_show: '' }) },
    nextDiscoveryAt: activeView?.nextDiscoveryAt ?? 0,
    pagesThisHour: activeView?.pagesThisHour ?? 0,
    // Fase 8: o teto do PROCESSO é a soma dos sites. Site com teto próprio não
    // multiplica o orçamento de educação com o servidor inteiro.
    pagesThisHourTotal: input.pagesThisHourTotal ?? activeView?.pagesThisHour ?? 0,
    maxPerHourTotal: input.maxPerHourTotal ?? live.maxPerHour,
    maxPerHour: active?.maxPerHour ?? live.maxPerHour,
    delayMs: active?.delayMs ?? live.delayMs,
    idleWindowMs: live.idleWindowMs,
    errorStreak: activeView?.errorStreak ?? 0,
    canaryStreak: activeView?.canaryStreak ?? 0,
    runOpen: activeView ? activeView.openRunId != null : false,
    cycle: { ...(activeView?.cycle ?? {}) },
    autoPause: activeView?.autoPause ?? null,
    counters: active ? { total: active.total, byStatus: active.byStatus } : null,
    latestRun: active ? active.latestRun : null,
    sites,
    // Tabela BR com liga/desliga e saúde de cada site (o painel liga fora do `.env`).
    catalog: siteCatalog(live, new Map(sites.map((s) => [s.id, s]))),
  };
}
