/**
 * Fila assíncrona deduplicada do julgamento TypeSafe — SHADOW-ONLY.
 *
 * Contratos do slice (cobertos por test/typesafe-queue.test.ts):
 * - `enqueueAudioJudgment` é SÍNCRONO, nunca lança e NUNCA é awaited pela
 *   resposta: o drain roda em `setImmediate`, fora do orçamento de busca. O
 *   drain lê SÓ `config.typesafe` (knob de operador) — nunca `opts()`;
 * - teto DURO de fila (`queueMax`): excedente descarta — o título re-enfileira
 *   na próxima busca e o cache `tsj` evita re-chamada. Não existe fila
 *   infinita;
 * - orçamento de custo com DUAS janelas independentes (hora e dia); excedente
 *   vira resultado `cap`/`day-cap`, não chamada;
 * - breaker próprio: falha arma cooldown com backoff exponencial (base
 *   `cooldownMs`, fator 2^n até 32x); `rate` honra Retry-After (teto 5min);
 *   `auth` (401/403) para 30min com UM warn por processo — a chave nunca
 *   aparece na mensagem;
 * - 1 tentativa por item: falha NÃO re-enfileira em voo (quem volta a pedir é
 *   a próxima busca com o mesmo título);
 * - a comparação shadow (`noul >= threshold` vs veredito determinístico
 *   capturado no enqueue) produz SÓ MÉTRICA — nenhum objeto/resultado é
 *   alterado, e nenhum consumidor de decisão lê este módulo (tranca o teste
 *   de grafo).
 */
import config from '../config.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { fingerprint, lookup, store } from './audio-judgment-cache.js';
import { askJevAudio, AskError } from './typesafe-client.js';
import { PROMPT_VERSION } from './questions-audio.js';
import type { AskErrorKind, EnqueueResult } from './types.js';

const AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const RATE_COOLDOWN_MS = 60 * 1000;
const RATE_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const BACKOFF_MAX_FACTOR = 32;
const HOUR_MS = 60 * 60 * 1000;

interface PendingEntry {
  title: string;
  /** Veredito determinístico (`looksPtBr`/`_br`) capturado no enqueue. */
  det: boolean;
}

// Estado ÚNICO por processo. FIFO por inserção do Map.
const pending = new Map<string, PendingEntry>();
const inFlight = new Set<string>();
let hourly = { start: 0, count: 0 };
let daily = { day: '', count: 0 };
let cooldownUntil = 0;
let consecutiveFail = 0;
let authWarned = false;
let drainScheduled = false;

function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function rollWindows(now: number) {
  if (now - hourly.start >= HOUR_MS) hourly = { start: now, count: 0 };
  const day = dayKeyOf(now);
  if (daily.day !== day) daily = { day, count: 0 };
}

function budgetLeft(now: number): boolean {
  rollWindows(now);
  const cfg = config.typesafe;
  return hourly.count < Math.max(1, cfg.hourlyCap) && daily.count < Math.max(1, cfg.dailyCap);
}

function consumeBudget(now: number) {
  rollWindows(now);
  hourly.count += 1;
  daily.count += 1;
  metrics.gauge('typesafe.budget.hour', hourly.count);
  metrics.gauge('typesafe.budget.day', daily.count);
}

function armCooldown(until: number) {
  cooldownUntil = Math.max(cooldownUntil, until);
  metrics.count('typesafe.breaker.open');
}

/**
 * Enfileira um título para julgamento shadow. Devolve o resultado SEMâNTICO
 * (virou métrica fixa em `typesafe.enqueue.*`); `'ok'` significa apenas
 * "aceito na fila" — o processamento é todo em fundo.
 */
