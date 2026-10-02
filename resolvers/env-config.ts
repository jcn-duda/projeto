// Montagem da configuração explícita dos profiles a partir do ambiente do
// processo. O topo dos profiles/hub/selector/parsers NÃO lê process.env: a
// leitura acontece AQUI, por chamada, quando o ponto de entrada (shim
// standalone ou src/br-resolvers.ts) constrói uma instância. Sem isso, os seis
// resolvers no MESMO processo do addon herdavam a PORT=7000 e o SITE_URL de um
// para o outro, e o carregador precisava mutar/restaurar o ambiente e
// invalidar require.cache para cada require.
//
// Só knobs de OPERADOR passam por aqui. O que é constante do perfil (lista de
// mirrors, concurrency, formato de unwrap, modo de decodificação) mora no
// DEFAULTS do próprio profile e nunca veio de env.
import { normalizeHostSuffixes } from './protector.js';
import type { ProfileDefaults, ResolverConfig, ResolverMeta } from './types.js';

/** Overrides explícitos do ponto de entrada (shim/embutido). */
export interface ProfileOverrides {
  port?: number;
  selfUrl?: string;
  siteUrl?: string;
  urlsCsv?: string;
  timeoutMs?: number;
  maxHops?: number;
  maxPosts?: number;
  postCacheMs?: number;
  searchCacheMs?: number;
  magnetCacheMs?: number;
  maxResolveAttempts?: number;
  extraProtectors?: string | string[];
}

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '') continue;
    return value;
  }
  return undefined;
}

function envNumber(name: string, fallback: number | null): number | null;
function envNumber(name: string, fallback: number | undefined): number | undefined;
function envNumber(name: string, fallback: number | null | undefined): number | null | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function trimUrl(value: unknown): string {
  return String(value || '').replace(/\/$/, '');
}

/**
 * @param meta        Metadados do profile (env do site, csv de candidatos, defaults).
 * @param overrides   Configuração explícita do chamador.
 */
function buildProfileConfig(meta: ResolverMeta, overrides: ProfileOverrides = {}): ResolverConfig {
  const defaults: ProfileDefaults = meta.defaults || {};
  const flare = defaults.flare || {};
  const siteEnvValue = meta.siteEnv ? process.env[meta.siteEnv] : undefined;
  const urlsEnvValue = meta.urlsEnv ? process.env[meta.urlsEnv] : undefined;

  return {
    // PORT do override vence o env do addon: no modo embutido cada resolver
    // recebe a própria porta em vez de herdar a 7000 do processo pai.
    port: firstDefined(overrides.port, envNumber('PORT', null), defaults.port),
    selfUrl: trimUrl(firstDefined(overrides.selfUrl, process.env.SELF_URL, defaults.selfUrl)),
    // SITE_URL é o override do modo embutido; depois vêm a env específica do
    // site e o default do perfil (mesma precedência histórica do site-profile).
    siteUrl: trimUrl(firstDefined(overrides.siteUrl, process.env.SITE_URL, siteEnvValue, defaults.siteUrl)),
    urlsCsv: firstDefined(overrides.urlsCsv, urlsEnvValue, defaults.urlsCsv),
    timeoutMs: firstDefined(overrides.timeoutMs, envNumber('TIMEOUT_MS', null), defaults.timeoutMs),
    maxHops: firstDefined(overrides.maxHops, defaults.maxHops),
    maxPosts: firstDefined(overrides.maxPosts, envNumber(meta.maxPostsEnv || 'MAX_POSTS', null), defaults.maxPosts),
    postCacheMs: firstDefined(overrides.postCacheMs, envNumber('POST_CACHE_MS', null), defaults.postCacheMs),
    searchCacheMs: firstDefined(overrides.searchCacheMs, envNumber('SEARCH_CACHE_MS', null), defaults.searchCacheMs),
    magnetCacheMs: firstDefined(overrides.magnetCacheMs, envNumber('MAGNET_CACHE_MS', null), defaults.magnetCacheMs),
    maxResolveAttempts: firstDefined(
      overrides.maxResolveAttempts,
      envNumber('MAX_RESOLVE_ATTEMPTS', null),
      defaults.maxResolveAttempts,
    ),
    // Canonicaliza AQUI o que pode vir cru de override (controls do addon) ou
    // da env: trim/minúsculas/dedupe. hasAllowedHost compara host minúsculo, e
    // um sufixo em caixa mista nunca casaria sem esta passagem.
    extraProtectors: normalizeHostSuffixes(
      overrides.extraProtectors !== undefined ? overrides.extraProtectors : process.env.EXTRA_ALLOWED_PROTECTORS,
    ),
    flare: {
      solverUrl: trimUrl(firstDefined(process.env.FLARE_SOLVERR_URL, flare.solverUrl)),
      timeoutMs: envNumber('FLARE_TIMEOUT_MS', flare.timeoutMs),
      sessionTtlMs: envNumber('FLARE_SESSION_TTL_MS', flare.sessionTtlMs),
    },
  };
}

export { buildProfileConfig, envNumber, trimUrl, firstDefined };
