// Contrato e validação da config ao vivo do colhedor — separados do estado
// (harvester-live.ts) porque o schema é a única fonte dos limites: os mesmos
// clamps do switch do sanitizePatch aparecem nos campos min/max do schema, e
// manter os dois juntos evita que um ajuste de teto escape da validação.
// Módulo puro: nenhuma mutação de estado, nenhuma escrita em cache.
import config from '../config.js';

export interface HarvesterLiveConfig {
  harvestEnabled: boolean;
  harvestMaxPerHour: number;
  harvestIdleWindowMs: number;
  harvestIntervalMs: number;
  harvestQueueMax: number;
  harvestDrainMaxWorks: number;
  harvestIndexerDelayMs: number;
  harvestEntryTtl: number;
  harvestBrFirst: boolean;
  harvestBrMaxWaitMs: number;
  seedEnabled: boolean;
  seedMaxPerCycle: number;
  seedMinVotes: number;
  seedIntervalH: number;
  paused: boolean;
  pausedSince: number | null;
}

export type HarvesterEffectiveConfig = Omit<HarvesterLiveConfig, 'pausedSince'> & {
  paused: boolean;
  pausedSince: number | null;
};

export interface HarvesterSchemaField {
  key: keyof Omit<HarvesterLiveConfig, 'pausedSince'>;
  label: string;
  type: 'boolean' | 'number';
  group: 'traffic' | 'queue' | 'seed';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  envDefault: boolean | number;
  description: string;
}

export const BOOLEAN_KEYS = new Set<string>([
  'harvestEnabled',
  'harvestBrFirst',
  'seedEnabled',
  'paused',
]);

export const NUMBER_KEYS = new Set<string>([
  'harvestMaxPerHour',
  'harvestIdleWindowMs',
  'harvestIntervalMs',
  'harvestQueueMax',
  'harvestDrainMaxWorks',
  'harvestIndexerDelayMs',
  'harvestEntryTtl',
  'harvestBrMaxWaitMs',
  'seedMaxPerCycle',
  'seedMinVotes',
  'seedIntervalH',
]);

export const ALL_KEYS = new Set<string>([...BOOLEAN_KEYS, ...NUMBER_KEYS]);

export function envDefaults(): Omit<HarvesterLiveConfig, 'paused' | 'pausedSince'> {
  return {
    harvestEnabled: config.harvest.enabled,
    harvestMaxPerHour: config.harvest.maxPerHour,
    harvestIdleWindowMs: config.harvest.idleWindowMs,
    harvestIntervalMs: config.harvest.intervalMs,
    harvestQueueMax: config.harvest.queueMax,
    harvestDrainMaxWorks: config.harvest.drainMaxWorks,
    harvestIndexerDelayMs: config.harvest.indexerDelayMs,
    harvestEntryTtl: config.harvest.entryTtl,
    harvestBrFirst: config.harvest.brFirst,
    harvestBrMaxWaitMs: config.harvest.brMaxWaitMs,
    seedEnabled: config.seed.enabled,
    seedMaxPerCycle: config.seed.maxPerCycle,
    seedMinVotes: config.seed.minVotes,
    seedIntervalH: config.seed.intervalH,
  };
}

