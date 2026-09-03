import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import * as log from './logger.js';
import { envDefaults, schema, type AutofetchSchemaField } from './autofetch-live-schema.js';

export interface AutofetchLiveConfig {
  autoFetchBr: boolean;
  autoFetchAnyDubbed: boolean;
  autoFetchTopSeeds: boolean;
  autoFetchSeedsPtFirst: boolean;
  autoFetchMinSeeders: number;
  autoFetchMax: number;
  autoFetchTopSeedsMax: number;
  autoFetchEnqueueMaxHour: number;
  autoFetchQueue: boolean;
  autoFetchQueueDepth: number;
  autoFetchPauseAt: number;
  autoFetchPauseRefreshMs: number;
  autoFetchTtl: number;
  autoFetchRecheckMs: number;
  autoFetchRecheckMax: number;
  autoFetchStallStreak: number;
  autoFetchSettleMs: number;
  autoFetchDeadTtl: number;
  autoFetchSeasonFill: boolean;
  paused: boolean;
  pausedSince: number | null;
}

export type AutofetchEffectiveConfig = Omit<AutofetchLiveConfig, 'pausedSince'> & {
  paused: boolean;
  pausedSince: number | null;
};

export type { AutofetchSchemaField };

const CONFIG_KEY = `${prefix('cfg')}autofetch`;
const INFINITE_TTL = 315_360_000; // 10 anos em segundos

const BOOLEAN_KEYS = new Set<string>([
  'autoFetchBr',
  'autoFetchAnyDubbed',
  'autoFetchTopSeeds',
  'autoFetchSeedsPtFirst',
  'autoFetchQueue',
  'autoFetchSeasonFill',
  'paused',
]);

const NUMBER_KEYS = new Set<string>([
  'autoFetchMinSeeders',
  'autoFetchMax',
  'autoFetchTopSeedsMax',
  'autoFetchEnqueueMaxHour',
  'autoFetchQueueDepth',
  'autoFetchPauseAt',
  'autoFetchPauseRefreshMs',
  'autoFetchTtl',
  'autoFetchRecheckMs',
  'autoFetchRecheckMax',
  'autoFetchStallStreak',
  'autoFetchSettleMs',
  'autoFetchDeadTtl',
]);

const ALL_KEYS = new Set<string>([...BOOLEAN_KEYS, ...NUMBER_KEYS]);

let inMemoryOverrides: Partial<AutofetchLiveConfig> = {};
let isInitialized = false;

function ensureInitialized() {
  if (isInitialized) return;
  isInitialized = true;
  try {
    const raw = (cache.peek(CONFIG_KEY) || cache.get(CONFIG_KEY)) as Partial<AutofetchLiveConfig> | null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const sanitized: Partial<AutofetchLiveConfig> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (ALL_KEYS.has(k)) {
          (sanitized as any)[k] = clampValue(k, v);
        }
      }
      if (typeof raw.pausedSince === 'number') {
        sanitized.pausedSince = raw.pausedSince;
      }
      inMemoryOverrides = sanitized;
    }
  } catch (err: unknown) {
    log.warn('[autofetch-live] falha ao carregar configuração persistida:', (err as Error)?.message || err);
  }
}

function clampValue(key: string, value: any): any {
  if (BOOLEAN_KEYS.has(key)) {
    return Boolean(value);
  }
  const n = Number(value);
  switch (key) {
    case 'autoFetchMax':
      return Math.min(12, Math.max(1, Math.trunc(n)));
    case 'autoFetchTopSeedsMax':
      return Math.min(4, Math.max(1, Math.trunc(n)));
    case 'autoFetchQueueDepth':
      return Math.min(12, Math.max(0, Math.trunc(n)));
    case 'autoFetchMinSeeders':
      return Math.max(0, Math.trunc(n));
    case 'autoFetchEnqueueMaxHour':
      return Math.max(1, Math.trunc(n));
    case 'autoFetchPauseAt':
      return Math.max(0, Math.trunc(n));
    case 'autoFetchStallStreak':
      return Math.max(0, Math.trunc(n));
    case 'autoFetchPauseRefreshMs':
    case 'autoFetchTtl':
    case 'autoFetchRecheckMs':
    case 'autoFetchRecheckMax':
    case 'autoFetchSettleMs':
    case 'autoFetchDeadTtl':
      return Math.max(0, n);
    default:
      return n;
  }
}

