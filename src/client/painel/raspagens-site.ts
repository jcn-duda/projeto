// Modelo PURO do AJUSTE POR SITE (Fase 8 multi-site). O `crawl-status` do
// backend expõe, por item de `crawl.sites[]`, a config EFETIVA do site em
// `siteConfig` (já fundida com `siteOverrides`) e o estado da sonda em
// `probe`/`skipReason`; aqui isso vira o formulário e o rótulo que o operador
// lê.
//
// Nenhum DOM, nenhuma rede: as funções são chamadas direto no teste. Regra do
// módulo inteiro — AUSÊNCIA NUNCA AFIRMA. Site sem `siteConfig` herda o global
// (e o selo "ao vivo" fica vazio); site sem `probe` é "sonda não rodada",
// nunca "GO"; taxa ausente é `null` e a tela omite, não mostra 0% como medição.

import type { CrawlSummary, CrawlBadge } from './raspagens-model.js';

/** Chaves que o operador pode divergir por site. `sites` NÃO entra: a lista de
 * sites vem do `.env` (`CRAWL_SITES`) e o card de config ao vivo do topo é
 * dirigido pelo schema do backend. */
export const SITE_CONFIG_KEYS = ['enabled', 'dryRun', 'delayMs', 'maxPerHour'] as const;

export type SiteConfigKey = (typeof SITE_CONFIG_KEYS)[number];

/** Config efetiva do site + quais campos divergem do global. */
export interface SiteOverrideView {
  enabled: boolean;
  dryRun: boolean;
  delayMs: number;
  maxPerHour: number;
  /** Chaves com override próprio (selo "ao vivo"). Vazio = herda o global. */
  overridden: string[];
}

export type ProbeVerdict = 'go' | 'no-go' | 'inconclusive' | 'pending';

/** Motivo de o site não entrar na rotação — nunca "não sei". */
export type SiteOutReason = 'desligado' | 'sem-go';

export interface SiteProbeView {
  verdict: ProbeVerdict | null;
  /** Epoch ms do veredito; `null` = sem veredito ou campo ausente. */
  at: number | null;
  /** Amostra avaliada pela sonda (`sample` do gate). */
  sample: number | null;
  /** Taxas 0..1 do veredito, quando o status as trouxer; `null` = não medidas. */
  rates: { valid: number | null; magnet: number | null; identify: number | null; magnetsPerPage: number | null };
  /** Códigos curtos que derrubaram a sonda (ex.: `abaixo-limiar:magnet`). */
  reasons: string[];
  /** `CRAWL_REQUIRE_PROBE` efetivo DESTE site: sem liberação, ele fica fora. */
  block: boolean;
  inRotation: boolean;
  out: SiteOutReason | null;
  /** `skipReason` do motor (`pausado`, `teto-horario`, `sem-trabalho`…):
   * o porquê de a vez não ter sido agora, mesmo com o site habilitado. */
  skip: string | null;
  /** `blockedBy` do gate: por que a sonda NÃO liberou o site. */
  blockedBy: string | null;
}

export interface SiteConfigForm {
  enabled: boolean;
  dryRun: boolean;
  delayMs: number;
  maxPerHour: number;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 0..1 → inteiro de 0..100, ou null. `null` nunca vira 0%: taxa ausente é
 * dado que ninguém mediu, e 0% afirmaria que a sonda mediu e reprovou. */
function ratePercent(value: unknown): number | null {
  const n = numOrNull(value);
  if (n == null) return null;
  return Math.round(Math.max(0, Math.min(1, n)) * 100);
}

/** Config global do topo do `crawl` — a base que o site herda. */
export function globalOverride(summary: CrawlSummary | null | undefined): SiteOverrideView {
  const s = summary || ({} as CrawlSummary);
  return {
    enabled: s.enabled === true,
    dryRun: s.dryRun === true,
    delayMs: typeof s.delayMs === 'number' && Number.isFinite(s.delayMs) ? s.delayMs : 0,
    maxPerHour: typeof s.maxPerHour === 'number' && Number.isFinite(s.maxPerHour) ? s.maxPerHour : 0,
    overridden: [],
  };
}

/**
 * Config efetiva do SITE. `site.siteConfig` traz os valores já resolvidos pelo
 * backend; o que faltar nele herda o global. A lista `overridden` soma o que o
 * backend declarou com o que DIFERE do global — um site cujo `dryRun` veio
 * verdadeiro contra um global falso está divergindo, mesmo que a lista venha
 * ausente.
 */
export function siteOverride(
  site: Record<string, any> | null | undefined,
  summary: CrawlSummary | null | undefined,
): SiteOverrideView {
  const base = globalOverride(summary);
  const raw = asObject(site?.siteConfig) || {};
  const effective: SiteOverrideView = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    dryRun: typeof raw.dryRun === 'boolean' ? raw.dryRun : base.dryRun,
    delayMs: typeof raw.delayMs === 'number' && Number.isFinite(raw.delayMs) ? raw.delayMs : base.delayMs,
    maxPerHour: typeof raw.maxPerHour === 'number' && Number.isFinite(raw.maxPerHour) ? raw.maxPerHour : base.maxPerHour,
    overridden: asArray(raw.overridden).map((key) => String(key || '')).filter(Boolean),
  };
  for (const key of SITE_CONFIG_KEYS) {
    const value = effective[key];
    const global = base[key];
    if (value !== global && !effective.overridden.includes(key)) effective.overridden.push(key);
  }
  return effective;
}