export function schema(): HarvesterSchemaField[] {
  const env = envDefaults();
  return [
    {
      key: 'harvestEnabled',
      label: 'Colhedor Ativo',
      type: 'boolean',
      group: 'traffic',
      envDefault: env.harvestEnabled,
      description: 'Ativa ou desativa a colheita em segundo plano.',
    },
    {
      key: 'harvestMaxPerHour',
      label: 'Teto de Consultas por Hora',
      type: 'number',
      group: 'traffic',
      min: 1,
      max: 1000,
      step: 1,
      unit: 'consultas/hora',
      envDefault: env.harvestMaxPerHour,
      description: 'Número máximo de consultas aos indexadores por hora (educação com trackers).',
    },
    {
      key: 'harvestIdleWindowMs',
      label: 'Janela de Ociosidade',
      type: 'number',
      group: 'traffic',
      min: 0,
      max: 3600_000,
      step: 10_000,
      unit: 'ms',
      envDefault: env.harvestIdleWindowMs,
      description: 'Tempo sem tráfego de usuário necessário para permitir a colheita.',
    },
    {
      key: 'harvestIntervalMs',
      label: 'Intervalo do Ciclo',
      type: 'number',
      group: 'traffic',
      min: 1000,
      max: 600_000,
      step: 1000,
      unit: 'ms',
      envDefault: env.harvestIntervalMs,
      description: 'Frequência de verificação da fila do colhedor.',
    },
    {
      key: 'harvestIndexerDelayMs',
      label: 'Atraso entre Indexadores',
      type: 'number',
      group: 'traffic',
      min: 0,
      max: 10_000,
      step: 100,
      unit: 'ms',
      envDefault: env.harvestIndexerDelayMs,
      description: 'Pausa entre requisições sequenciais para não sobrecarregar os indexadores.',
    },
    {
      key: 'harvestQueueMax',
      label: 'Capacidade Máxima da Fila',
      type: 'number',
      group: 'queue',
      min: 10,
      max: 1000,
      step: 10,
      unit: 'obras',
      envDefault: env.harvestQueueMax,
      description: 'Limite de obras mantidas na fila de colheita.',
    },
    {
      key: 'harvestDrainMaxWorks',
      label: 'Lote de Drenagem Manual',
      type: 'number',
      group: 'queue',
      min: 1,
      max: 50,
      step: 1,
      unit: 'obras',
      envDefault: env.harvestDrainMaxWorks,
      description: 'Quantidade de obras processadas ao clicar em Drenar Fila no painel.',
    },
    {
      key: 'harvestEntryTtl',
      label: 'TTL de Entrada na Fila',
      type: 'number',
      group: 'queue',
      min: 3600,
      max: 2_592_000,
      step: 3600,
      unit: 'segundos',
      envDefault: env.harvestEntryTtl,
      description: 'Tempo de expiração das obras na fila do colhedor.',
    },
    {
      key: 'harvestBrFirst',
      label: 'Priorizar Fila por BR',
      type: 'boolean',
      group: 'queue',
      envDefault: env.harvestBrFirst,
      description: 'Obra com evidência BR (play ou release BR dublada no índice) sai antes na fila do colhedor.'
    },
    {
      key: 'harvestBrMaxWaitMs',
      label: 'Prazo Máx. sem BR (Fome)',
      type: 'number',
      group: 'queue',
      min: 0,
      max: 172_800_000,
      step: 3600_000,
      unit: 'ms',
      envDefault: env.harvestBrMaxWaitMs,
      description: 'Prazo que uma obra sem evidência BR pode esperar antes de subir na frente (evita fome).'
    },
    {
      key: 'seedEnabled',
      label: 'Sementes Populares IMDb',
      type: 'boolean',
      group: 'seed',
      envDefault: env.seedEnabled,
      description: 'Coleta proativamente títulos populares do IMDb via RapidAPI.',
    },
    {
      key: 'seedMaxPerCycle',
      label: 'Máximo de Sementes por Ciclo',
      type: 'number',
      group: 'seed',
      min: 1,
      max: 100,
      step: 1,
      unit: 'obras',
      envDefault: env.seedMaxPerCycle,
      description: 'Teto de obras populares enfileiradas a cada ciclo de semente.',
    },
    {
      key: 'seedMinVotes',
      label: 'Piso de Votos Populares',
      type: 'number',
      group: 'seed',
      min: 0,
      max: 100_000,
      step: 100,
      unit: 'votos',
      envDefault: env.seedMinVotes,
      description: 'Mínimo de avaliações no IMDb para considerar um título relevante.',
    },
    {
      key: 'seedIntervalH',
      label: 'Intervalo de Semente',
      type: 'number',
      group: 'seed',
      min: 1,
      max: 168,
      step: 1,
      unit: 'horas',
      envDefault: env.seedIntervalH,
      description: 'Frequência de consulta à lista de populares do IMDb.',
    },
  ];
}

export function sanitizePatch(patch: Record<string, unknown>): {
  clean: Partial<HarvesterLiveConfig>;
  errors: string[];
  overriddenKeys: string[];
} {
  const clean: Partial<HarvesterLiveConfig> = {};
  const errors: string[] = [];
  const overriddenKeys: string[] = [];

  for (const [k, val] of Object.entries(patch)) {
    if (!ALL_KEYS.has(k)) {
      errors.push(`Chave desconhecida: "${k}"`);
      continue;
    }

    if (BOOLEAN_KEYS.has(k)) {
      if (typeof val === 'boolean') {
        clean[k as keyof HarvesterLiveConfig] = val as never;
        overriddenKeys.push(k);
      } else if (val === 'true' || val === 'false') {
        clean[k as keyof HarvesterLiveConfig] = (val === 'true') as never;
        overriddenKeys.push(k);
      } else {
        errors.push(`Valor inválido para "${k}": esperado boolean, recebido ${typeof val}`);
      }
      continue;
    }

    if (NUMBER_KEYS.has(k)) {
      const num = Number(val);
      if (!Number.isFinite(num)) {
        errors.push(`Valor inválido para "${k}": esperado número finito, recebido ${val}`);
        continue;
      }

      let clamped = num;
      // Os clamps são duplicados do schema de propósito: eles definem os MESMOS
      // min/max dos campos acima. Valores nunca mudaram aqui — só a moradia.
      switch (k) {
        case 'harvestMaxPerHour':
          clamped = Math.max(1, Math.min(1000, Math.trunc(num)));
          break;
        case 'harvestIdleWindowMs':
          clamped = Math.max(0, Math.min(3600_000, Math.trunc(num)));
          break;
        case 'harvestIntervalMs':
          clamped = Math.max(1000, Math.min(600_000, Math.trunc(num)));
          break;
        case 'harvestQueueMax':
          clamped = Math.max(10, Math.min(1000, Math.trunc(num)));
          break;
        case 'harvestDrainMaxWorks':
          clamped = Math.max(1, Math.min(50, Math.trunc(num)));
          break;
        case 'harvestIndexerDelayMs':
          clamped = Math.max(0, Math.min(10_000, Math.trunc(num)));
          break;
        case 'harvestEntryTtl':
          clamped = Math.max(3600, Math.min(2_592_000, Math.trunc(num)));
          break;
        case 'harvestBrMaxWaitMs':
          clamped = Math.max(0, Math.min(172_800_000, Math.trunc(num)));
          break;
        case 'seedMaxPerCycle':
          clamped = Math.max(1, Math.min(100, Math.trunc(num)));
          break;
        case 'seedMinVotes':
          clamped = Math.max(0, Math.min(100_000, Math.trunc(num)));
          break;
        case 'seedIntervalH':
          clamped = Math.max(1, Math.min(168, Math.trunc(num)));
          break;
      }
      clean[k as keyof HarvesterLiveConfig] = clamped as never;
      overriddenKeys.push(k);
    }
  }

  return { clean, errors, overriddenKeys };
}
