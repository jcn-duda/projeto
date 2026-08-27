import config from '../config.js';
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import * as log from './logger.js';

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

export interface AutofetchSchemaField {
  key: keyof Omit<AutofetchLiveConfig, 'pausedSince'>;
  label: string;
  type: 'boolean' | 'number';
  group: 'sources' | 'volume' | 'protection' | 'lifecycle';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  envDefault: boolean | number;
  description: string;
}

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

function envDefaults(): Omit<AutofetchLiveConfig, 'paused' | 'pausedSince'> {
  return {
    autoFetchBr: config.debrid.autoFetchBr,
    autoFetchAnyDubbed: config.debrid.autoFetchAnyDubbed,
    autoFetchTopSeeds: config.debrid.autoFetchTopSeeds,
    autoFetchSeedsPtFirst: config.debrid.autoFetchSeedsPtFirst,
    autoFetchMinSeeders: config.debrid.autoFetchMinSeeders,
    autoFetchMax: config.debrid.autoFetchMax,
    autoFetchTopSeedsMax: config.debrid.autoFetchTopSeedsMax,
    autoFetchEnqueueMaxHour: config.debrid.autoFetchEnqueueMaxHour,
    autoFetchQueue: config.debrid.autoFetchQueue,
    autoFetchQueueDepth: config.debrid.autoFetchQueueDepth,
    autoFetchPauseAt: config.debrid.autoFetchPauseAt,
    autoFetchPauseRefreshMs: config.debrid.autoFetchPauseRefreshMs,
    autoFetchTtl: config.debrid.autoFetchTtl,
    autoFetchRecheckMs: config.debrid.autoFetchRecheckMs,
    autoFetchRecheckMax: config.debrid.autoFetchRecheckMax,
    autoFetchStallStreak: config.debrid.autoFetchStallStreak,
    autoFetchSettleMs: config.debrid.autoFetchSettleMs,
    autoFetchDeadTtl: config.debrid.autoFetchDeadTtl,
    autoFetchSeasonFill: config.debrid.autoFetchSeasonFill,
  };
}

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
      return Math.min(4, Math.max(1, Math.trunc(n)));
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

