// Fase 8 (multi-site): overrides POR SITE da config ao vivo do crawler.
// Extraído de `crawler-live-schema.ts` pela catraca de 400 linhas e do mesmo
// motivo do resto do arquivo: o schema é a ÚNICA fonte dos limites, e o mapa
// por site tem regras próprias (subset FECHADO de chaves, clamps espelhados e
// uma TRAVA de segurança que o global não tem).
//
// `siteOverrides[id]` guarda só o que o operador sobrescreveu; o resto herda
// o global. A fusão (`siteConfigOf`) é o único ponto onde as duas se misturam.
//
// TRAVA DE SEGURANÇA (Fase 8): o override de um site NUNCA afrouxa o global
// nos knobs de educação com o site — o `delayMs` do site só pode AUMENTAR (é
// um piso de ritmo, não um acelerador) e o `maxPerHour` do site só pode
// DIMINUIR (é um teto, não um multiplicador). Sem isso, oito sites com teto
// próprio dariam 8× o orçamento horário do processo. Já `enabled`/`dryRun` são
// decisão local e valem como estão: o kill-switch GLOBAL (`enabled` do motor) é
// verificado à parte, e um site habilitado não burla motor desligado.
import type { CrawlerEffectiveConfig } from './crawler-live-schema.js';

/** Campos que um override por site pode sobrescrever (subset fechado). */
export const SITE_OVERRIDE_KEYS = ['enabled', 'dryRun', 'delayMs', 'maxPerHour'] as const;

export type CrawlerSiteOverrideKey = (typeof SITE_OVERRIDE_KEYS)[number];

/** Override persistido de UM site (só o que foi sobrescrito). */
export type CrawlerSiteOverride = Partial<Record<CrawlerSiteOverrideKey, boolean | number>>;

/** Mapa de overrides por site (a chave ausente = sem override). */
export type CrawlerSiteOverrides = Record<string, CrawlerSiteOverride>;

/** Config EFETIVA de um site: global + override do site, já resolvida. */
export interface CrawlerSiteConfig {
  enabled: boolean;
  dryRun: boolean;
  delayMs: number;
  maxPerHour: number;
  /** Demais knobs: herdados do global (não são sobrescritíveis por site). */
  idleWindowMs: number;
  maxTries: number;
  errorPauseStreak: number;
  layoutCanary: number;
  incrementalIntervalMin: number;
  seriesEnabled: boolean;
  seriesMaxCards: number;
  seriesMaxButtons: number;
  /** Gate da sonda (Fase 8): só global. */
  requireProbe: boolean;
  /** Chaves que vieram de `siteOverrides` (para o painel marcar o que é local). */
  overridden: CrawlerSiteOverrideKey[];
}

/** Fusão de um override sobre a config global (chaves ausentes herdam). */
export function siteConfigOf(live: CrawlerEffectiveConfig, siteId: string): CrawlerSiteConfig {
  const over = (live.siteOverrides && live.siteOverrides[siteId]) || {};
  const has = (key: CrawlerSiteOverrideKey): boolean => Object.prototype.hasOwnProperty.call(over, key);
  const overridden = SITE_OVERRIDE_KEYS.filter(has);
  const delay = has('delayMs') ? Number(over.delayMs) : live.delayMs;
  const cap = has('maxPerHour') ? Number(over.maxPerHour) : live.maxPerHour;
  return {
    // `enabled` ausente = o site está ligado (ele está em `CRAWL_SITES`); o
    // kill-switch do MOTOR é o `enabled` global, verificado no tick.
    enabled: has('enabled') ? over.enabled === true : true,
    dryRun: has('dryRun') ? over.dryRun === true : live.dryRun,
    // Trava de segurança: o site só pode ser MAIS lento e ter MENOS teto.
    delayMs: Math.max(live.delayMs, Math.trunc(delay) || 0),
    maxPerHour: Math.max(1, Math.min(live.maxPerHour, Math.trunc(cap) || live.maxPerHour)),
    idleWindowMs: live.idleWindowMs,
    maxTries: live.maxTries,
    errorPauseStreak: live.errorPauseStreak,
    layoutCanary: live.layoutCanary,
    incrementalIntervalMin: live.incrementalIntervalMin,
    seriesEnabled: live.seriesEnabled,
    seriesMaxCards: live.seriesMaxCards,
    seriesMaxButtons: live.seriesMaxButtons,
    requireProbe: live.requireProbe,
    overridden,
  };
}

/**
 * Cadência do TIMER: o menor `delayMs` entre os sites que podem trabalhar.
 * Com ritmo por site, armar o timer pelo delay global atrasaria o site mais
 * rápido (500 ms pedidos por um site de 5 s nunca seria servido); o piso de
 * 500 ms e o teto de 60 s são os mesmos do `crawl-scheduler.ts`.
 */
export function cadenceDelayMs(live: CrawlerEffectiveConfig): number {
  const delays = live.sites
    .map((id) => String(id || ''))
    .filter(Boolean)
    .map((id) => siteConfigOf(live, id))
    .filter((cfg) => cfg.enabled)
    .map((cfg) => cfg.delayMs);
  if (delays.length === 0) return live.delayMs;
  return Math.min(...delays);
}

/** Mesma fusão, com o campo de ritmo trocado pela cadência do timer. */
export function withCadence(live: CrawlerEffectiveConfig): CrawlerEffectiveConfig {
  const next = cadenceDelayMs(live);
  return next === live.delayMs ? live : { ...live, delayMs: next };
}

// Clamps por site: os MESMOS do caminho global, para que um override não
// escape da validação por entrar por outra porta (`delayMs` 0..60.000,
// `maxPerHour` 1..20.000). As travas de segurança de `siteConfigOf` são outra
// camada: aqui é teto de VALIDADE, lá é teto de POLÍTICA.
const SITE_CLAMPS: Record<string, (n: number) => number> = {
  delayMs: (n) => Math.max(0, Math.min(60_000, Math.trunc(n))),
  maxPerHour: (n) => Math.max(1, Math.min(20_000, Math.trunc(n))),
};

/**
 * Valida o patch de UM site. Subconjunto FECHADO
 * (`enabled`/`dryRun`/`delayMs`/`maxPerHour`): chave fora do conjunto é erro,
 * nunca ignorada em silêncio — o painel manda JSON de usuário.
 */
export function sanitizeSitePatch(siteId: string, patch: Record<string, unknown>): {
  clean: CrawlerSiteOverride;
  errors: string[];
} {
  const clean: CrawlerSiteOverride = {};
  const errors: string[] = [];
  const site = String(siteId || '').trim();
  if (!site) return { clean, errors: ['site obrigatório'] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { clean, errors: ['Payload inválido'] };
  }
  for (const [k, val] of Object.entries(patch)) {
    const key = k as CrawlerSiteOverrideKey;
    if (!SITE_OVERRIDE_KEYS.includes(key)) {
      errors.push(`Chave desconhecida para o site "${site}": "${k}"`);
      continue;
    }
    if (key === 'enabled' || key === 'dryRun') {
      if (typeof val === 'boolean') clean[key] = val;
      else if (val === 'true' || val === 'false') clean[key] = val === 'true';
      else errors.push(`Valor inválido para "${k}": esperado boolean, recebido ${typeof val}`);
      continue;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) {
      errors.push(`Valor inválido para "${k}": esperado número finito, recebido ${val}`);
      continue;
    }
    clean[key] = SITE_CLAMPS[key](n);
  }
  return { clean, errors };
}
