// Catálogo de sites da raspagem para o painel: a tabela BR inteira (com e sem
// adaptador), cada linha com o liga/desliga EFETIVO, de onde ele vem e a
// SAÚDE do site (no ar ou caído). É o que o painel usa para o toggle por site —
// inclusive para o site que NÃO está em `CRAWL_SITES` (ligar por override é o
// caminho sem editar o `.env` da VPS, que o deploy não toca).
//
// Leitura pura sobre a tabela estática do registro, a config ao vivo e as
// medições que já existem: não resolve adaptador, não abre store, não sonda.
import { SITE_TABLE } from './crawl-sites/registry.js';
import * as indexerStatus from './indexer-status.js';
import { knownSites, siteConfigOf, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';

/** Saúde do site: é o que pinta o toggle (verde = no ar). */
export type CrawlSiteHealth = 'online' | 'instavel' | 'offline' | 'unknown';

/** Evidência da PRÓPRIA raspagem sobre o site (do card do motor). */
export interface CrawlSiteEvidence {
  autoPause: { reason: string } | null;
  errorStreak: number;
  lastActiveAt: number;
}

export interface CrawlCatalogEntry {
  id: string;
  label: string;
  /** Há adaptador nesta rodada (sem ele o painel não oferece ligar). */
  adapter: boolean;
  note: string | null;
  /** Está em `CRAWL_SITES` (default do `.env`: ligado). */
  inEnv: boolean;
  /** Tem card no motor (`.env` ou override do painel). */
  configured: boolean;
  /** Liga/desliga EFETIVO do site (override do painel vence o `.env`). */
  enabled: boolean;
  /** O `enabled` veio de override do painel, não do `.env`. */
  enabledOverridden: boolean;
  health: CrawlSiteHealth;
  /** De onde veio a saúde, em texto curto para o painel. */
  healthDetail: string;
}

/**
 * Janela em que uma página servida sem erro ainda prova "no ar". Maior que o
 * freio de tráfego típico (10 min) para o site não piscar cinza a cada
 * pausa por tráfego, e curta o bastante para não afirmar um site de ontem.
 */
export const CRAWL_HEALTH_WINDOW_MS = 30 * 60_000;

/**
 * Saúde do site, da evidência mais forte para a mais fraca:
 *
 *   1. pausa automática da raspagem (streak de erro / canário de layout):
 *      caído — é o motor dizendo que o site parou de responder como devia;
 *   2. erros seguidos na raspagem sem pausa ainda: instável;
 *   3. página servida pela raspagem há pouco, sem erro: no ar;
 *   4. última medição do card no Jackett (busca real): `online` no ar,
 *      `slow`/`degraded` instável, `offline` caído;
 *   5. nada medido: desconhecido — nunca "online" por omissão.
 */
export function siteHealth(
  id: string,
  evidence: CrawlSiteEvidence | undefined,
  now = Date.now(),
): { health: CrawlSiteHealth; detail: string } {
  if (evidence?.autoPause) {
    return { health: 'offline', detail: `raspagem pausou sozinha (${evidence.autoPause.reason})` };
  }
  if (evidence && evidence.errorStreak > 0) {
    return { health: 'instavel', detail: `${evidence.errorStreak} erro(s) seguido(s) na raspagem` };
  }
  if (evidence && evidence.lastActiveAt > 0 && now - evidence.lastActiveAt <= CRAWL_HEALTH_WINDOW_MS) {
    const min = Math.max(0, Math.round((now - evidence.lastActiveAt) / 60_000));
    return { health: 'online', detail: `raspagem respondeu há ${min} min` };
  }
  const status = indexerStatus.get(id, now);
  if (status?.state === 'online') return { health: 'online', detail: 'busca no Jackett respondeu' };
  if (status?.state === 'slow' || status?.state === 'degraded') {
    return { health: 'instavel', detail: `busca no Jackett: ${status.state}` };
  }
  if (status?.state === 'offline') return { health: 'offline', detail: 'busca no Jackett falhou' };
  return { health: 'unknown', detail: 'sem medição recente' };
}

export function siteCatalog(
  live: CrawlerEffectiveConfig,
  evidence: Map<string, CrawlSiteEvidence> = new Map(),
  now = Date.now(),
): CrawlCatalogEntry[] {
  const configured = new Set(knownSites(live));
  const inEnv = new Set(live.sites.map((s) => String(s || '').trim()));
  return SITE_TABLE.map((entry) => {
    const adapter = Boolean(entry.module && entry.exportName);
    const cfg = siteConfigOf(live, entry.id);
    const { health, detail } = siteHealth(entry.id, evidence.get(entry.id), now);
    return {
      id: entry.id,
      label: entry.label,
      adapter,
      note: adapter ? null : (entry.note ?? 'sem adaptador'),
      inEnv: inEnv.has(entry.id),
      configured: configured.has(entry.id),
      // Sem card no motor o site não trabalha, mesmo que a fusão diga `true`.
      enabled: configured.has(entry.id) && cfg.enabled,
      enabledOverridden: cfg.overridden.includes('enabled'),
      health,
      healthDetail: detail,
    };
  });
}