/** Veredito tolerante ao casing: o script da sonda grava `go|no-go|
 * inconclusive|pending` em minúsculas, mas um backend que preferir `GO`/
 * `CONDICIONAL`/`PENDENTE` continua legível. Qualquer outra coisa é ausente. */
export function probeVerdictOf(raw: unknown): ProbeVerdict | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'go' || text === 'ok' || text === 'aprovado') return 'go';
  if (text === 'no-go' || text === 'nogo' || text === 'no_go' || text === 'reprovado') return 'no-go';
  if (text === 'inconclusive' || text === 'condicional' || text === 'inconclusivo') return 'inconclusive';
  if (text === 'pending' || text === 'pendente' || text === 'running') return 'pending';
  return null;
}

/**
 * Veredito da sonda do site + a decisão de rotação. Contrato do motor
 * (`sites[].probe` = `ProbeGate`: `required`, `verdict`, `ok`, `at`, `sample`,
 * `blockedBy`). Duas fontes de autoridade, nesta ordem: `ok`/`blockedBy` do
 * próprio gate (que já validou versão, amostra e site do veredito) e, na
 * ausência deles, o cálculo local `required ∧ verdict === 'go'`. Fail-closed:
 * sem liberação o site fica fora e o motivo aparece no card. */
export function siteProbe(
  site: Record<string, any> | null | undefined,
  summary: CrawlSummary | null | undefined,
  override?: SiteOverrideView,
): SiteProbeView {
  const raw = asObject(site?.probe) || {};
  const rates = asObject(raw.rates) || {};
  const counts = asObject(raw.counts) || {};
  const block = typeof raw.required === 'boolean' ? raw.required : (summary || ({} as CrawlSummary)).probeBlock === true;
  const enabled = override ? override.enabled : siteOverride(site, summary).enabled;
  // `ok` NÃO vira veredito: o motor responde `ok:true` para qualquer site com
  // o gate desligado, mesmo sem sonda rodada — ler "GO" daí seria afirmar uma
  // medição que ninguém fez. O veredito vem só de `verdict`.
  const verdict = probeVerdictOf(raw.verdict);
  const released = typeof raw.ok === 'boolean' ? raw.ok : !block || verdict === 'go';
  const skip = strOrNull(site?.skipReason);
  // A exclusão é do motor (`skipReason`); o cálculo abaixo é o piso para um
  // backend que não o mande — os dois caminhos chegam ao mesmo rótulo.
  const out: SiteOutReason | null = skip === 'desabilitado' ? 'desligado'
    : skip === 'probe' ? 'sem-go'
      : !enabled ? 'desligado'
        : released ? null : 'sem-go';
  return {
    verdict,
    at: numOrNull(raw.at),
    sample: numOrNull(raw.sample) ?? numOrNull(counts.sample),
    rates: {
      valid: ratePercent(rates.valid),
      magnet: ratePercent(rates.magnet),
      identify: ratePercent(rates.identify),
      magnetsPerPage: numOrNull(rates.magnetsPerPage),
    },
    reasons: asArray(raw.reasons).map((r) => String(r || '')).filter(Boolean),
    block,
    inRotation: out == null,
    out,
    skip,
    blockedBy: strOrNull(raw.blockedBy),
  };
}