function enqueueAudioJudgment(title: string, det: boolean): EnqueueResult {
  const cfg = config.typesafe;
  metrics.gauge('typesafe.enabled', cfg.enabled && cfg.apiKey ? 1 : 0);
  // Curto-circuito ANTES do fingerprint: sem enabled+chave não há nem leitura
  // de cache — a garantia de inércia é por construção, não por configuração.
  if (!cfg.enabled || !cfg.apiKey) {
    metrics.count('typesafe.enqueue.disabled');
    return 'disabled';
  }
  const fp = fingerprint(title, cfg.model);
  if (lookup(fp)) {
    metrics.count('typesafe.cache.hit');
    return 'cache-hit';
  }
  metrics.count('typesafe.cache.miss');
  if (pending.has(fp) || inFlight.has(fp)) {
    metrics.count('typesafe.enqueue.dedup');
    return 'dedup';
  }
  if (pending.size >= Math.max(1, cfg.queueMax)) {
    metrics.count('typesafe.enqueue.queue-full');
    return 'queue-full';
  }
  const now = Date.now();
  if (now < cooldownUntil) {
    metrics.count('typesafe.enqueue.cooldown');
    return 'cooldown';
  }
  if (!budgetLeft(now)) {
    const cappedByDay = daily.count >= Math.max(1, cfg.dailyCap);
    metrics.count(cappedByDay ? 'typesafe.enqueue.day-cap' : 'typesafe.enqueue.cap');
    return cappedByDay ? 'day-cap' : 'cap';
  }
  pending.set(fp, { title: String(title || ''), det: Boolean(det) });
  metrics.gauge('typesafe.queue.depth', pending.size);
  metrics.count('typesafe.enqueue.ok');
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

function dispatch(fp: string, entry: PendingEntry) {
  const cfg = config.typesafe;
  inFlight.add(fp);
  const startedAt = Date.now();
  askJevAudio({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    title: entry.title,
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
  // rede (o título re-enfileira quando o runtime voltar a ligar).
  if (!cfg.enabled || !cfg.apiKey) {
    pending.clear();
    metrics.gauge('typesafe.queue.depth', 0);
    return;
  }
  const now = Date.now();
  if (now < cooldownUntil) return; // o próximo enqueue/fim de voo reagenda
  const max = Math.max(1, cfg.concurrency);
  while (pending.size > 0 && inFlight.size < max && budgetLeft(now)) {
    const fp = pending.keys().next().value as string;
    const entry = pending.get(fp) as PendingEntry;
    pending.delete(fp);
    consumeBudget(now);
    dispatch(fp, entry);
  }
  metrics.gauge('typesafe.queue.depth', pending.size);
}

function onOk(
  fp: string,
  entry: PendingEntry,
  res: { noul: number; usage?: { input: number; output: number } },
  latencyMs: number,
  cfg: typeof config.typesafe,
) {
  consecutiveFail = 0;
  metrics.count('typesafe.call.ok');
  metrics.observe('typesafe.latency', latencyMs);
  if (res.usage) {
    metrics.count('typesafe.tokens.in', res.usage.input);
    metrics.count('typesafe.tokens.out', res.usage.output);
  }
  // Julgamento CRU no cache: threshold é aplicado SÓ na comparação abaixo.
  store(fp, { n: res.noul, m: cfg.model, at: Date.now() }, cfg.judgmentTtlS);
  // Comparação SHADOW: só métrica. Nenhum item/resultado/decisão é tocado.
  const pred = res.noul >= cfg.threshold;
  if (pred === entry.det) {
    metrics.count('typesafe.shadow.agree');
  } else {
    // Labels FIXOS (união fechada de dois lados) — nunca texto do título.
    metrics.count('typesafe.shadow.disagree');
    metrics.count(pred ? 'typesafe.shadow.disagree.ai-pt' : 'typesafe.shadow.disagree.rule-pt');
  }
}

function onErr(err: unknown) {
  const kind: AskErrorKind = err instanceof AskError ? err.kind : 'network';
  metrics.count(`typesafe.call.error.${kind}`); // kind vem de união FECHADA
  consecutiveFail += 1;
  const now = Date.now();
  if (kind === 'auth') {
    armCooldown(now + AUTH_COOLDOWN_MS);
    metrics.count('typesafe.auth.stop');
    if (!authWarned) {
      authWarned = true;
      log.warn('[typesafe] chave recusada (auth): chamadas pausadas por 30min; busca segue pelas regras determinísticas');
    }
    return;
  }
  if (kind === 'rate') {
    const retryAfter = (err instanceof AskError && err.retryAfterMs) || RATE_COOLDOWN_MS;
    armCooldown(now + Math.min(Math.max(0, retryAfter), RATE_COOLDOWN_MAX_MS));
    return;
  }
  // timeout/network/http/shape: backoff exponencial com base de config —
  // mesma forma do breaker local do Torrentio (sucesso zera o streak).
  const factor = Math.min(Math.pow(2, consecutiveFail), BACKOFF_MAX_FACTOR);
  armCooldown(now + Math.max(1000, config.typesafe.cooldownMs) * factor);
}

/** Resumo compacto para o bloco `typesafe` do /dashboard-status.json. */
function statusSnapshot() {
  const cfg = config.typesafe;
  const now = Date.now();
  return {
    enabled: Boolean(cfg.enabled && cfg.apiKey),
    model: cfg.model,
    promptVersion: PROMPT_VERSION,
    queueDepth: pending.size,
    inFlight: inFlight.size,
    hourlyUsed: hourly.count,
    hourlyCap: cfg.hourlyCap,
    dailyUsed: daily.count,
    dailyCap: cfg.dailyCap,
    cooldownRemainingMs: Math.max(0, cooldownUntil - now),
    consecutiveFail,
  };
}

/** Só para teste: zera todo o estado do módulo (fila, janelas, breaker). */
function resetForTests() {
  pending.clear();
  inFlight.clear();
  hourly = { start: 0, count: 0 };
  daily = { day: '', count: 0 };
  cooldownUntil = 0;
  consecutiveFail = 0;
  authWarned = false;
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

export {
  enqueueAudioJudgment,
  statusSnapshot,
  resetForTests,
  flushForTests,
};
