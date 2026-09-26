// Config ao vivo do CRAWLER (Fase 4 do plano "Raspagem total"): estado
// (overrides em memória) + persistência no SQLite sob `cfg:v1:crawler`, com
// cópia em memória para leitura sem rede. Molde exato do `harvester-live.ts` —
// o contrato (tipos, schema e clamps) mora em `crawler-live-schema.ts`.
//
// O motor (crawler.ts) lê `effective()` para TODO knob que decide o ciclo
// (habilitado, dry-run, ritmo, teto, freio, tentativas, streaks, intervalo
// incremental) e registra `onConfigChange` para rearmar o timer sem restart.
// A pausa manual fica no motor (volátil por desenho); este módulo persiste só
// os knobs — ver o cabeçalho do schema.
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import * as log from './logger.js';
import {
  envDefaults,
  sanitizePatch,
  schema,
  type CrawlerEffectiveConfig,
  type CrawlerLiveConfig,
  type CrawlerSchemaField,
} from './crawler-live-schema.js';

export { schema } from './crawler-live-schema.js';
export type { CrawlerLiveConfig, CrawlerEffectiveConfig, CrawlerSchemaField } from './crawler-live-schema.js';

const CONFIG_KEY = `${prefix('cfg')}crawler`;
const INFINITE_TTL = 315_360_000; // 10 anos em segundos

let inMemoryOverrides: Partial<CrawlerLiveConfig> = {};
let isInitialized = false;
// Listener opcional (o crawler registra em start): live NÃO importa crawler —
// evita ciclo. Dispara após set/reset bem-sucedidos para o timer acompanhar
// `enabled`/`delayMs` sem restart do processo.
type ConfigChangeListener = () => void;
let configChangeListener: ConfigChangeListener | null = null;

/** Registra (ou limpa com null) o callback de mudança de config ao vivo. */
export function onConfigChange(listener: ConfigChangeListener | null): void {
  configChangeListener = listener;
}

function notifyConfigChange(): void {
  if (!configChangeListener) return;
  try {
    configChangeListener();
  } catch (err: unknown) {
    log.warn('[crawl-live] onConfigChange falhou:', log.errorMessage(err));
  }
}

function initIfNeeded(): void {
  if (isInitialized) return;
  isInitialized = true;
  try {
    const raw = cache.get(CONFIG_KEY);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const sanitized = sanitizePatch(raw);
      inMemoryOverrides = sanitized.clean;
      log.info(`[crawl-live] overrides carregados do disco: ${Object.keys(inMemoryOverrides).length} chave(s)`);
    }
  } catch (err: unknown) {
    log.warn('[crawl-live] falha ao carregar overrides do cache:', log.errorMessage(err));
  }
}

/** Snapshot COERENTE: defaults do `.env` + overrides persistidos, numa leitura
 * só. O motor captura isto uma vez por tick e o repassa adiante para que uma
 * mudança no meio do ciclo não produza estado misto. */
export function effective(): CrawlerEffectiveConfig {
  initIfNeeded();
  return { ...envDefaults(), ...inMemoryOverrides };
}

export function set(patch: Record<string, unknown>): {
  ok: boolean;
  effective: CrawlerEffectiveConfig;
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
    (inMemoryOverrides as Record<string, unknown>)[k] = v;
  }

  persist();
  notifyConfigChange();
  return { ok: true, effective: effective(), overriddenKeys: Object.keys(inMemoryOverrides) };
}

export function reset(): CrawlerEffectiveConfig {
  initIfNeeded();
  inMemoryOverrides = {};
  try {
    cache.forget(CONFIG_KEY);
    log.info('[crawl-live] todos os overrides foram restaurados para os padrões do .env');
  } catch (err: unknown) {
    log.warn('[crawl-live] falha ao limpar overrides do cache:', log.errorMessage(err));
  }
  const eff = effective();
  notifyConfigChange();
  return eff;
}

function persist(): void {
  try {
    if (Object.keys(inMemoryOverrides).length === 0) {
      cache.forget(CONFIG_KEY);
    } else {
      cache.set(CONFIG_KEY, inMemoryOverrides, INFINITE_TTL);
    }
  } catch (err: unknown) {
    log.warn('[crawl-live] erro ao persistir overrides no cache:', log.errorMessage(err));
  }
}

export interface CrawlerConfigSnapshot {
  effective: CrawlerEffectiveConfig;
  envDefaults: CrawlerLiveConfig;
  overriddenKeys: string[];
  schema: CrawlerSchemaField[];
}

export function snapshot(): CrawlerConfigSnapshot {
  initIfNeeded();
  return {
    effective: effective(),
    envDefaults: envDefaults(),
    overriddenKeys: Object.keys(inMemoryOverrides),
    schema: schema(),
  };
}

/** Teste: esquece overrides e estado de inicialização (cada caso começa limpo). */
export function _resetForTest(): void {
  inMemoryOverrides = {};
  isInitialized = false;
  configChangeListener = null;
  try { cache.forget(CONFIG_KEY); } catch { /* sem cache em teste */ }
}

export default {
  effective,
  set,
  reset,
  onConfigChange,
  schema,
  snapshot,
};
