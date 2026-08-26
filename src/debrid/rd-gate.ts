import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import { isRateLimitError, RateLimitError, retryAfterMsOf } from './common.js';

export type RdGatePriority = 'play' | 'cleanup' | 'autofetch' | 'probe';

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

export type RdGateOptions = {
  enabled?: () => boolean;
  minGapMs?: () => number;
  maxGapMs?: () => number;
  cooldownMs?: () => number;
  playMaxWaitMs?: () => number;
  successThreshold?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

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
    const min = Math.max(0, minGapMs());
    return { min, max: Math.max(min, maxGapMs()) };
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
    return state.queues.play[0] || state.queues.cleanup[0] || state.queues.autofetch[0] || state.queues.probe[0];
  }

  function removeNext(state: AccountState, waiter: Waiter): void {
    state.queues[waiter.priority].shift();
  }

  function noteRateLimit(state: AccountState, retryAfterMs: number | undefined): void {
    const { min, max } = limits();
    state.gapMs = Math.min(max, Math.max(min, state.gapMs * 2));
    state.successes = 0;
    const supplied = Number(retryAfterMs);
    const hasRetryAfter = Number.isFinite(supplied) && supplied >= 0;
    const waitMs = hasRetryAfter ? supplied : Math.max(0, cooldownMs());
    state.cooldownUntil = Math.max(state.cooldownUntil, now() + waitMs);
    state.nextAllowedAt = Math.max(state.nextAllowedAt, state.cooldownUntil);
    const hourAgo = now() - 3_600_000;
    state.rateLimits = state.rateLimits.filter((at) => at >= hourAgo);
    state.rateLimits.push(now());
    metrics.count('debrid.rd.gate.rateLimit');
    if (hasRetryAfter) metrics.count('debrid.rd.gate.retryAfterHonored');
  }

  function noteSuccess(state: AccountState): void {
    state.successes += 1;
    if (state.successes < successThreshold) return;
    state.successes = 0;
    const { min } = limits();
    state.gapMs = Math.max(min, Math.floor(state.gapMs * 0.9));
  }

  function pump(accountScope: string, state = stateFor(accountScope)): void {
    if (!enabled() || state.busy) return;
    const waiter = nextWaiter(state);
    if (!waiter) return;
    const current = now();
    const normalAt = Math.max(state.nextAllowedAt, state.cooldownUntil);
    // Cleanup libera vaga na conta; não deve esperar o cooldown que existe
    // para conter escritas que consomem recurso. Ainda respeita job em voo e
    // perde a vez para play já enfileirado.
    const eligibleAt = waiter.priority === 'cleanup'
      ? current
      : waiter.priority === 'play' ? Math.min(normalAt, waiter.bypassAt) : normalAt;
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
      state.nextAllowedAt = Math.max(state.nextAllowedAt, now() + state.gapMs);
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
    if (priority !== 'play' && priority !== 'cleanup' && state.cooldownUntil > current) {
      metrics.count('debrid.rd.gate.denied');
      return Promise.reject(new RateLimitError('governador RD em cooldown'));
    }
    return new Promise<T>((resolve, reject) => {
      state.queues[priority].push({
        priority,
        order: order++,
        queuedAt: current,
        bypassAt: current + Math.max(0, playMaxWaitMs()),
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
