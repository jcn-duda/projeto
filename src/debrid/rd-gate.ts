import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import { isRateLimitError, RateLimitError, retryAfterMsOf } from './common.js';
import { rdOnFinished, rdOnRateLimit, rdOnSuccess } from '../utils/rust-debrid-rd.js';

type RdGatePriority = 'play' | 'cleanup' | 'autofetch' | 'probe';

type Waiter<T = unknown> = {
  priority: RdGatePriority;
  order: number;
  queuedAt: number;
  bypassAt: number;
  job: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type AccountState = {
  busy: boolean;
  gapMs: number;
  successes: number;
  nextAllowedAt: number;
  cooldownUntil: number;
  queues: Record<RdGatePriority, Waiter<any>[]>;
  wakeAt: number;
  rateLimits: number[];
};

type RdGateOptions = {
  enabled?: () => boolean;
  minGapMs?: () => number;
  maxGapMs?: () => number;
  cooldownMs?: () => number;
  playMaxWaitMs?: () => number;
  successThreshold?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type RdGateWaiterSnap = { priority: RdGatePriority; order: number; queuedAt: number; bypassAt: number };

/** Snapshot serializável. Sem fila de Promise: o Node guarda o job. */
type RdGateSnap = {
  busy: boolean; gapMs: number; successes: number; nextAllowedAt: number; cooldownUntil: number;
  nextOrder: number; rateLimits: number[]; queues: Record<RdGatePriority, RdGateWaiterSnap[]>;
};

type AimdInput = { minGapMs: number; maxGapMs: number; cooldownMs: number; retryAfterMs: number | undefined; now: number };

function rdGateLimits(minGapMs: number, maxGapMs: number) {
  const min = Math.max(0, minGapMs);
  return { min, max: Math.max(min, maxGapMs) };
}

export function rdGateInitialState(minGapMs: number, maxGapMs: number): RdGateSnap {
  return {
    busy: false, gapMs: rdGateLimits(minGapMs, maxGapMs).min, successes: 0, nextAllowedAt: 0,
    cooldownUntil: 0, nextOrder: 0, rateLimits: [],
    queues: { play: [], cleanup: [], autofetch: [], probe: [] },
  };
}

export function rdGateOnRateLimit(state: Pick<RdGateSnap, 'gapMs' | 'nextAllowedAt' | 'cooldownUntil' | 'rateLimits'>, input: AimdInput) {
  // Retry-After válido (≥ 0) vai como está; sem ele o Rust usa o cooldown.
  const supplied = Number(input.retryAfterMs);
  const honoredRetryAfter = Number.isFinite(supplied) && supplied >= 0;
  const suppliedRetry = honoredRetryAfter ? supplied : null;
  return rdOnRateLimit({
    gapMs: state.gapMs,
    nextAllowedAt: state.nextAllowedAt,
    cooldownUntil: state.cooldownUntil,
    rateLimits: state.rateLimits,
    now: input.now,
    minGapMs: input.minGapMs,
    maxGapMs: input.maxGapMs,
    cooldownMs: honoredRetryAfter ? 0 : input.cooldownMs,
    retryAfterMs: suppliedRetry,
  });
}

export function rdGateOnSuccess(gapMs: number, successes: number, successThreshold: number, minGapMs: number, maxGapMs: number) {
  return rdOnSuccess(gapMs, successes, successThreshold, minGapMs, maxGapMs);
}

export function rdGateOnFinished(nextAllowedAt: number, gapMs: number, now: number) {
  return rdOnFinished(nextAllowedAt, gapMs, now);
}

function rdGateBypassAt(now: number, playMaxWaitMs: number) {
  return now + Math.max(0, playMaxWaitMs);
}

function rdGateAdmit(enabled: boolean, priority: RdGatePriority, cooldownUntil: number, now: number): 'passthrough' | 'deny' | 'enqueue' {
  if (!enabled) return 'passthrough';
  if (priority !== 'play' && priority !== 'cleanup' && cooldownUntil > now) return 'deny';
  return 'enqueue';
}

function rdGateHeadPriority(queues: { play: readonly unknown[]; cleanup: readonly unknown[]; autofetch: readonly unknown[]; probe: readonly unknown[] }): RdGatePriority | null {
  if (queues.play.length) return 'play';
  if (queues.cleanup.length) return 'cleanup';
  if (queues.autofetch.length) return 'autofetch';
  if (queues.probe.length) return 'probe';
  return null;
}

/** Cleanup ignora gap e cooldown. Play fura os dois só a partir de `bypassAt`. */
function rdGateEligibleAt(priority: RdGatePriority, now: number, nextAllowedAt: number, cooldownUntil: number, bypassAt: number) {
  const normalAt = Math.max(nextAllowedAt, cooldownUntil);
  if (priority === 'cleanup') return now;
  if (priority === 'play') return Math.min(normalAt, bypassAt);
  return normalAt;
}

function copyGateQueues(queues: RdGateSnap['queues']): RdGateSnap['queues'] {
  const copy = (items: RdGateWaiterSnap[]) => items.map((item) => ({ ...item }));
  return { play: copy(queues.play), cleanup: copy(queues.cleanup), autofetch: copy(queues.autofetch), probe: copy(queues.probe) };
}

export function rdGateApplyAdmit(state: RdGateSnap, input: { enabled: boolean; priority: RdGatePriority; now: number; playMaxWaitMs: number }) {
  const action = rdGateAdmit(input.enabled, input.priority, state.cooldownUntil, input.now);
  if (action !== 'enqueue') return { action, state };
  const queues = copyGateQueues(state.queues);
  queues[input.priority].push({
    priority: input.priority, order: state.nextOrder, queuedAt: input.now,
    bypassAt: rdGateBypassAt(input.now, input.playMaxWaitMs),
  });
  queues[input.priority].sort((a, b) => a.order - b.order);
  return { action, state: { ...state, nextOrder: state.nextOrder + 1, queues } };
}

export function rdGateNextGrant(state: RdGateSnap, now: number, enabled: boolean) {
  const hold = (action: 'idle' | 'busy') => ({ action, until: null as number | null, priority: null as RdGatePriority | null, order: null as number | null, state });
  if (!enabled) return hold('idle');
  if (state.busy) return hold('busy');
  const priority = rdGateHeadPriority(state.queues);
  if (!priority) return hold('idle');
  const waiter = state.queues[priority][0];
  const eligibleAt = rdGateEligibleAt(priority, now, state.nextAllowedAt, state.cooldownUntil, waiter.bypassAt);
  if (eligibleAt > now) return { action: 'wait' as const, until: eligibleAt, priority: null, order: null, state };
  const queues = copyGateQueues(state.queues);
  queues[priority].shift();
  return { action: 'grant' as const, until: null, priority, order: waiter.order, state: { ...state, busy: true, queues } };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)).unref());
}