/** Pill do veredito. Ausente nunca é `ok`: "não rodada" é neutral, porque
 * ninguém mediu. */
export function probeBadge(probe: SiteProbeView): CrawlBadge {
  switch (probe.verdict) {
    case 'go':
      return { text: 'SONDA GO', variant: 'ok' };
    case 'no-go':
      return { text: 'SONDA SEM GO', variant: 'err' };
    case 'inconclusive':
      return { text: 'SONDA CONDICIONAL', variant: 'warn' };
    case 'pending':
      return { text: 'SONDA PENDENTE', variant: 'warn' };
    default:
      return { text: 'SONDA NÃO RODADA', variant: 'neutral' };
  }
}

/** `blockedBy` do gate → texto. Código novo cai no próprio id: rótulo
 * desconhecido é melhor que rótulo inventado. */
const BLOCK_LABELS: Record<string, string> = {
  'sem-veredito': 'sonda nunca rodou',
  'veredito-de-outro-site': 'veredito de outro site',
  versao: 'veredito de outra versão',
  'amostra-incompleta': 'amostra incompleta',
  parcial: 'rodada parcial',
  'sem-go': 'veredito sem GO',
};

export function blockedText(blockedBy: string | null): string {
  if (!blockedBy) return '';
  return BLOCK_LABELS[blockedBy] || blockedBy;
}

/** Linha de detalhe do veredito: idade, amostra e as taxas que existirem. */
export function probeText(probe: SiteProbeView, now = Date.now()): string {
  if (probe.verdict == null) {
    // Sem veredito mas com motivo do gate: o porquê vem do motor, não do
    // palpite do painel. Sem os dois, a linha diz o que fazer (rodar a CLI).
    if (probe.blockedBy) return 'Sem liberação: ' + blockedText(probe.blockedBy) + '.';
    return probe.block ? 'Sem veredito — o site fica fora da rotação (CRAWL_REQUIRE_PROBE).' : 'Sem veredito — a sonda é rodada por script.';
  }
  const parts: string[] = [];
  if (probe.at != null) parts.push('medido ' + ageText(probe.at, now));
  if (probe.sample != null) parts.push('amostra ' + probe.sample);
  const taxa: string[] = [];
  if (probe.rates.valid != null) taxa.push('válidas ' + probe.rates.valid + '%');
  if (probe.rates.magnet != null) taxa.push('com torrent ' + probe.rates.magnet + '%');
  if (probe.rates.identify != null) taxa.push('identificadas ' + probe.rates.identify + '%');
  if (taxa.length > 0) parts.push(taxa.join(' '));
  // `magnetsPerPage` é a média (não uma porcentagem) e é o que separa "responde
  // bem" de "vale o custo": um site com 60% de páginas com torrent e 0,2
  // magnet/página não paga o teto por hora. Vinha lido do veredito sem lugar na
  // tela — suporte morto, agora exibido.
  if (probe.rates.magnetsPerPage != null) parts.push(probe.rates.magnetsPerPage + ' magnet(s)/página');
  // Os motivos entram sempre que existirem. Num veredito `go` eles são os
  // INFORMATIVOS (`no-work-dominante`, `tmdb-parcial`, `site-fora`) — as
  // ressalvas que a própria sonda grava justamente para o GO não ser lido como
  // "sem ressalva". Escondê-los no GO (o caso antigo) deixava de fora a única
  // informação que o operador precisava sobre um site liberado.
  if (probe.reasons.length > 0) parts.push(probe.reasons.join(', '));
  // `blockedBy` entra sempre que existir, inclusive com veredito `go`: um GO
  // gravado que NÃO liberou (amostra incompleta, veredito de outro site) é
  // justamente o caso em que o operador precisa do motivo.
  if (probe.blockedBy) parts.push(blockedText(probe.blockedBy));
  return parts.length > 0 ? parts.join(' · ') : 'veredito registrado';
}

/** Idade legível (min/h/d) sem depender do `fmt.ts` do painel: o modelo puro
 * é testado fora de render e `formatAgeFromTimestamp` cai no passado. */
export function ageText(at: number, now = Date.now()): string {
  const ms = now - at;
  if (!Number.isFinite(ms) || ms < 0) return 'agora';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return 'há ' + minutes + 'min';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'há ' + hours + 'h';
  return 'há ' + Math.floor(hours / 24) + 'd';
}

