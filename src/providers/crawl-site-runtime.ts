// Estado de execução POR SITE do motor da raspagem (Fase 8 multi-site).
//
// Antes da Fase 8 o motor tinha UM estado só (rodada aberta, cursor, ciclos,
// streak, teto horário) porque havia UM site. Com vários sites na mesma
// rotação serial, esse estado precisa ser POR SITE — senão a roda de um site
// recebe o cursor do outro, o teto de um conta a página do vizinho e a pausa
// por canário de um congela a fila alheia.
//
// O que é GLOBAL e continua fora daqui: o `busy` (no máximo uma requisição em
// voo no processo inteiro), o `lastRequestAt` do ritmo mínimo e o freio de
// tráfego — todos vivem no `crawler.ts`. O que é POR SITE mora aqui: pausa
// manual, pausa automática, cursor, rodada aberta, ciclo, custo, teto horário,
// memórias de recuperação e o `lastActiveAt` que dá a JUSTIÇA da rotação.
import { CrawlPausePolicy, type AutoPauseReason } from './crawl-pauses.js';
import { freshCycle, type CycleCounters } from './crawl-cycle.js';
import { createCostMeter, createHourCounter, type CostMeter, type HourCounter } from './crawl-rate.js';
import type { CursorMap } from './crawl-cursor.js';

/** Pausa automática de um site (o motivo viaja para o painel). */
export interface SiteAutoPause {
  reason: AutoPauseReason;
  at: number;
  detail: string;
}

/** Por que um site ficou FORA da rotação no último tick (diagnóstico do painel). */
export type CrawlSkipReason =
  | 'desabilitado'
  | 'pausado'
  | 'auto-pausa'
  | 'teto-horario'
  | 'probe'
  | 'sem-adaptador'
  | 'sem-trabalho'
  /**
   * O site DEVE trabalho, mas outro site foi servido neste tick (justiça por
   * `lastActiveAt` e precedência de item sobre descoberta). Sem este motivo o
   * card de um site que está esperando a vez pareceria o mesmo de um site sem
   * nada a fazer — e a diferença é justamente a que o operador precisa ver.
   */
  | 'aguarda-rodizio'
  | 'ritmo'
  | 'trafego';

export interface SiteRuntime {
  id: string;
  /** Rótulo do adaptador (o card do painel usa). `''` antes de resolver. */
  label: string;
  /** `false` enquanto o adaptador do site não resolveu. */
  ready: boolean;
  /** Pausa MANUAL do site: não persiste (restart volta ao `.env`). */
  paused: boolean;
  /** Pausa automática (streak de erro / canário de layout): só `resumeSite`. */
  autoPause: SiteAutoPause | null;
  /** Cursor incremental POR KIND (F2 das séries), por site. */
  cursors: CursorMap;
  /** `cursors` já veio do `crawl_state` neste processo (carga única). */
  cursorsLoaded: boolean;
  /** Rodada de descoberta+páginas aberta; `null` = nenhuma. */
  openRunId: number | null;
  /** Próxima descoberta agendada (epoch ms); 0 = devida. */
  nextDiscoverAt: number;
  /** A descoberta da rodada aberta veio parcial (fecha em retry curto). */
  discoveryPartial: boolean;
  /** Última vez que o site serviu uma requisição — base da JUSTIÇA. */
  lastActiveAt: number;
  /**
   * URL que a página em processamento reivindicou (null em descoberta/ocioso).
   * O vigia do passo (`boundedStep`) usa isto para marcar a linha PRESA como
   * `error step-timeout` sem depender de estado interno do adaptador.
   */
  activeUrl: string | null;
  /**
   * Geração do passo em voo. `beginStepFence` captura o valor e
   * `invalidateStep` incrementa: escritas TARDIAS de um passo expirado (que já
   * não pertence à geração corrente) são descartadas antes de tocar fila,
   * índice, banco vivo ou progresso.
   */
  generation: number;
  /** Política de pausa automática (streak/canário) DO SITE. */
  policy: CrawlPausePolicy;
  /** Teto horário do site (custo real em requisições, hora civil). */
  hourPages: HourCounter;
  /** Custo médio observado do site (ETA honesto em requisições). */
  cost: CostMeter;
  /** Contadores da rodada corrente. */
  cycle: CycleCounters;
  /** 1ª passagem deste site após religar: reenfileira inflight órfã. */
  needInflightRecovery: boolean;
  /** Dry-run do SITE desligou: reenfileira as `simulated` (one-shot). */
  needSimulatedRecovery: boolean;
  /** A passada de `simulated` já rodou neste processo. */
  simulatedRecoveryDone: boolean;
  /** `enabled`/`dryRun` do site na última foto (detecta a virada). */
  wasEnabled: boolean;
  wasDryRun: boolean | null;
  /**
   * Epoch ms da ÚLTIMA tentativa de resolver o adaptador que falhou (0 =
   * nunca falhou / já resolveu). O site fica barrado como `sem-adaptador`
   * por `ADAPTER_RETRY_MS` e depois ganha UMA nova tentativa — assim uma falha
   * transitória (módulo ainda não deployado, import quebrado) não vira exclusão
   * permanente, e o aviso do registro não repete a cada tick.
   */
  adapterFailedAt: number;
  /** Motivo da última exclusão da rotação (`null` = entrou). */
  skipReason: CrawlSkipReason | null;
  /**
   * Janela de OCIOSIDADE medida: quantos ticks o site estava DEVENDO trabalho
   * (`attempts`) e quantos o freio de tráfego segurou (`trafficBlocks`).
   * Sem isso o ETA do painel divide a pendência por um teto horário que só é
   * verdade com o app 100% ocioso — e foi exatamente o que prometeu "12 h" numa
   * VPS que passou a noite esperando a janela de 10 min.
   */
  attempts: number;
  trafficBlocks: number;
}

