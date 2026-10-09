// Escolha do PRÓXIMO SITE da rotação serial (Fase 8 multi-site) — a política é
// PURA sobre a foto do motor: o que decide, em que ordem, e POR QUE um site
// ficou de fora (o motivo é o que o painel mostra; sem ele, "não rasga nada" é
// indistinguível de "travado pelo teto").
//
// Duas CLASSES de trabalho, nesta ordem (decisão do rollout): um ITEM devido
// (página vencida ou fechamento de rodada) sempre tem precedência sobre uma
// DESCOBERTA vencida. Sem essa precedência, um site com a fila inteira
//(processando de página em página) empurraria a descoberta dos outros para
// depois do próximo ciclo incremental — a lista deles nasceria vazia.
//
// Regras de EXCLUSÃO (a ordem é a ordem das regras):
//  1. desabilitado pelo site (`siteOverrides[id].enabled`);
//  2. pausa manual do site (a global é do motor, fora daqui);
//  3. pausa automática do site (streak de erro / canário de layout);
//  4. teto horário PRÓPRIO do site e teto GLOBAL agregado (educação);
//  5. gate da sonda (Fase 8): sem veredito GO, o site não entra;
//  6. adaptador que acabou de falhar (janela `ADAPTER_RETRY_MS`);
//  7. nada devido agora.
//
// Entre os elegíveis da MESMA classe vence o mais ANTIGO por `lastActiveAt`
// (justiça: um site com fila infinita não pode comer a CPU dos outros), com a
// ordem de configuração como desempate determinístico. O ritmo (`delayMs` por
// site) NÃO entra aqui: ele depende do `lastRequestAt` GLOBAL, que só o motor
// conhece.
import { isOwnPace } from './crawl-sites/registry.js';
import type { SiteCounters } from '../utils/crawl-store.js';
import type { CrawlerSiteConfig } from '../utils/crawler-live-schema.js';
import { ADAPTER_RETRY_MS, type CrawlSkipReason, type SiteRuntime } from './crawl-site-runtime.js';

/** Classe de trabalho devido (a ordem É a prioridade). */
export type DueClass = 'item' | 'discovery' | null;

/** Resumo do site para a decisão (o motor monta a partir do runtime). */
export interface SiteCandidate {
  id: string;
  config: CrawlerSiteConfig;
  runtime: SiteRuntime;
  due: DueClass;
  skipReason: CrawlSkipReason | null;
}

/** Consultas que a seleção faz (injetadas: o módulo não abre banco). */
export interface SelectDeps {
  counters(siteId: string): SiteCounters;
  /** Gate da sonda: `true` = o site pode raspar. */
  probeOpen(siteId: string): boolean;
  /** Teto GLOBAL agregado já atingido (soma dos sites da hora civil). */
  globalCapHit(): boolean;
  /**
   * Existe página VENCIDA (`next_at <= now`)? Opcional de propósito: quando a
   * engine expõe a consulta, é a verdade; sem ela, o motor cai na aproximação
   * por status (uma linha em backoff conta como fila e o `takeNext` devolve
   * `null` — o passo vira no-op, sem gastar requisição).
   */
  hasDue?(siteId: string, now: number): boolean;
}

/** Página vencida, pelo caminho exato quando existe e pela aproximação sem ele. */
export function hasDuePage(deps: SelectDeps, siteId: string, counters: SiteCounters, now: number): boolean {
  if (deps.hasDue) return deps.hasDue(siteId, now);
  const by = counters.byStatus;
  return (by.pending || 0) + (by.error || 0) + (by.inflight || 0) + (by.partial || 0) > 0;
}

/**
 * Trabalho devido de UM site, com a precedência do `step`:
 *  - rodada ABERTA ⇒ o que o passo faz é servir a fila (ou fechar a rodada, se
 *    ela já esvaziou): é trabalho de item, sempre;
 *  - sem rodada ⇒ item vencido da fila (retry de `error`/`partial`), senão a
 *    descoberta vencida (fila vazia ou ciclo vencido).
 */
export function dueClass(rt: SiteRuntime, deps: SelectDeps, counters: SiteCounters, now: number): DueClass {
  if (rt.openRunId != null) return 'item';
  // Recuperação one-shot pendente (religou o motor, dry-run desligou): é
  // TRABALHO sem rede, e sem esta classe o site ficaria "sem-trabalho" e a
  // `simulated` presa — foi o que o teste do switch ao vivo travava.
  if (rt.needSimulatedRecovery || rt.needInflightRecovery) return 'item';
  if (hasDuePage(deps, rt.id, counters, now)) return 'item';
  if (counters.total === 0 || now >= rt.nextDiscoverAt) return 'discovery';
  return null;
}