function persistState() {
  if (Object.keys(inMemoryOverrides).length === 0) {
    cache.forget(CONFIG_KEY);
  } else {
    cache.set(CONFIG_KEY, inMemoryOverrides, INFINITE_TTL);
  }
}

export function effective(): AutofetchEffectiveConfig {
  ensureInitialized();
  const defaults = envDefaults();
  const res: AutofetchEffectiveConfig = {
    ...defaults,
    paused: false,
    pausedSince: null,
  };
  for (const [k, v] of Object.entries(inMemoryOverrides)) {
    if (v !== undefined) {
      (res as any)[k] = v;
    }
  }
  return res;
}

export function isPaused(): boolean {
  ensureInitialized();
  return inMemoryOverrides.paused === true;
}

export function setPaused(paused: boolean): boolean {
  ensureInitialized();
  const isP = Boolean(paused);
  if (isP) {
    inMemoryOverrides.paused = true;
    if (!inMemoryOverrides.pausedSince) {
      inMemoryOverrides.pausedSince = Date.now();
    }
  } else {
    inMemoryOverrides.paused = false;
    inMemoryOverrides.pausedSince = null;
  }
  persistState();
  return isP;
}

export function set(patch: Record<string, any>): {
  ok: true;
  effective: AutofetchEffectiveConfig;
  overriddenKeys: string[];
} | {
  ok: false;
  errors: string[];
} {
  ensureInitialized();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['patch deve ser um objeto'] };
  }

  const errors: string[] = [];
  const validatedPatch: Record<string, any> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!ALL_KEYS.has(key)) {
      errors.push(`chave desconhecida: "${key}"`);
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') {
        errors.push(`campo "${key}" deve ser booleano`);
      } else {
        validatedPatch[key] = value;
      }
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`campo "${key}" deve ser um número finito`);
      } else {
        validatedPatch[key] = clampValue(key, value);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  for (const [key, value] of Object.entries(validatedPatch)) {
    if (key === 'paused') {
      if (value === true) {
        inMemoryOverrides.paused = true;
        if (!inMemoryOverrides.pausedSince) inMemoryOverrides.pausedSince = Date.now();
      } else {
        inMemoryOverrides.paused = false;
        inMemoryOverrides.pausedSince = null;
      }
    } else {
      (inMemoryOverrides as any)[key] = value;
    }
  }

  persistState();
  const eff = effective();
  const overriddenKeys = Object.keys(inMemoryOverrides).filter(
    (k) => k !== 'pausedSince' && inMemoryOverrides[k as keyof AutofetchLiveConfig] !== undefined,
  );

  return { ok: true, effective: eff, overriddenKeys };
}

export function reset(): AutofetchEffectiveConfig {
  ensureInitialized();
  inMemoryOverrides = {};
  persistState();
  return effective();
}
export { schema };

export function snapshot() {
  ensureInitialized();
  const eff = effective();
  const defaults = envDefaults();
  const overriddenKeys = Object.keys(inMemoryOverrides).filter(
    (k) => k !== 'pausedSince' && inMemoryOverrides[k as keyof AutofetchLiveConfig] !== undefined,
  );
  return {
    effective: eff,
    envDefaults: defaults,
    overriddenKeys,
    paused: isPaused(),
    pausedSince: inMemoryOverrides.pausedSince ?? null,
    schema: schema(),
  };
}

export default {
  effective,
  isPaused,
  setPaused,
  set,
  reset,
  schema,
  snapshot,
};