/**
 * Serializa escritas RD por conta. O AIMD atua no intervalo entre admissões:
 * 429 dobra o gap; cinco sucessos consecutivos o reduzem em 10%. Após
 * `playMaxWaitMs`, play fura só gap/cooldown: job já em voo continua até
 * terminar, pois o gate não preempta escrita em andamento.
 */
export function createRdGate(options: RdGateOptions = {}) {
  const enabled = options.enabled || (() => config.debrid.rdGate.enabled);
  const minGapMs = options.minGapMs || (() => config.debrid.rdGate.minGapMs);
  const maxGapMs = options.maxGapMs || (() => config.debrid.rdGate.maxGapMs);
  const cooldownMs = options.cooldownMs || (() => config.debrid.rdGate.cooldownMs);
  const playMaxWaitMs = options.playMaxWaitMs || (() => config.debrid.rdGate.playMaxWaitMs);
  const successThreshold = Math.max(1, Math.trunc(options.successThreshold ?? 5));
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const states = new Map<string, AccountState>();
  let order = 0;

  function limits() {
    return rdGateLimits(minGapMs(), maxGapMs());
  }

  function stateFor(accountScope: string): AccountState {
    let state = states.get(accountScope);
    if (!state) {
      state = {
        busy: false,
        gapMs: limits().min,
        successes: 0,
        nextAllowedAt: 0,
        cooldownUntil: 0,
        queues: { play: [], cleanup: [], autofetch: [], probe: [] },
        wakeAt: 0,
        rateLimits: [],
      };
      states.set(accountScope, state);
    }
    return state;
  }

  function queued(state: AccountState): number {
    return state.queues.play.length + state.queues.cleanup.length + state.queues.autofetch.length + state.queues.probe.length;
  }

  function wake(accountScope: string, state: AccountState, at: number) {
    if (state.wakeAt && state.wakeAt <= at) return;
    state.wakeAt = at;
    sleep(Math.max(0, at - now())).then(() => {
      if (state.wakeAt === at) state.wakeAt = 0;
      pump(accountScope, state);
    }).catch(() => {});
  }

  function nextWaiter(state: AccountState): Waiter | undefined {
    const priority = rdGateHeadPriority(state.queues);
    return priority ? state.queues[priority][0] : undefined;
  }

  function removeNext(state: AccountState, waiter: Waiter): void {
    state.queues[waiter.priority].shift();
  }

  function noteRateLimit(state: AccountState, retryAfterMs: number | undefined): void {
    const supplied = Number(retryAfterMs);
    const hasRetryAfter = Number.isFinite(supplied) && supplied >= 0;
    const step = rdGateOnRateLimit(state, {
      minGapMs: minGapMs(),
      maxGapMs: maxGapMs(),
      cooldownMs: hasRetryAfter ? 0 : cooldownMs(),
      retryAfterMs: hasRetryAfter ? supplied : undefined,
      now: now(),
    });
    state.gapMs = step.gapMs;
    state.successes = step.successes;
    state.nextAllowedAt = step.nextAllowedAt;
    state.cooldownUntil = step.cooldownUntil;
    state.rateLimits = step.rateLimits;
    metrics.count('debrid.rd.gate.rateLimit');
    if (step.honoredRetryAfter) metrics.count('debrid.rd.gate.retryAfterHonored');
  }

  function noteSuccess(state: AccountState): void {
    const willShrink = state.successes + 1 >= successThreshold;
    const lim = willShrink ? limits() : { min: 0, max: 0 };
    const next = rdGateOnSuccess(state.gapMs, state.successes, successThreshold, lim.min, lim.max);
    state.gapMs = next.gapMs;
    state.successes = next.successes;
  }

  function pump(accountScope: string, state = stateFor(accountScope)): void {
    if (!enabled() || state.busy) return;
    const waiter = nextWaiter(state);
    if (!waiter) return;
    const current = now();
    // Cleanup não espera cooldown/gap; ainda perde para play já na frente e para job em voo.
    const eligibleAt = rdGateEligibleAt(
      waiter.priority, current, state.nextAllowedAt, state.cooldownUntil, waiter.bypassAt,
    );
    if (eligibleAt > current) {
      wake(accountScope, state, eligibleAt);
      return;
    }

    removeNext(state, waiter);
    state.busy = true;
    metrics.count('debrid.rd.gate.granted');
    metrics.observe('debrid.rd.gate.waitMs', Math.max(0, current - waiter.queuedAt));
    Promise.resolve().then(waiter.job).then(
      (value) => {
        noteSuccess(state);
        waiter.resolve(value);
      },
      (error) => {
        if (isRateLimitError(error)) noteRateLimit(state, retryAfterMsOf(error));
        waiter.reject(error);
      },
    ).finally(() => {
      state.busy = false;
      state.nextAllowedAt = rdGateOnFinished(state.nextAllowedAt, state.gapMs, now());
      pump(accountScope, state);
    });
  }

  /**
   * Admite uma escrita. Play só fura gap/cooldown depois de `playMaxWaitMs`;
   * ele ainda espera um job em voo terminar, sem preempção.
   */
  function run<T>(accountScope: string, priority: RdGatePriority, job: () => Promise<T>): Promise<T> {
    if (!enabled()) return job();
    const state = stateFor(accountScope);
    const current = now();
    if (rdGateAdmit(true, priority, state.cooldownUntil, current) === 'deny') {
      metrics.count('debrid.rd.gate.denied');
      return Promise.reject(new RateLimitError('governador RD em cooldown'));
    }
    return new Promise<T>((resolve, reject) => {
      state.queues[priority].push({
        priority,
        order: order++,
        queuedAt: current,
        bypassAt: rdGateBypassAt(current, playMaxWaitMs()),
        job,
        resolve,
        reject,
      });
      // Cada fila já é FIFO; `order` fica no snapshot mental do contrato e
      // impede uma futura ordenação instável entre itens da mesma prioridade.
      state.queues[priority].sort((a, b) => a.order - b.order);
      pump(accountScope, state);
    });
  }

  function isCoolingDown(accountScope: string): boolean {
    return enabled() && (states.get(accountScope)?.cooldownUntil || 0) > now();
  }

  function cooldownRemainingMs(accountScope: string): number {
    if (!enabled()) return 0;
    return Math.max(0, (states.get(accountScope)?.cooldownUntil || 0) - now());
  }

  function snapshot(accountScope?: string) {
    const entries = accountScope
      ? [[accountScope, states.get(accountScope)] as const]
      : [...states.entries()];
    const hourAgo = now() - 3_600_000;
    return entries.flatMap(([scope, state]) => state ? [{
      accountScope: scope,
      busy: state.busy,
      gapMs: state.gapMs,
      successes: state.successes,
      nextAllowedAt: state.nextAllowedAt,
      cooldownUntil: state.cooldownUntil,
      queued: queued(state),
        waiting: {
          play: state.queues.play.length,
          cleanup: state.queues.cleanup.length,
          autofetch: state.queues.autofetch.length,
        probe: state.queues.probe.length,
      },
      rateLimitsLastHour: state.rateLimits.filter((at) => at >= hourAgo).length,
    }] : []);
  }

  function status(accountScope?: string) {
    return {
      enabled: enabled(),
      accounts: snapshot(accountScope),
    };
  }

  function reset(): void {
    for (const state of states.values()) {
      for (const priority of ['play', 'cleanup', 'autofetch', 'probe'] as const) {
        for (const waiter of state.queues[priority]) waiter.reject(new Error('governador RD reiniciado'));
      }
    }
    states.clear();
    order = 0;
  }

  return { run, isCoolingDown, cooldownRemainingMs, snapshot, status, reset };
}

export const rdGate = createRdGate();