export function schema(): AutofetchSchemaField[] {
  const defaults = envDefaults();
  return [
    {
      key: 'autoFetchBr',
      label: 'Fontes BR dubladas',
      type: 'boolean',
      group: 'sources',
      envDefault: defaults.autoFetchBr,
      description: 'Baixa torrents dublados de trackers brasileiros quando a busca não encontrar play em cache.',
    },
    {
      key: 'autoFetchAnyDubbed',
      label: 'Global com áudio PT',
      type: 'boolean',
      group: 'sources',
      envDefault: defaults.autoFetchAnyDubbed,
      description: 'Fallback quando não há fontes BR: baixa release de tracker global anunciando áudio PT.',
    },
    {
      key: 'autoFetchTopSeeds',
      label: 'Melhor enxame (sem dublado)',
      type: 'boolean',
      group: 'sources',
      envDefault: defaults.autoFetchTopSeeds,
      description: 'Rede de segurança para obras sem dublagem: baixa a melhor opção do enxame global.',
    },
    {
      key: 'autoFetchSeedsPtFirst',
      label: 'Preferir PT no enxame',
      type: 'boolean',
      group: 'sources',
      envDefault: defaults.autoFetchSeedsPtFirst,
      description: 'No fallback de enxame, prioriza candidatos com indício de português sobre a contagem bruta de seeders.',
    },
    {
      key: 'autoFetchMinSeeders',
      label: 'Seeders mínimos',
      type: 'number',
      group: 'sources',
      min: 0,
      step: 1,
      unit: 'seeders',
      envDefault: defaults.autoFetchMinSeeders,
      description: 'Mínimo de pares para considerar um download saudável. Abaixo disso, ignora o torrent.',
    },
    {
      key: 'autoFetchMax',
      label: 'Torrents por busca (BR/Dub)',
      type: 'number',
      group: 'volume',
      min: 1,
      max: 4,
      step: 1,
      envDefault: defaults.autoFetchMax,
      description: 'Quantos torrents dublados o chupim baixa em background por busca (1 a 4).',
    },
    {
      key: 'autoFetchTopSeedsMax',
      label: 'Torrents por busca (Swarm)',
      type: 'number',
      group: 'volume',
      min: 1,
      max: 4,
      step: 1,
      envDefault: defaults.autoFetchTopSeedsMax,
      description: 'Teto de downloads por busca quando acionado o fallback de melhor enxame (1 a 4).',
    },
    {
      key: 'autoFetchEnqueueMaxHour',
      label: 'Orçamento horário',
      type: 'number',
      group: 'volume',
      min: 1,
      step: 1,
      unit: '/h',
      envDefault: defaults.autoFetchEnqueueMaxHour,
      description: 'Máximo de novos downloads disparados por hora por conta de debrid.',
    },
    {
      key: 'autoFetchQueue',
      label: 'Fila persistente',
      type: 'boolean',
      group: 'volume',
      envDefault: defaults.autoFetchQueue,
      description: 'Enfileira candidatos excedentes no SQLite para download em lotes subsequentes.',
    },
    {
      key: 'autoFetchQueueDepth',
      label: 'Profundidade da fila',
      type: 'number',
      group: 'volume',
      min: 0,
      max: 12,
      step: 1,
      envDefault: defaults.autoFetchQueueDepth,
      description: 'Teto de candidatos retidos na fila para cada busca (0 a 12).',
    },
    {
      key: 'autoFetchPauseAt',
      label: 'Pausa por ocupação da conta',
      type: 'number',
      group: 'protection',
      min: 0,
      step: 50,
      unit: 'magnets',
      envDefault: defaults.autoFetchPauseAt,
      description: 'Com este número de magnets ou mais na conta, interrompe novos downloads (prevenção contra estouro de 1.590 magnets). 0 desliga.',
    },
    {
      key: 'autoFetchPauseRefreshMs',
      label: 'Intervalo de checagem da conta',
      type: 'number',
      group: 'protection',
      min: 0,
      step: 60000,
      unit: 'ms',
      envDefault: defaults.autoFetchPauseRefreshMs,
      description: 'Tempo de retenção em cache da contagem de magnets antes de reconsultar o debrid.',
    },
    {
      key: 'autoFetchTtl',
      label: 'TTL de retenção do download',
      type: 'number',
      group: 'lifecycle',
      min: 0,
      step: 3600,
      unit: 's',
      envDefault: defaults.autoFetchTtl,
      description: 'Tempo que a trava de um torrent aceito é mantida para não baixá-lo repetidamente.',
    },
    {
      key: 'autoFetchRecheckMs',
      label: 'Intervalo de recheck',
      type: 'number',
      group: 'lifecycle',
      min: 0,
      step: 10000,
      unit: 'ms',
      envDefault: defaults.autoFetchRecheckMs,
      description: 'Tempo entre consultas ao debrid para checar se o torrent já baixou e ficou pronto.',
    },
    {
      key: 'autoFetchRecheckMax',
      label: 'Tentativas de recheck',
      type: 'number',
      group: 'lifecycle',
      min: 0,
      step: 1,
      envDefault: defaults.autoFetchRecheckMax,
      description: 'Máximo de passes de recheck antes de desistir ou aguardar estabilização.',
    },
    {
      key: 'autoFetchStallStreak',
      label: 'Tolerância a download parado',
      type: 'number',
      group: 'lifecycle',
      min: 0,
      step: 1,
      envDefault: defaults.autoFetchStallStreak,
      description: 'Número consecutivo de rechecks com progresso zero antes de classificar o torrent como morto. 0 desliga.',
    },
    {
      key: 'autoFetchSettleMs',
      label: 'Intervalo de estabilização',
      type: 'number',
      group: 'lifecycle',
      min: 0,
      step: 60000,
      unit: 'ms',
      envDefault: defaults.autoFetchSettleMs,
      description: 'Intervalo de checagem para lotes longos em fase de estabilização.',
    },
    {
      key: 'autoFetchDeadTtl',
      label: 'TTL da blacklist de mortos',
      type: 'number',
      group: 'lifecycle',
      min: 0,
      step: 3600,
      unit: 's',
      envDefault: defaults.autoFetchDeadTtl,
      description: 'Tempo que um magnet comprovadamente morto permanece bloqueado.',
    },
    {
      key: 'autoFetchSeasonFill',
      label: 'Preenchimento de temporada',
      type: 'boolean',
      group: 'lifecycle',
      envDefault: defaults.autoFetchSeasonFill,
      description: 'Quando um pack de temporada completa, invalida buscas de episódios para usarem o pack pronto.',
    },
  ];
}

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