/** Rótulo da rotação: o porquê de um site não estar na vez. O `enabled` efetivo
 * é lido do próprio override (e não do `probe.out`, que já foi calculado com
 * ele): a resposta não pode depender da ordem em que o chamador montou as
 * duas visões. */
export function siteRotationLabel(
  override: SiteOverrideView,
  probe: SiteProbeView,
  active: boolean,
  hasState: boolean,
): string {
  if (!override.enabled || probe.out === 'desligado') return 'fora da rotação · desligado';
  if (probe.out === 'sem-go') return 'fora da rotação · sem GO';
  if (!active) return hasState ? 'ocioso' : 'sem estado';
  return 'na rotação';
}

/** `skipReason` do motor → texto. Código novo cai no próprio id: rótulo
 * desconhecido é melhor que rótulo inventado. */
const SKIP_LABELS: Record<string, string> = {
  desabilitado: 'desligado',
  pausado: 'pausado',
  'auto-pausa': 'pausa automática',
  'teto-horario': 'teto horário',
  probe: 'sem GO da sonda',
  'sem-adaptador': 'sem adaptador',
  'sem-trabalho': 'sem trabalho pendente',
};

export function skipText(skip: string | null): string {
  if (!skip) return '';
  return SKIP_LABELS[skip] || skip;
}

/**
 * Clamps do cliente — MESMOS limites do schema do backend
 * (`crawler-live-schema.sanitizePatch`), aplicados por site. O servidor continua
 * sendo a autoridade: isto evita POST com número que ele rejeitaria.
 */
export function clampSiteNumber(key: 'delayMs' | 'maxPerHour', value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (key === 'delayMs') return Math.max(0, Math.min(60_000, Math.trunc(value)));
  return Math.max(1, Math.min(20_000, Math.trunc(value)));
}

export function siteFormOf(override: SiteOverrideView): SiteConfigForm {
  return {
    enabled: override.enabled,
    dryRun: override.dryRun,
    delayMs: override.delayMs,
    maxPerHour: override.maxPerHour,
  };
}

/** Delta contra a config efetiva: o POST leva SÓ o que mudou (aplicar sem
 * mudança não existe — o mesmo contrato do `LiveConfigCard` do topo). As
 * quatro chaves são comparadas uma a uma porque o tipo do valor acompanha a
 * chave — um laço com `patch[key] = form[key]` perderia essa correlação. */
export function siteConfigDiff(
  form: SiteConfigForm,
  override: SiteOverrideView,
): { patch: Partial<SiteConfigForm>; changedKeys: SiteConfigKey[] } {
  const patch: Partial<SiteConfigForm> = {};
  const changedKeys: SiteConfigKey[] = [];
  if (form.enabled !== override.enabled) {
    patch.enabled = form.enabled;
    changedKeys.push('enabled');
  }
  if (form.dryRun !== override.dryRun) {
    patch.dryRun = form.dryRun;
    changedKeys.push('dryRun');
  }
  if (form.delayMs !== override.delayMs) {
    patch.delayMs = form.delayMs;
    changedKeys.push('delayMs');
  }
  if (form.maxPerHour !== override.maxPerHour) {
    patch.maxPerHour = form.maxPerHour;
    changedKeys.push('maxPerHour');
  }
  return { patch, changedKeys };
}

/** Dica do formulário: quais campos estão no override e o que o global manda. */
export function siteConfigHint(override: SiteOverrideView, base: SiteOverrideView): string {
  const own = override.overridden.filter((key) => (SITE_CONFIG_KEYS as readonly string[]).includes(key));
  const head = own.length > 0 ? 'No override: ' + own.join(', ') + '. ' : 'Tudo herdado do global. ';
  return head + 'Global: pausa ' + base.delayMs + 'ms, teto ' + base.maxPerHour + '/h, ' + (base.dryRun ? 'simulação' : 'gravando') + '.';
}

/** Identidade do valor efetivo: a chave que reseeda o formulário quando o poll
 * traz o override novo (evita o formulário "grudar" num valor velho). */
export function overrideKey(override: SiteOverrideView): string {
  return SITE_CONFIG_KEYS.map((key) => String(override[key])).join('|') + '#' + override.overridden.join(',');
}
