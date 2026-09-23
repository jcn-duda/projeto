/**
 * Motor GENÉRICO da fila de julgamento TypeSafe — parametrizado por pergunta.
 * Uma instância por pergunta shadow; a fila original (pergunta 1,
 * `is_ptbr_dub`) vira wrapper fino em audio-judgment-queue.ts e as perguntas
 * novas entram criando outro core com o spec delas — sem duplicar fila,
 * orçamento, breaker ou comparação shadow.
 *
 * Contratos do slice (cobertos por test/typesafe-queue.test.ts e o wrapper):
 * - `enqueue` é SÍNCRONO, nunca lança e NUNCA é awaited pela resposta: o drain
 *   roda em `setImmediate`, fora do orçamento de busca. O drain lê SÓ
 *   `config.typesafe` (knob de operador) — nunca `opts()`;
 * - kill-switch ANTES de tudo (nem leitura de cache): inércia por construção;
 * - teto DURO de fila (`queueMax`): excedente descarta — o item re-enfileira
 *   na próxima busca e o cache `tsj` evita re-chamada;
 * - orçamento/breaker INJETADOS por `spec.budget` (judgment-budget.ts): em
 *   produção as duas perguntas dividem a MESMA instância
 *   (`judgment-shared-budget.ts`) — um rate/auth de uma arma o cooldown da
 *   outra; as métricas de fila/chamada/shadow seguem prefixadas por
 *   `basePrefix` (pergunta 1 reproduz `typesafe.*` exato);
 * - 1 tentativa por item: falha NÃO re-enfileira em voo (quem volta a pedir é
 *   a próxima busca com o mesmo material);
 * - comparação shadow (`noul >= threshold` vs veredito determinístico
 *   capturado no enqueue) produz SÓ MÉTRICA sob `shadowPrefix` — nenhum
 *   objeto/resultado é alterado;
 * - `pause()` é EFÊMERO (memória): enqueue aceita nada e o drain não
 *   despacha; a fila permanece intacta para o `drainNow()` reagenda.
 */
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import { fingerprintMaterial, lookup, store } from './audio-judgment-cache.js';
import { askJevAudio, AskError } from './typesafe-client.js';
import type { JudgmentBudget, JudgmentBudgetSnapshot } from './judgment-budget.js';
import type { AskErrorKind, EnqueueResult, ShadowDimension } from './types.js';

/**
 * Contrato de UMA pergunta shadow: o texto vai em `questions` (wire do System
 * One), o estado é construído por `buildState` (allowlist da pergunta) e o
 * material de fingerprint é canônico — JÁ normalizado onde couber.
 */
export interface JudgmentQuestion<S> {
  /** Id no envelope de resposta (`answers.<id>.noul`). */
  questionId: string;
  /** Versão da pergunta — faz parte do fingerprint do cache. */
  promptVersion: string;
  /** Definição das perguntas enviada no corpo (espelho do probe validado). */
  questions: unknown;
  /** Estado na allowlist da pergunta — campo a campo, nunca spread. */
  buildState: (state: S) => Record<string, unknown>;
  /** Material canônico do fingerprint (pergunta 1: título normalizado). */
  fingerprintMaterial: (state: S) => string;
}

export interface JudgmentCoreSpec<S> {
  question: JudgmentQuestion<S>;
  /**
   * Orçamento/breaker da instância. Em produção as duas perguntas dividem a
   * MESMA instância (`judgment-shared-budget.ts`): mesma chave e mesmo limite
   * do provedor, então um rate/auth em qualquer pergunta arma o cooldown das
   * duas. Injetar permite ao teste isolar sem tocar o singleton.
   */
  budget: JudgmentBudget;
  /** Prefixo das métricas de fila/chamada/shadow: 'typesafe' | 'typesafe.dublie'. */
  basePrefix: string;
  /** Prefixo da comparação shadow: 'typesafe.shadow' | 'typesafe.shadow.dublie'. */
  shadowPrefix: string;
  /** Labels FECHOS dos lados da divergência (nunca texto do item). */
  detLabels: { ai: string; rule: string };
}

interface PendingEntry<S> {
  state: S;
  /** Veredito determinístico (`looksPtBr`/`_br` etc.) capturado no enqueue. */
  det: boolean;
  /** Origem declarada da release (união FECHADA) — dimensão da divergência. */
  dim: ShadowDimension;
}

export interface JudgmentCoreStatus extends JudgmentBudgetSnapshot {
  enabled: boolean;
  model: string;
  promptVersion: string;
  questionId: string;
  queueDepth: number;
  inFlight: number;
  paused: boolean;
}

