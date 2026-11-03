// Vitals do card do raspador (Fase 4.1/2.1 + esperas do /status do sidecar).
// Duas fontes, as duas OPCIONAIS e fail-open:
//
// - o bloco `sites[]` do backend (crawl-status.ts) traz os vitals da foto
//   (ritmo, 429, expirado, snapshotAt);
// - o bloco `sidecar` (foto crua do GET /status) traz `holds: [{site_id,
//   until_ms}]`, `deferred_count` e `pages_this_hour` — campos do motor Rust
//   com serde SNAKE_CASE. O contrato do MotorStatus é novo: campo ausente =
//   linha escondida, nunca 0 afirmado nem card quebrado (padrão
//   streams-stats-native: sem backoff, mostra "—").
import type { CrawlSiteCard } from './raspagens-model.js';
import { etaLabel } from './raspagens-model.js';
import { ageText } from './raspagens-site.js';

/** Espera ativa de UM site ("em espera até"): epoch ms em que o motor solta. */
export interface SidecarExtras {
  /** siteId → until_ms do hold vigente. Vazio = campo ausente ou sem hold. */
  holds: Map<string, number>;
  /** Linhas adiadas pelo motor (teto/espera); `null` = campo não veio. */
  deferredCount: number | null;
  /** Balde horário GLOBAL do sidecar (requests); `null` = campo não veio. */
  pagesThisHour: number | null;
}

const EMPTY_EXTRAS: SidecarExtras = { holds: new Map(), deferredCount: null, pagesThisHour: null };

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Extras do `/status` do sidecar. O serde do Rust serializa snake_case
 * (`site_id`, `until_ms`, `deferred_count`, `pages_this_hour`); a leitura
 * tolera camelCase por segurança (o contrato pode vir a renomear). Hold com
 * `until_ms` no passado NÃO entra no mapa: espera vencida não é "em espera".
 */
export function sidecarExtras(crawl: Record<string, any> | null | undefined): SidecarExtras {
  const sidecar = asObject(asObject(crawl)?.sidecar);
  if (!sidecar) return EMPTY_EXTRAS;
  const holds = new Map<string, number>();
  for (const raw of asArray(sidecar.holds)) {
    const hold = asObject(raw);
    if (!hold) continue;
    const siteId = String(hold.site_id ?? hold.siteId ?? '').trim();
    const until = numOrNull(hold.until_ms ?? hold.untilMs);
    if (!siteId || until == null) continue;
    holds.set(siteId, until);
  }
  return {
    holds,
    deferredCount: numOrNull(sidecar.deferred_count ?? sidecar.deferredCount),
    pagesThisHour: numOrNull(sidecar.pages_this_hour ?? sidecar.pagesThisHour),
  };
}

/** "Em espera até" do site; `null` = sem hold para ele (a linha some). */
export function holdForSite(extras: SidecarExtras, siteId: string, now = Date.now()): number | null {
  const until = extras.holds.get(siteId);
  if (until == null || until <= now) return null;
  return until;
}

/** until_ms → rótulo relativo ("em 3min" / "em 2h 5min"). Chamado só com
 * hold vigente, então o passado não deveria chegar; por segurança, vira
 * "liberando" em vez de hora negativa. */
