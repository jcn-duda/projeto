// Config ao vivo do colhedor: estado (overrides em memória) + persistência no
// SQLite sob `cfg:v1:harvester`, com cópia em memória para leitura sem rede.
// O contrato (tipos, schema e validação/clamps) mora em harvester-live-schema.ts
// — separado de propósito para que os limites declarados e os aplicados fiquem
// no mesmo arquivo; este módulo só decide ONDE o estado vive.
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import * as log from './logger.js';
import {
  envDefaults,
  sanitizePatch,
  schema,
  type HarvesterEffectiveConfig,
  type HarvesterLiveConfig,
  type HarvesterSchemaField,
} from './harvester-live-schema.js';

export { schema } from './harvester-live-schema.js';
export type { HarvesterLiveConfig, HarvesterEffectiveConfig, HarvesterSchemaField } from './harvester-live-schema.js';

const CONFIG_KEY = `${prefix('cfg')}harvester`;
const INFINITE_TTL = 315_360_000; // 10 anos em segundos

let inMemoryOverrides: Partial<HarvesterLiveConfig> = {};
let isInitialized = false;

function initIfNeeded(): void {
  if (isInitialized) return;
  isInitialized = true;
  try {
    const raw = cache.get(CONFIG_KEY);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const sanitized = sanitizePatch(raw);
      inMemoryOverrides = sanitized.clean;
      log.info(`[harvest-live] overrides carregados do disco: ${Object.keys(inMemoryOverrides).length} chave(s)`);
    }
  } catch (err: unknown) {
    log.warn('[harvest-live] falha ao carregar overrides do cache:', log.errorMessage(err));
  }
}

export function effective(): HarvesterEffectiveConfig {
  initIfNeeded();
  const env = envDefaults();
  const res: HarvesterEffectiveConfig = {
    ...env,
    ...inMemoryOverrides,
    paused: Boolean(inMemoryOverrides.paused),
    pausedSince: inMemoryOverrides.pausedSince ?? null,
  };
  return res;
}

export function isPaused(): boolean {
  initIfNeeded();
  return Boolean(inMemoryOverrides.paused);
}

export function setPaused(paused: boolean): boolean {
  initIfNeeded();
  const next = Boolean(paused);
  inMemoryOverrides.paused = next;
  inMemoryOverrides.pausedSince = next ? (inMemoryOverrides.pausedSince || Date.now()) : null;
  persist();
  return next;
}

export function set(patch: Record<string, unknown>): {
  ok: boolean;
  effective: HarvesterEffectiveConfig;
  overriddenKeys: string[];
  errors?: string[];
} {
  initIfNeeded();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, effective: effective(), overriddenKeys: Object.keys(inMemoryOverrides), errors: ['Payload inválido'] };
  }

  const { clean, errors, overriddenKeys } = sanitizePatch(patch);
  if (errors.length > 0) {
    return { ok: false, effective: effective(), overriddenKeys: Object.keys(inMemoryOverrides), errors };
  }

  for (const [k, v] of Object.entries(clean)) {
    if (k === 'paused') {
      const next = Boolean(v);
      inMemoryOverrides.paused = next;
      inMemoryOverrides.pausedSince = next ? (inMemoryOverrides.pausedSince || Date.now()) : null;
    } else {
      (inMemoryOverrides as Record<string, unknown>)[k] = v;
    }
  }

  persist();
  return { ok: true, effective: effective(), overriddenKeys: Object.keys(inMemoryOverrides) };
}

export function reset(): HarvesterEffectiveConfig {
  initIfNeeded();
  inMemoryOverrides = {};
  try {
    cache.forget(CONFIG_KEY);
    log.info('[harvest-live] todos os overrides foram restaurados para os padrões do .env');
  } catch (err: unknown) {
    log.warn('[harvest-live] falha ao limpar overrides do cache:', log.errorMessage(err));
  }
  return effective();
}

function persist(): void {
  try {
    if (Object.keys(inMemoryOverrides).length === 0) {
      cache.forget(CONFIG_KEY);
    } else {
      cache.set(CONFIG_KEY, inMemoryOverrides, INFINITE_TTL);
    }
  } catch (err: unknown) {
    log.warn('[harvest-live] erro ao persistir overrides no cache:', log.errorMessage(err));
  }
}

export interface HarvesterConfigSnapshot {
  effective: HarvesterEffectiveConfig;
  envDefaults: Omit<HarvesterLiveConfig, 'paused' | 'pausedSince'>;
  overriddenKeys: string[];
  paused: boolean;
  pausedSince: number | null;
  schema: HarvesterSchemaField[];
}

export function snapshot(): HarvesterConfigSnapshot {
  initIfNeeded();
  const eff = effective();
  const env = envDefaults();
  const overridden = Object.keys(inMemoryOverrides).filter((k) => k !== 'paused' && k !== 'pausedSince');
  return {
    effective: eff,
    envDefaults: env,
    overriddenKeys: overridden,
    paused: eff.paused,
    pausedSince: eff.pausedSince,
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
