// Foto do motor por SITE (Fase 8) — os tipos que o motor entrega ao status e a
// conversão da entrada LEGADA (motor de site único). Extraído de
// `crawl-status.ts` pela catraca de 400 linhas: são contratos e uma Normalização,
// não a montagem do card.
//
// A entrada legada (`CrawlMotorState`, um site só) continua aceita de propósito:
// o topo do bloco do painel é a visão do site ATIVO e não pode quebrar quem
// chamava `buildCrawlerStatus` com o estado escalar.
import { siteConfigOf, type CrawlerEffectiveConfig, type CrawlerSiteConfig } from '../utils/crawler-live-schema.js';
import type { ProbeGate } from './crawl-probe-gate.js';

/** Estado escalar do motor (um site só) — a forma histórica do 4º argumento. */
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

/** Tabela de sites: o id é conhecido e HÁ adaptador nesta rodada? */
export interface SiteTableInfo {
  id: string; label: string; known: boolean; adapter: boolean; note: string | null;
}

/** Pausa automática (motivo, instante e detalhe) de um site. */
export interface SiteAutoPauseInfo {
  reason: string; at: number; detail: string;
}

/** Foto do runtime de UM site (Fase 8) — o motor monta uma por site. */
export interface CrawlSiteRuntimeView {
  id: string;
  label: string | null;
  ready: boolean;
  paused: boolean;
  autoPause: SiteAutoPauseInfo | null;
  cursors: { movie: string; tv_show: string };
  nextDiscoveryAt: number;
  pagesThisHour: number;
  openRunId: number | null;
  errorStreak: number;
  canaryStreak: number;
  cycle: Record<string, number>;
  currentSiteNewReleases: number;
  avgRequestCost: number | null;
  /** Fração de ociosidade OBSERVADA do site; `null` = ainda sem amostra. */
  idleFraction: number | null;
  enabled: boolean;
  dryRun: boolean;
  /** Config efetiva do site (global + `siteOverrides[id]`). */
  siteConfig: CrawlerSiteConfig;
  probe: ProbeGate;
  lastActiveAt: number;
  skipReason: string | null;
  site: SiteTableInfo;
}

/** Entrada do `buildCrawlerStatus`: multi-site (`sites`) ou legado. */
export interface CrawlerStatusInput {
  sites?: CrawlSiteRuntimeView[];
  /** Pausa manual GLOBAL do motor (a do site fica no card). */
  globalPaused?: boolean;
  /** Site ativo (o topo é a visão dele); `null` = nenhum. */
  active?: string | null;
  /** Teto horário AGREGADO do processo (soma de todos os sites da hora). */
  pagesThisHourTotal?: number;
  maxPerHourTotal?: number;
  // --- legado (motor de site único) ---
  activeSiteId?: string;
  activeLabel?: string | null;
  paused?: boolean;
  autoPause?: SiteAutoPauseInfo | null;
  cursors?: { movie: string; tv_show: string };
  nextDiscoveryAt?: number;
  pagesThisHour?: number;
  openRunId?: number | null;
  errorStreak?: number;
  canaryStreak?: number;
  cycle?: Record<string, number>;
  currentSiteNewReleases?: number;
  siteReady?: boolean;
  avgRequestCost?: number | null;
  idleFraction?: number | null;
}

/** Gate desligado (visão neutra: nunca barra e nunca afirma veredito). */
export const NEUTRAL_PROBE: ProbeGate = {
  required: false, verdict: null, ok: true, at: null, sample: null, blockedBy: null,
  // Sem veredito não há MEDIÇÃO: taxa ausente é `null` (o painel omite), e não
  // 0% — que afirmaria que a sonda rodou e reprovou.
  rates: null, counts: null, reasons: [],
};

/** Vista legada (motor de site único) convertida para a forma multi-site. */
export function legacyView(input: CrawlerStatusInput, live: CrawlerEffectiveConfig, siteId: string): CrawlSiteRuntimeView {
  const siteConfig = siteConfigOf(live, siteId);
  return {
    id: siteId,
    label: input.activeLabel ?? null,
    ready: input.siteReady ?? false,
    paused: input.paused ?? false,
    autoPause: input.autoPause ?? null,
    cursors: input.cursors ?? { movie: '', tv_show: '' },
    nextDiscoveryAt: input.nextDiscoveryAt ?? 0,
    pagesThisHour: input.pagesThisHour ?? 0,
    openRunId: input.openRunId ?? null,
    errorStreak: input.errorStreak ?? 0,
    canaryStreak: input.canaryStreak ?? 0,
    cycle: input.cycle ?? {},
    currentSiteNewReleases: input.currentSiteNewReleases ?? 0,
    avgRequestCost: input.avgRequestCost ?? null,
    // A forma legada é pré-Fase 8: não havia medida de ociosidade, e o ETA
    // antigo assumia 100% ocioso. O motor multi-site sempre manda a medida.
    idleFraction: input.idleFraction ?? 1,
    enabled: siteConfig.enabled,
    dryRun: siteConfig.dryRun,
    siteConfig,
    probe: NEUTRAL_PROBE,
    lastActiveAt: 0,
    skipReason: null,
    site: { id: siteId, label: input.activeLabel ?? siteId, known: false, adapter: true, note: null },
  };
}