export function holdLabel(untilMs: number, now = Date.now()): string {
  const minutes = Math.ceil((untilMs - now) / 60_000);
  if (minutes <= 0) return 'liberando';
  if (minutes < 60) return `em ${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `em ${h}h ${m}min` : `em ${h}h`;
}

/** Vitals de UM site lidos do payload CRU do bloco (`sites[]` do backend).
 * Campo ausente vira `null` (não 0): o rótulo some em vez de afirmar medida. */
export interface SiteVitalsView {
  pagesLastHour: number | null;
  pagesSample: number | null;
  pagesSaturated: boolean;
  http429: { total: number | null; lastHour: number | null };
  expired: { total: number | null; lastHour: number | null };
  /** Epoch ms da última foto; `null` = sidecar nunca respondeu a este site. */
  snapshotAt: number | null;
}

function statView(raw: unknown): { total: number | null; lastHour: number | null } {
  const stat = asObject(raw);
  return {
    total: numOrNull(stat?.total),
    lastHour: numOrNull(stat?.lastHour),
  };
}

export function siteVitalsOf(crawl: Record<string, any> | null | undefined, siteId: string): SiteVitalsView {
  const site = asArray(asObject(crawl)?.sites)
    .map((s) => asObject(s))
    .find((s) => s && String(s.id ?? '') === siteId);
  if (!site) {
    return {
      pagesLastHour: null, pagesSample: null, pagesSaturated: false,
      http429: { total: null, lastHour: null }, expired: { total: null, lastHour: null },
      snapshotAt: null,
    };
  }
  return {
    pagesLastHour: numOrNull(site.pagesLastHour),
    pagesSample: numOrNull(site.pagesSample),
    pagesSaturated: site.pagesSaturated === true,
    http429: statView(site.http429),
    expired: statView(site.expired),
    snapshotAt: numOrNull(site.snapshotAt),
  };
}

/** "≥N pág/h" quando a amostra saturou (não dá para fechar o número). */
export function observedRateLabel(vitals: SiteVitalsView): string {
  if (vitals.pagesLastHour == null) return '';
  const prefix = vitals.pagesSaturated ? '≥' : '';
  return `${prefix}${vitals.pagesLastHour} pág/h`;
}

/**
 * ETA por ritmo observado (Fase 4.1): pendência ÷ páginas/h medido. Com ritmo
 * 0 (ou não medido) devolve `null` — "—" é do chamador; um ETA inventado por
 * divisão por zero nunca. O ETA medido do backend (custo real × ociosidade)
 * tem precedência fora daqui: este é o fallback honesto quando o custo médio
 * ainda não existe.
 */
export function etaByRateLabel(pendingRemaining: number, pagesLastHour: number | null): string | null {
  if (pagesLastHour == null || pagesLastHour <= 0 || pendingRemaining <= 0) return null;
  return etaLabel(pendingRemaining / pagesLastHour);
}

/** "429: X (Y na última hora)" — some quando nada medido nem ocorrido. */
export function http429Label(stat: { total: number | null; lastHour: number | null }): string {
  if (stat.total == null || stat.total <= 0) return '';
  if (stat.lastHour != null && stat.lastHour > 0) return `429: ${stat.total} (${stat.lastHour} na última hora)`;
  return `429: ${stat.total}`;
}

/** "expirados: X (Y na última hora)" — a taxa do portão (BLUDV e afins). */
export function expiredLabel(stat: { total: number | null; lastHour: number | null }): string {
  if (stat.total == null || stat.total <= 0) return '';
  if (stat.lastHour != null && stat.lastHour > 0) return `expirados: ${stat.total} (${stat.lastHour} na última hora)`;
  return `expirados: ${stat.total}`;
}

/** Idade da foto: separa "site zerado" de "foto não chega". `null` = nunca
 * veio foto (sidecar fora): a linha vira o aviso, não a idade. */
export function snapshotAgeLabel(vitals: SiteVitalsView, now = Date.now()): string {
  if (vitals.snapshotAt == null) return 'sem foto do sidecar';
  return `foto ${ageText(vitals.snapshotAt, now)}`;
}

/** Linha única de vitals para o card — só com o que existe de verdade. */
export function vitalsLine(vitals: SiteVitalsView): string {
  const parts: string[] = [];
  const rate = observedRateLabel(vitals);
  if (rate) parts.push(`ritmo observado ${rate}`);
  const four29 = http429Label(vitals.http429);
  if (four29) parts.push(four29);
  const expired = expiredLabel(vitals.expired);
  if (expired) parts.push(expired);
  return parts.join(' · ');
}

/** Linha de espera do site (hold do sidecar + adiadas do motor). */
export function holdLine(extras: SidecarExtras, siteId: string, now = Date.now()): string {
  const parts: string[] = [];
  const until = holdForSite(extras, siteId, now);
  if (until != null) parts.push(`em espera até ${holdLabel(until, now)}`);
  if (extras.deferredCount != null && extras.deferredCount > 0) {
    parts.push(`${extras.deferredCount} adiada(s) pelo motor`);
  }
  return parts.join(' · ');
}

/** ETA do card: o medido do backend primeiro; sem custo médio observado (o
 * caso do sidecar, que não manda `avgRequestCost` ao Node), o por-ritmo. */
export function cardEtaLabel(card: CrawlSiteCard, vitals: SiteVitalsView): string {
  if (card.pendingRemaining === 0 && card.total > 0) return 'concluído';
  if (card.etaHours != null && card.etaHours > 0) return etaLabel(card.etaHours);
  return etaByRateLabel(card.pendingRemaining, vitals.pagesLastHour) ?? '—';
}