export interface JudgmentCore<S> {
  enqueue(order: { state: S; det: boolean; dim: ShadowDimension }): EnqueueResult;
  statusSnapshot(): JudgmentCoreStatus;
  resetForTests(): void;
  flushForTests(): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  drainNow(): void;
  resetCooldown(): void;
}

export function createJudgmentCore<S>(spec: JudgmentCoreSpec<S>): JudgmentCore<S> {
  const { question, basePrefix, shadowPrefix, detLabels } = spec;
  const budget = spec.budget;

  // Estado ÚNICO da instância. FIFO por inserção do Map.
  const pending = new Map<string, PendingEntry<S>>();
  const inFlight = new Set<string>();
  let paused = false;
  let drainScheduled = false;

  /**
   * Enfileira um material para julgamento shadow. Devolve o resultado
   * SEMÂNTICO (virou métrica fixa em `${basePrefix}.enqueue.*`); `'ok'`
   * significa apenas "aceito na fila" — o processamento é todo em fundo.
   * `dim` é a dimensão de ORIGEM (união fechada) da release, capturada no
   * enqueue junto do veredito determinístico: a divergência vira métrica por
   * lado E por origem, sem reler item nenhum no drain.
   */
  function enqueue(order: { state: S; det: boolean; dim: ShadowDimension }): EnqueueResult {
    const cfg = config.typesafe;
    metrics.gauge(`${basePrefix}.enabled`, cfg.enabled && cfg.apiKey ? 1 : 0);
    // Curto-circuito ANTES do fingerprint: sem enabled+chave não há nem leitura
    // de cache — a garantia de inércia é por construção, não por configuração.
    if (!cfg.enabled || !cfg.apiKey) {
      metrics.count(`${basePrefix}.enqueue.disabled`);
      return 'disabled';
    }
    if (paused) {
      metrics.count(`${basePrefix}.enqueue.paused`);
      return 'paused';
    }
    const fp = fingerprintMaterial(
      `${question.fingerprintMaterial(order.state)}|${cfg.model}|${question.promptVersion}`,
    );
    if (lookup(fp)) {
      metrics.count(`${basePrefix}.cache.hit`);
      return 'cache-hit';
    }
    metrics.count(`${basePrefix}.cache.miss`);
    if (pending.has(fp) || inFlight.has(fp)) {
      metrics.count(`${basePrefix}.enqueue.dedup`);
      return 'dedup';
    }
    if (pending.size >= Math.max(1, cfg.queueMax)) {
      metrics.count(`${basePrefix}.enqueue.queue-full`);
      return 'queue-full';
    }
    const now = Date.now();
    if (budget.isCoolingDown(now)) {
      metrics.count(`${basePrefix}.enqueue.cooldown`);
      return 'cooldown';
    }
    if (!budget.budgetLeft(now)) {
      const cappedByDay = budget.snapshot(now).dailyUsed >= Math.max(1, cfg.dailyCap);
      metrics.count(cappedByDay ? `${basePrefix}.enqueue.day-cap` : `${basePrefix}.enqueue.cap`);
      return cappedByDay ? 'day-cap' : 'cap';
    }
    pending.set(fp, { state: order.state, det: Boolean(order.det), dim: order.dim });
    metrics.gauge(`${basePrefix}.queue.depth`, pending.size);
    metrics.count(`${basePrefix}.enqueue.ok`);
    scheduleDrain();
    return 'ok';
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      drain();
    });
  }

  function dispatch(fp: string, entry: PendingEntry<S>) {
    const cfg = config.typesafe;
    inFlight.add(fp);
    const startedAt = Date.now();
    askJevAudio({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      model: cfg.model,
      state: question.buildState(entry.state),
      questions: question.questions,
      questionId: question.questionId,
      timeoutMs: cfg.timeoutMs,
    })
      .then((res) => onOk(fp, entry, res, Date.now() - startedAt, cfg))
      .catch((err: unknown) => onErr(err))
      .finally(() => {
        inFlight.delete(fp);
        // Mais pendência só é drenada quando uma vaga de concorrência abre.
        scheduleDrain();
      });
  }

  function drain() {
    const cfg = config.typesafe;
    // Kill-switch no drain também: fila enfileirada antes do OFF descarta SEM
    // rede (o material re-enfileira quando o runtime voltar a ligar).
    if (!cfg.enabled || !cfg.apiKey) {
      pending.clear();
      metrics.gauge(`${basePrefix}.queue.depth`, 0);
      return;
    }
    // Pause NÃO descarta: diferentemente do kill-switch, a fila sobrevive para
    // o `drainNow()` (pós-`resume`) processar o que já estava enfileirado.
    if (paused) return;
    const now = Date.now();
    if (budget.isCoolingDown(now)) return; // o próximo enqueue/fim de voo reagenda
    const max = Math.max(1, cfg.concurrency);
    while (pending.size > 0 && inFlight.size < max && budget.budgetLeft(now)) {
      const fp = pending.keys().next().value as string;
      const entry = pending.get(fp) as PendingEntry<S>;
      pending.delete(fp);
      budget.consume(now);
      dispatch(fp, entry);
    }
    metrics.gauge(`${basePrefix}.queue.depth`, pending.size);
  }

  function onOk(
    fp: string,
    entry: PendingEntry<S>,
    res: { noul: number; usage?: { input: number; output: number }; model?: string },
    latencyMs: number,
    cfg: typeof config.typesafe,
  ) {
    budget.onSuccess();
    metrics.count(`${basePrefix}.call.ok`);
    metrics.observe(`${basePrefix}.latency`, latencyMs);
    if (res.usage) {
      metrics.count(`${basePrefix}.tokens.in`, res.usage.input);
      metrics.count(`${basePrefix}.tokens.out`, res.usage.output);
    }
    // Julgamento CRU no cache: threshold é aplicado SÓ na comparação abaixo.
    // `m` grava o ID versionado ecoado pela resposta (§5/§11 da referência):
    // o alias de config é móvel, e sem o eco o fallback preserva o alias —
    // mesmo comportamento de antes para resposta sem o campo (stubs de teste).
    store(fp, { n: res.noul, m: res.model || cfg.model, at: Date.now() }, cfg.judgmentTtlS);
    // Comparação SHADOW: só métrica. Nenhum item/resultado/decisão é tocado.
    const pred = res.noul >= cfg.threshold;
    if (pred === entry.det) {
      metrics.count(`${shadowPrefix}.agree`);
    } else {
      // Labels FIXOS (união fechada de dois lados) — nunca texto do item.
      metrics.count(`${shadowPrefix}.disagree`);
      const lado = pred ? detLabels.ai : detLabels.rule;
      metrics.count(`${shadowPrefix}.disagree.${lado}`);
      // Mesma divergência, agora por ORIGEM (união fechada de dimensões): as
      // métricas antigas acima seguem intactas — esta é a leitura adicional.
      metrics.count(`${shadowPrefix}.disagree.${lado}.${entry.dim}`);
    }
  }

  function onErr(err: unknown) {
    const kind: AskErrorKind = err instanceof AskError ? err.kind : 'network';
    metrics.count(`${basePrefix}.call.error.${kind}`); // kind vem de união FECHADA
    budget.onFailure(kind, err instanceof AskError ? err.retryAfterMs : undefined);
  }

  /** Resumo compacto para o bloco `typesafe` do /dashboard-status.json. */
  function statusSnapshot(): JudgmentCoreStatus {
    const cfg = config.typesafe;
    return {
      enabled: Boolean(cfg.enabled && cfg.apiKey),
      model: cfg.model,
      promptVersion: question.promptVersion,
      questionId: question.questionId,
      queueDepth: pending.size,
      inFlight: inFlight.size,
      ...budget.snapshot(Date.now()),
      paused,
    };
  }

  /** Só para teste: zera todo o estado da instância (fila, janelas, breaker). */
  function resetForTests() {
    pending.clear();
    inFlight.clear();
    budget.reset();
    paused = false;
    drainScheduled = false;
  }

  /** Só para teste: espera a fila esvaziar (teto de ticks para não pendurar). */
  function flushForTests(): Promise<void> {
    return new Promise((resolve) => {
      let ticks = 0;
      const step = () => {
        if ((pending.size === 0 && inFlight.size === 0) || ticks++ > 500) {
          resolve();
          return;
        }
        setImmediate(step);
      };
      step();
    });
  }

  function pause() {
    paused = true;
  }

  function resume() {
    paused = false;
    scheduleDrain();
  }

  function isPaused(): boolean {
    return paused;
  }

  /** Reagenda o drain (pós-resume ou operação manual do painel). */
  function drainNow() {
    scheduleDrain();
  }

  /** Zera cooldown/streak sem tocar fila nem janelas de custo. */
  function resetCooldown() {
    budget.clearCooldown();
  }

  return {
    enqueue,
    statusSnapshot,
    resetForTests,
    flushForTests,
    pause,
    resume,
    isPaused,
    drainNow,
    resetCooldown,
  };
}