/** Janela de bloqueio de um site cujo adaptador não resolveu. */
export const ADAPTER_RETRY_MS = 10 * 60_000;

export function createSiteRuntime(id: string): SiteRuntime {
  return {
    id,
    label: '',
    ready: false,
    paused: false,
    autoPause: null,
    cursors: { movie: '', tv_show: '' },
    cursorsLoaded: false,
    openRunId: null,
    nextDiscoverAt: 0,
    discoveryPartial: false,
    lastActiveAt: 0,
    activeUrl: null,
    generation: 0,
    policy: new CrawlPausePolicy(),
    hourPages: createHourCounter(),
    cost: createCostMeter(),
    cycle: freshCycle(),
    needInflightRecovery: false,
    needSimulatedRecovery: false,
    simulatedRecoveryDone: false,
    wasEnabled: false,
    wasDryRun: null,
    adapterFailedAt: 0,
    skipReason: null,
    attempts: 0,
    trafficBlocks: 0,
  };
}

/**
 * Fração de ociosidade OBSERVADA do site, ou `null` sem amostra. Duas janelas
 * mínimas de tentativas: com uma só, "0 bloqueios" seria otimismo, não
 * medição — e o ETA do painel precisa poder dizer "indisponível".
 */
export function idleFractionOf(rt: SiteRuntime): number | null {
  if (rt.attempts < 2) return null;
  const free = Math.max(0, rt.attempts - rt.trafficBlocks) / rt.attempts;
  // Piso de 5%: fração zero transformaria a demanda em ETA infinito, que
  // também é mentira — o relatório honesto nesse caso é o piso + a fração.
  return Math.max(0.05, Math.min(1, Math.round(free * 1000) / 1000));
}

/** Mapa de runtimes por id de site. */
export type SiteRuntimeMap = Map<string, SiteRuntime>;

/**
 * Marca ESTÁVEL do desfecho de um passo que excedeu o prazo (vai para o
 * `error` da linha e para o `errorGroups` do painel). Constante de propósito:
 * agrupar por string exata fragmentaria o grupo a cada medição.
 */
export const STEP_TIMEOUT_REASON = 'step-timeout: passo excedeu o prazo do site';

/**
 * Cerca de POSSE de UM passo: captura a `generation` e responde se o passo
 * ainda pertence à geração corrente. Escritas de um passo expirado (após
 * `invalidateStep`) têm de consultar `aborted()` ANTES de tocar fila/índice/
 * banco/progresso — é o que impede o passo preso de sobrescrever o estado que
 * a recuperação já devolveu.
 */
export interface StepFence {
  readonly gen: number;
  aborted(): boolean;
  /**
   * Re-arma o prazo do passo com o orçamento da FASE escolhida. A decisão
   * descoberta×linha só existe DEPOIS das recuperações (que mexem em
   * `nextDiscoverAt`), então o orçamento é trocado no ponto exato da escolha,
   * antes de qualquer await longo — nunca por predição de valores velhos.
   * Opcional: `beginStepFence` sozinho não conhece o timer (só o vigia monta).
   */
  setBudget?(ms: number): void;
}

/** Abre a cerca do passo corrente (captura a geração agora). */
export function beginStepFence(rt: SiteRuntime): StepFence {
  const gen = rt.generation;
  return { gen, aborted: () => rt.generation !== gen };
}

/** Invalida a geração corrente: toda cerca aberta vira `aborted()`. */
export function invalidateStep(rt: SiteRuntime): number {
  rt.generation += 1;
  return rt.generation;
}

/** Runtime do site, criado na primeira vez. */
export function ensureRuntime(runtimes: SiteRuntimeMap, id: string): SiteRuntime {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const created = createSiteRuntime(id);
  runtimes.set(id, created);
  return created;
}

/**
 * Descarta a rodada aberta do site (o "Zerar site" do painel): fecha o ciclo,
 * zera cursor/rodada/agendamento e limpa as memórias de recuperação. NÃO toca
 * o `crawl.db` — quem apaga as linhas é `clearSite` da engine.
 */
export function forgetRun(rt: SiteRuntime): void {
  // Invalida a cerca: um passo em voo no momento do "Zerar site" não pode
  // re-semear a fila recém-apagada (upsert tardio) nem marcar resultado órfão.
  invalidateStep(rt);
  rt.activeUrl = null;
  rt.openRunId = null;
  rt.cycle = freshCycle();
  rt.cursors.movie = '';
  rt.cursors.tv_show = '';
  rt.nextDiscoverAt = 0;
  rt.discoveryPartial = false;
  rt.needInflightRecovery = false;
  rt.needSimulatedRecovery = false;
  rt.simulatedRecoveryDone = false;
  rt.hourPages.clear();
}

/** Pausa o site: zera a automática junto (consentimento do operador, como o global). */
export function pauseSite(rt: SiteRuntime, value: boolean): void {
  rt.paused = Boolean(value);
  if (!rt.paused) rt.autoPause = null;
}

/** Registra a pausa automática do site (streak/canário). */
export function autoPauseSite(rt: SiteRuntime, reason: AutoPauseReason, detail: string): void {
  rt.autoPause = { reason, at: Date.now(), detail: String(detail || '').slice(0, 200) };
}