/** Aplica as regras 1–7 numa lista de candidatos. */
export function assessSites(
  ids: string[],
  runtimeOf: (id: string) => SiteRuntime,
  configOf: (id: string) => CrawlerSiteConfig,
  deps: SelectDeps,
  now: number,
): SiteCandidate[] {
  const globalHit = deps.globalCapHit();
  const out: SiteCandidate[] = [];
  for (const id of ids) {
    const rt = runtimeOf(id);
    const config = configOf(id);
    let skipReason: CrawlSkipReason | null = null;
    if (!config.enabled) skipReason = 'desabilitado';
    else if (rt.paused) skipReason = 'pausado';
    else if (rt.autoPause) skipReason = 'auto-pausa';
    // Ritmo próprio (Mico): o limitador do adaptador é o teto; o horário não vale.
    else if (!isOwnPace(id) && (globalHit || rt.hourPages.current() >= config.maxPerHour)) skipReason = 'teto-horario';
    else if (!deps.probeOpen(id)) skipReason = 'probe';
    // Adaptador que acabou de falhar espera a janela antes de nova tentativa.
    else if (rt.adapterFailedAt > 0 && now - rt.adapterFailedAt < ADAPTER_RETRY_MS) skipReason = 'sem-adaptador';
    // A classe só é avaliada quando NADA barrou: um site desligado com fila
    // cheia continua sendo "desabilitado", não "sem-trabalho".
    const due: DueClass = skipReason === null ? dueClass(rt, deps, deps.counters(id), now) : null;
    if (skipReason === null && due === null) skipReason = 'sem-trabalho';
    out.push({ id, config, runtime: rt, due, skipReason });
  }
  return out;
}

/** Ordena por justiça (mais antigo primeiro) com a ordem de config no empate. */
export function byFairness(candidates: SiteCandidate[]): SiteCandidate[] {
  return candidates
    .map((candidate, order) => ({ candidate, order }))
    .sort((a, b) => a.candidate.runtime.lastActiveAt - b.candidate.runtime.lastActiveAt || a.order - b.order)
    .map((entry) => entry.candidate);
}

/** Espera máxima de uma descoberta atrás de itens: o intervalo incremental do site. */
function starveMs(config: CrawlerSiteConfig): number {
  const min = Number(config.incrementalIntervalMin);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60_000;
}

/**
 * Site que deve servir a próxima requisição, ou `null` se nenhum deve.
 * Prioriza a classe `item` e só então a `discovery` — cada classe por justiça.
 */
export function selectNext(
  ids: string[],
  runtimeOf: (id: string) => SiteRuntime,
  configOf: (id: string) => CrawlerSiteConfig,
  deps: SelectDeps,
  now: number,
): { chosen: SiteCandidate | null; all: SiteCandidate[] } {
  const all = assessSites(ids, runtimeOf, configOf, deps, now);
  // Limite de FOME da descoberta: com a precedência pura de item, site que só
  // tinha descoberta nunca pegava a vez enquanto outro tivesse fila — na VPS
  // (2026-09-30) Apache, HDR, Vaca e NerdFilmes estavam com lastActiveAt 0,
  // atrás das ~34 mil páginas do Comando e do TorrentDosFilmes. Quem está sem
  // vez há mais que o próprio intervalo incremental (ou nunca rodou) fura a
  // fila; dentro do intervalo, a precedência de item continua valendo.
  const starved = byFairness(all).find((candidate) => candidate.due === 'discovery'
    && (candidate.runtime.lastActiveAt === 0
      || now - candidate.runtime.lastActiveAt >= starveMs(candidate.config)));
  if (starved) return { chosen: starved, all };
  for (const wanted of ['item', 'discovery'] as const) {
    const hit = byFairness(all).find((candidate) => candidate.due === wanted);
    if (hit) return { chosen: hit, all };
  }
  return { chosen: null, all };
}

/** Grava o motivo no runtime de cada site (o status lê dali). */
export function applySkipReasons(candidates: SiteCandidate[]): void {
  for (const candidate of candidates) candidate.runtime.skipReason = candidate.skipReason;
}

/**
 * Motivo de exclusão para o PAINEL, inclusive SEM tick. `assessSites` mede no
 * tick e conhece pausa/teto/probe por site; com o motor desligado nenhum tick
 * roda e `rt.skipReason` fica vazio — aí a exclusão real continua sendo a
 * config do operador, e o card precisa dela. Motivo já medido tem PRECEDÊNCIA:
 * `pausado`, `teto-horario` e `probe` explicam mais que "desligado", e um
 * site ligado que só não teve vez (`null`) não vira "desligado" por acidente.
 */
export function skipReasonFor(
  rt: SiteRuntime,
  config: CrawlerSiteConfig,
  globalEnabled: boolean,
): CrawlSkipReason | null {
  if (rt.skipReason) return rt.skipReason;
  return globalEnabled && config.enabled ? null : 'desabilitado';
}
