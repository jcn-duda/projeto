// Modelo PURO da aba Raspagens (Fase 4 do plano "Raspagem total"). Traduz o
// bloco `crawl` do `/dashboard-status.json` — `buildCrawlerStatus` + `config`
// ao vivo — em um resumo do motor e um card por site.
//
// Nenhum DOM, nenhum preact, nenhuma rede: as funções de componente são
// chamadas direto no teste. O contrato é TOLERANTE de propósito: o bloco pode
// vir ausente (aba aberta antes do poll), parcial (store ainda não abriu o
// `crawl.db`) ou com um site a menos. Campo ausente NÃO vira 0 afirmativo —
// vira 0 só onde "contagem zero" é a leitura honesta (contadores do store);
// listas ausentes viram `[]` e o rótulo de fase ausente é `—`, nunca um
// veredito inventado.
//
// A Fase 8 (multi-site) acrescenta por site o ajuste próprio (`siteConfig`) e o
// veredito da sonda (`probe`/`skipReason`), traduzidos pelo módulo IRMÃO
// `raspagens-site.ts` — dependência de mão única (lá só entram os TIPOS daqui).

import { siteOverride, siteProbe, type SiteOverrideView, type SiteProbeView } from './raspagens-site.js';

/** Foto escalar do motor (topo do bloco `crawl`). */
export interface CrawlSummary {
  enabled: boolean;
  dryRun: boolean;
  paused: boolean;
  autoPause: { reason: string; detail: string } | null;
  site: string | null;
  siteReady: boolean;
  sitesConfigured: string[];
  engine: string | null;
  cursor: string | null;
  /** Cursor POR KIND (F2/B1): filme e série andam separados. O campo canônico
   * do payload é `cursors`; o `cursor` solto é fallback de backend antigo
   * (vira o cursor de filme). */
  cursors: { movie: string | null; tv_show: string | null };
  /** Próxima descoberta agendada (epoch ms); 0 = devida; `null` = campo
   * ausente no payload (backend antigo). Fase 6. */
  nextDiscoveryAt: number | null;
  pagesThisHour: number;
  maxPerHour: number;
  delayMs: number;
  idleWindowMs: number;
  errorStreak: number;
  canaryStreak: number;
  runOpen: boolean;
  /** `CRAWL_REQUIRE_PROBE` efetivo (por site, resumido aqui para a linha do motor). */
  probeBlock: boolean;
}

export interface CrawlRunView {
  id: number | null;
  phase: 'initial' | 'incremental' | null;
  cursor: string | null;
  startedAt: number;
  finishedAt: number | null;
  counters: Record<string, number>;
}

export interface CrawlWorkRef {
  url: string;
  imdb: string | null;
  releases: number;
  checkedAt: number;
}

export interface CrawlNoWorkRef {
  url: string;
  checkedAt: number;
}

export interface CrawlErrorRef {
  url: string;
  error: string;
  tries: number;
  checkedAt: number;
}

export interface CrawlErrorGroupView {
  reason: string;
  count: number;
}

/** Card normalizado de UM site. */
export interface CrawlSiteCard {
  id: string;
  label: string;
  /** É o site ATIVO do motor (só ele avança neste momento). */
  active: boolean;
  phase: 'initial' | 'incremental' | null;
  total: number;
  done: number;
  pending: number;
  inflight: number;
  noTorrent: number;
  noWork: number;
  error: number;
  /** Páginas lidas em dry-run aguardando gravação real. */
  simulated: number;
  /** Páginas de série em andamento (Fase 7 v2): releases gravadas + progresso. */
  partial: number;
  progressPercent: number;
  /** % de páginas PROCESSADAS que resultaram em torrent (done ÷ processadas). */
  torrentPercent: number;
  magnetsFound: number;
  newReleases: number;
  pendingRemaining: number;
  ratePerHour: number;
  etaHours: number | null;
  latestRun: CrawlRunView | null;
  recentWorks: CrawlWorkRef[];
  noWorkList: CrawlNoWorkRef[];
  errors: CrawlErrorRef[];
  errorGroups: CrawlErrorGroupView[];
  /** Séries em andamento: cards lidos/total (retomada por passes). */
  partialWork: CrawlPartialRef[];
  /** Config EFETIVA do site (`siteConfig`, já fundido pelo motor com os
   * overrides) e o veredito da sonda — Fase 8. */
  override: SiteOverrideView;
  probe: SiteProbeView;
  /** Pausa manual DO SITE (`crawl-site-pause`): não é a pausa do motor. */
  paused: boolean;
}

/** Uma página de série `partial` com o progresso retomável (Fase 7 v2). */
export interface CrawlPartialRef {
  url: string;
  done: number;
  total: number;
  checkedAt: number;
}

export type BadgeVariant = 'ok' | 'warn' | 'err' | 'neutral';

