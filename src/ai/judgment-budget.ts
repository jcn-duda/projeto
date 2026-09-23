/**
 * Orçamento e breaker do julgamento TypeSafe — fábrica PURA de instâncias.
 * Extraído da fila original (audio-judgment-queue.ts) para o
 * motor genérico (judgment-queue-core.ts) reutilizar A MESMA lógica entre
 * perguntas sem duplicar nada aqui dentro.
 *
 * Contratos preservados do slice (cobertos por test/typesafe-queue.test.ts):
 * - DUAS janelas independentes de custo (hora e dia); excedente é decisão do
 *   chamador (`cap`/`day-cap`), nunca chamada;
 * - breaker próprio: falha arma cooldown com backoff exponencial (base
 *   `cooldownMs` de config, fator 2^n até 32x); QUALQUER kind não-auth honra
 *   Retry-After quando o serviço mandou o header (429 e 529, §8.1 — teto
 *   5min), com fallback por kind: `rate` usa piso fixo, os demais backoff;
 *   `auth` (401/403) para 30min com UM warn por instância — a chave nunca
 *   aparece na mensagem;
 * - sucesso zera o streak de falhas (mesma forma do breaker do Torrentio).
 *
 * Nenhum estado global: todo o estado mora no closure da instância. A fábrica
 * serve a qualquer número de instâncias independentes; em produção as duas
 * perguntas usam UMA instância compartilhada (`judgment-shared-budget.ts`)
 * de propósito — mesma chave, mesmo limite do provedor, então um rate/auth em
 * qualquer pergunta arma o cooldown das duas.
 */
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import type { AskErrorKind } from './types.js';

const AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const RATE_COOLDOWN_MS = 60 * 1000;
const RATE_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const BACKOFF_MAX_FACTOR = 32;
const HOUR_MS = 60 * 60 * 1000;

/** Fatia de `config.typesafe` que o orçamento lê (knob de operador). */
export interface JudgmentBudgetCfg {
  hourlyCap: number;
  dailyCap: number;
  cooldownMs: number;
}

export interface JudgmentBudgetSnapshot {
  hourlyUsed: number;
  hourlyCap: number;
  dailyUsed: number;
  dailyCap: number;
  cooldownRemainingMs: number;
  consecutiveFail: number;
}

export interface JudgmentBudget {
  rollWindows(now: number): void;
  budgetLeft(now: number): boolean;
  consume(now: number): void;
  isCoolingDown(now: number): boolean;
  cooldownRemaining(now: number): number;
  armCooldown(until: number): void;
  onSuccess(): void;
  onFailure(kind: AskErrorKind, retryAfterMs?: number | null): void;
  /** Zera SÓ cooldown/streak (janelas de custo intatas) — botão do painel. */
  clearCooldown(): void;
  reset(): void;
  snapshot(now: number): JudgmentBudgetSnapshot;
}

export function createJudgmentBudget(
  cfg: () => JudgmentBudgetCfg,
  basePrefix: string,
): JudgmentBudget {
  // Estado ÚNICO desta instância (ela pode ser injetada em mais de uma fila).
  let hourly = { start: 0, count: 0 };
  let daily = { day: '', count: 0 };
  let cooldownUntil = 0;
  let consecutiveFail = 0;
  let authWarned = false;

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
    const c = cfg();
    return hourly.count < Math.max(1, c.hourlyCap) && daily.count < Math.max(1, c.dailyCap);
  }

  function consume(now: number) {
    rollWindows(now);
    hourly.count += 1;
    daily.count += 1;
    metrics.gauge(`${basePrefix}.budget.hour`, hourly.count);
    metrics.gauge(`${basePrefix}.budget.day`, daily.count);
  }

  function isCoolingDown(now: number): boolean {
    return now < cooldownUntil;
  }

  function cooldownRemaining(now: number): number {
    return Math.max(0, cooldownUntil - now);
  }

  function armCooldown(until: number) {
    cooldownUntil = Math.max(cooldownUntil, until);
    metrics.count(`${basePrefix}.breaker.open`);
  }

  function onSuccess() {
    consecutiveFail = 0;
  }

  function onFailure(kind: AskErrorKind, retryAfterMs?: number | null) {
    consecutiveFail += 1;
    const now = Date.now();
    if (kind === 'auth') {
      armCooldown(now + AUTH_COOLDOWN_MS);
      metrics.count(`${basePrefix}.auth.stop`);
      if (!authWarned) {
        authWarned = true;
        log.warn('[typesafe] chave recusada (auth): chamadas pausadas por 30min; busca segue pelas regras determinísticas');
      }
      return;
    }
    // Retry-After do serviço vence o fallback de QUALQUER kind não-auth
    // (§8.1: 429 e 529 mandam o header; 529 chega como kind 'http'). Só um
    // valor finito e positivo arma cooldown — sem header, cada kind segue o
    // caminho de baixo.
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      armCooldown(now + Math.min(retryAfterMs, RATE_COOLDOWN_MAX_MS));
      return;
    }
    if (kind === 'rate') {
      // Fallback do rate sem header: piso fixo de 1min (o teto é o mesmo).
      armCooldown(now + RATE_COOLDOWN_MS);
      return;
    }
    // timeout/network/http/shape: backoff exponencial com base de config —
    // mesma forma do breaker local do Torrentio (sucesso zera o streak).
    const factor = Math.min(Math.pow(2, consecutiveFail), BACKOFF_MAX_FACTOR);
    armCooldown(now + Math.max(1000, cfg().cooldownMs) * factor);
  }

  function clearCooldown() {
    cooldownUntil = 0;
    consecutiveFail = 0;
  }

  /** Só para teste/reset: zera janelas, breaker e o warn único. */
  function reset() {
    hourly = { start: 0, count: 0 };
    daily = { day: '', count: 0 };
    cooldownUntil = 0;
    consecutiveFail = 0;
    authWarned = false;
  }

  function snapshot(now: number): JudgmentBudgetSnapshot {
    const c = cfg();
    return {
      hourlyUsed: hourly.count,
      hourlyCap: c.hourlyCap,
      dailyUsed: daily.count,
      dailyCap: c.dailyCap,
      cooldownRemainingMs: cooldownRemaining(now),
      consecutiveFail,
    };
  }

  return {
    rollWindows,
    budgetLeft,
    consume,
    isCoolingDown,
    cooldownRemaining,
    armCooldown,
    onSuccess,
    onFailure,
    clearCooldown,
    reset,
    snapshot,
  };
}