export interface CrawlBadge {
  text: string;
  variant: BadgeVariant;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function phaseOf(value: unknown): 'initial' | 'incremental' | null {
  return value === 'initial' || value === 'incremental' ? value : null;
}

/** Cursor POR KIND (F2): mapa `movie`/`tv_show` do payload; backend sem o
 * mapa cai no `cursor` solto (era só de filme). Ausente é null — nunca "". */
function normalizeCursors(
  raw: unknown,
  fallbackMovie: unknown,
): { movie: string | null; tv_show: string | null } {
  const map = asObject(raw);
  return {
    movie: strOrNull(map?.movie) ?? strOrNull(fallbackMovie),
    tv_show: strOrNull(map?.tv_show),
  };
}

/** Resumo do topo. Aceita `null`/payload vazio (aba aberta antes do poll). */
export function crawlSummary(crawl: Record<string, any> | null | undefined): CrawlSummary {
  const c = crawl || {};
  const autoPause = asObject(c.autoPause);
  return {
    enabled: bool(c.enabled),
    dryRun: bool(c.dryRun),
    // `paused` é o campo de compat do topo; `globalPaused` é o nome do motor
    // multi-site. Precedência do primeiro, com o segundo como reserva.
    paused: typeof c.paused === 'boolean' ? c.paused : bool(c.globalPaused),
    autoPause: autoPause
      ? { reason: String(autoPause.reason ?? ''), detail: String(autoPause.detail ?? '') }
      : null,
    site: strOrNull(c.site),
    siteReady: bool(c.siteReady),
    sitesConfigured: asArray(c.sitesConfigured).map((s) => String(s || '')).filter(Boolean),
    engine: strOrNull(c.engine),
    cursor: strOrNull(c.cursor),
    cursors: normalizeCursors(c.cursors, c.cursor),
    nextDiscoveryAt: numOrNull(c.nextDiscoveryAt),
    pagesThisHour: num(c.pagesThisHour),
    maxPerHour: num(c.maxPerHour),
    delayMs: num(c.delayMs),
    idleWindowMs: num(c.idleWindowMs),
    errorStreak: num(c.errorStreak),
    canaryStreak: num(c.canaryStreak),
    runOpen: bool(c.runOpen),
    // O gate é decidido POR SITE (`sites[].probe.required`); o topo é só o
    // atalho da linha do motor.
    probeBlock: bool(c.probeBlock) || bool(c.requireProbe) || asArray(c.sites).some((s) => bool(asObject(s)?.probe?.required)),
  };
}

/** Badge de estado do motor. A ordem importa: pausa automática (falha real)
 * vence a pausa manual (escolha do operador), que vence o desligado. */
export function motorBadge(summary: CrawlSummary): CrawlBadge {
  if (summary.autoPause) return { text: 'PAUSA AUTOMÁTICA', variant: 'err' };
  if (summary.paused) return { text: 'PAUSADO', variant: 'warn' };
  if (!summary.enabled) return { text: 'DESLIGADO', variant: 'neutral' };
  if (summary.dryRun) return { text: 'SIMULAÇÃO', variant: 'warn' };
  return { text: 'ATIVO', variant: 'ok' };
}

export function phaseLabel(phase: 'initial' | 'incremental' | null): string {
  if (phase === 'initial') return 'Carga inicial';
  if (phase === 'incremental') return 'Incremental';
  return '—';
}

/** Próxima descoberta agendada → rótulo relativo. Campo ausente é `—`; hora
 * no passado (ou 0) é "devida" — nunca uma hora inventada. */
export function nextDiscoveryLabel(nextDiscoveryAt: number | null, now = Date.now()): string {
  if (nextDiscoveryAt == null) return '—';
  const minutes = Math.ceil((nextDiscoveryAt - now) / 60_000);
  if (minutes <= 0) return 'devida';
  if (minutes < 60) return `em ${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `em ${h}h ${m}min` : `em ${h}h`;
}

/** Rótulo do estado do SITE dentro do motor (o ativo é quem avança agora).
 * A EXCLUSÃO da rotação vence tudo: um site desligado ou sem GO não é "ativo"
 * nem "ocioso" — o operador precisa ver o porquê, não um estado genérico. */
export function siteStateLabel(card: CrawlSiteCard, summary: CrawlSummary): string {
  if (card.probe.out === 'desligado') return 'fora da rotação · desligado';
  if (card.probe.out === 'sem-go') return 'fora da rotação · sem GO';
  if (card.paused) return 'pausado';
  if (card.active) {
    if (summary.autoPause) return 'pausa automática';
    if (summary.paused) return 'pausado';
    if (summary.dryRun) return 'simulando';
    return 'ativo';
  }
  if (card.total === 0) return 'sem estado';
  return 'ocioso';
}

function normalizeRun(raw: unknown): CrawlRunView | null {
  const run = asObject(raw);
  if (!run) return null;
  const counters: Record<string, number> = {};
  const rawCounters = asObject(run.counters) || {};
  for (const [key, value] of Object.entries(rawCounters)) {
    if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
  }
  return {
    id: numOrNull(run.id),
    phase: phaseOf(run.phase),
    cursor: strOrNull(run.cursor),
    startedAt: num(run.startedAt),
    finishedAt: numOrNull(run.finishedAt),
    counters,
  };
}

function normalizeSite(
  raw: unknown,
  activeSite: string | null,
  summary: CrawlSummary,
): CrawlSiteCard | null {
  const site = asObject(raw);
  if (!site) return null;
  const id = String(site.id ?? '').trim();
  if (!id) return null;

  const byStatus = asObject(site.byStatus) || {};
  const total = num(site.total);
  const done = num(byStatus.done);
  const noTorrent = num(byStatus['no-torrent']);
  const noWork = num(byStatus['no-work']);
  const error = num(byStatus.error);
  const simulated = num(byStatus.simulated);
  const partial = num(byStatus.partial);
  const processed = done + noTorrent + noWork + error;
  // Barra = páginas RESOLVIDAS (total − restante), não done/total do backend: com o acervo varrido e 87% sem torrent ela parava em 13%.
  // `floor` para não mostrar 100% com erro/pendência na fila.
  const torrentPercent = processed > 0 ? Math.round((done / processed) * 100) : 0;
  const etaRaw = numOrNull(site.etaHours);
  const pendingRemaining = num(site.pendingRemaining, processed === 0 ? total : num(byStatus.pending) + error + num(byStatus.inflight) + partial);
  const progressPercent = total > 0 ? Math.floor(((total - pendingRemaining) / total) * 100) : 0;
  // Fase 8: `siteConfig` e `probe`/`skipReason` entram pelo módulo irmão, que
  // sabe herdar o global e falhar fechado no gate. O `override` vem antes do
  // `probe` porque a rotação depende do `enabled` efetivo.
  const override = siteOverride(site, summary);

  return {
    id,
    label: String(site.label ?? id),
    active: activeSite === id,
    phase: phaseOf(site.phase),
    total,
    done,
    pending: num(byStatus.pending),
    inflight: num(byStatus.inflight),
    noTorrent,
    noWork,
    error,
    simulated,
    partial,
    progressPercent: Math.max(0, Math.min(100, progressPercent)),
    torrentPercent,
    magnetsFound: num(site.magnetsFound),
    newReleases: num(site.newReleases),
    pendingRemaining,
    ratePerHour: num(site.ratePerHour),
    etaHours: etaRaw != null && etaRaw > 0 ? etaRaw : null,
    latestRun: normalizeRun(site.latestRun),
    recentWorks: asArray(site.recentWorks).map((w) => {
      const item = asObject(w) || {};
      return {
        url: String(item.url ?? ''),
        imdb: strOrNull(item.imdb),
        releases: num(item.releases),
        checkedAt: num(item.checkedAt),
      };
    }).filter((w) => w.url !== ''),
    noWorkList: asArray(site.noWork).map((w) => {
      const item = asObject(w) || {};
      return { url: String(item.url ?? ''), checkedAt: num(item.checkedAt) };
    }).filter((w) => w.url !== ''),
    errors: asArray(site.errors).map((e) => {
      const item = asObject(e) || {};
      return {
        url: String(item.url ?? ''),
        error: String(item.error ?? ''),
        tries: num(item.tries),
        checkedAt: num(item.checkedAt),
      };
    }).filter((e) => e.url !== ''),
    errorGroups: asArray(site.errorGroups).map((g) => {
      const item = asObject(g) || {};
      return { reason: String(item.reason ?? ''), count: num(item.count) };
    }).filter((g) => g.reason !== ''),
    partialWork: asArray(site.partialWork).map((p) => {
      const item = asObject(p) || {};
      return {
        url: String(item.url ?? ''),
        done: num(item.done),
        total: num(item.total),
        checkedAt: num(item.checkedAt),
      };
    }).filter((p) => p.url !== ''),
    override,
    probe: siteProbe(site, summary, override),
    paused: bool(site.paused),
  };
}

/** Um card por site configurado, na ordem do payload. O site ativo vem de
 * `active` (nome do motor multi-site) com `site` como compat. */
export function crawlSiteCards(crawl: Record<string, any> | null | undefined): CrawlSiteCard[] {
  const c = crawl || {};
  const summary = crawlSummary(c);
  const activeSite = strOrNull(c.active) ?? strOrNull(c.site);
  return asArray(c.sites)
    .map((site) => normalizeSite(site, activeSite, summary))
    .filter((card): card is CrawlSiteCard => card != null);
}

/** Rótulo curto de uma obra do histórico (IMDb quando há; senão a URL). */
export function workLabel(ref: CrawlWorkRef): string {
  return ref.imdb ? `${ref.imdb} · ${ref.releases} release(s)` : `${ref.url} · ${ref.releases} release(s)`;
}

/** Duração de uma rodada fechada; `null` enquanto ela está aberta. */
export function runDurationMs(run: CrawlRunView | null): number | null {
  if (!run || run.finishedAt == null || run.startedAt <= 0) return null;
  return Math.max(0, run.finishedAt - run.startedAt);
}

/** ETA em horas → rótulo legível; `null` (sem pendência) não inventa número. */
export function etaLabel(hours: number | null): string {
  if (hours == null || hours <= 0) return '—';
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 60) return `${totalMinutes}min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}
