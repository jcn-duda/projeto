/**
 * Sombra do veredito de cache (`RUST_DEBRID_CACHE`). O Node já tem a resposta
 * do serviço; o Rust só classifica de novo. Não há segunda chamada de API,
 * nem dropUncached, nem escrita no magnetdb.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

export type CacheVerdictShape = {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string; message: string };
};

export type CacheShadowProbe = {
  form: 'set' | 'object';
  cached: string[];
  complete: boolean | null;
  failure: string | null;
  message: string;
};

export type CacheVerdictNapi = {
  cached: string[];
  known: boolean;
  reason?: string | null;
  message?: string | null;
};

export type CacheCore = {
  debridCacheVerdict?(
    form: string,
    cached: string[],
    complete: boolean | null,
    failure: string | null,
    message: string,
  ): CacheVerdictNapi;
  debridCacheCheckHonest?(service: string): boolean;
};

type GetCore = () => CacheCore | null;

let getCore: GetCore | null = null;
let loggedDiffs = 0;
let loggedMissing = false;

function noteMissing() {
  if (loggedMissing) return;
  loggedMissing = true;
  log.info('[rust] núcleo sem debridCacheVerdict (binário antigo); sombra de cache desligada');
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameVerdict(ts: CacheVerdictShape, rust: CacheVerdictNapi): boolean {
  const cached = [...ts.cached];
  const reason = ts.unusable?.reason ?? null;
  const message = ts.unusable?.message ?? null;
  return sameList(cached, rust.cached || [])
    && ts.known === rust.known
    && reason === (rust.reason ?? null)
    && message === (rust.message ?? null);
}

function materialize(raw: CacheVerdictNapi): CacheVerdictShape {
  if (!raw || !Array.isArray(raw.cached) || typeof raw.known !== 'boolean') {
    throw new Error('veredito de cache do Rust veio quebrado');
  }
  const verdict: CacheVerdictShape = { cached: new Set(raw.cached.map((hash) => String(hash))), known: raw.known };
  if (raw.reason) verdict.unusable = { reason: String(raw.reason), message: String(raw.message || '') };
  return verdict;
}

function logDiff(probe: CacheShadowProbe, ts: CacheVerdictShape, rust: CacheVerdictNapi) {
  metrics.count('rust.debrid.cache.diff');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(
    `[rust] cache divergiu: form=${probe.form} failure=${probe.failure ?? '-'} `
    + `tsKnown=${ts.known} rustKnown=${rust.known} hashes=${probe.cached.length}`,
  );
}

/** Compara o veredito. Em shadow a resposta continua sendo a do TS. */
function shadowCacheVerdict<T extends CacheVerdictShape>(probe: CacheShadowProbe, ts: T): T {
  const mode = config.rustDebrid.cache;
  if (mode === 'off' || !getCore) return ts;
  const fn = getCore()?.debridCacheVerdict;
  if (typeof fn !== 'function') {
    noteMissing();
    return ts;
  }
  metrics.count('rust.debrid.cache.calls');
  let rust: CacheVerdictNapi;
  try {
    rust = fn(probe.form, probe.cached, probe.complete, probe.failure, probe.message);
  } catch (err) {
    metrics.count('rust.debrid.cache.error');
    log.debug('[rust] cache lançou:', log.errorMessage(err));
    return ts;
  }
  if (!rust || !Array.isArray(rust.cached)) {
    metrics.count('rust.debrid.cache.error');
    return ts;
  }
  if (mode === 'shadow') {
    if (!sameVerdict(ts, rust)) logDiff(probe, ts, rust);
    return ts;
  }
  try {
    return materialize(rust) as T;
  } catch (err) {
    metrics.count('rust.debrid.cache.error');
    log.debug('[rust] cache lançou; usando TS:', log.errorMessage(err));
    return ts;
  }
}

/** O flag `cacheCheck` do adaptador, só para métrica. Não troca o valor do TS. */
function noteDebridCacheHonest(service: string, actual: boolean) {
  if (config.rustDebrid.cache === 'off' || !getCore) return;
  const fn = getCore()?.debridCacheCheckHonest;
  if (typeof fn !== 'function') return;
  try {
    if (fn(service) !== actual) {
      metrics.count('rust.debrid.cache.flag.diff');
      log.warn(`[rust] cacheCheck divergiu: serviço=${service} ts=${actual}`);
    }
  } catch (err) {
    metrics.count('rust.debrid.cache.error');
    log.debug('[rust] cacheCheck lançou:', log.errorMessage(err));
  }
}

function installDebridCacheHook(get: GetCore) {
  getCore = get;
}

function resetDebridCacheHook() {
  getCore = null;
  loggedDiffs = 0;
  loggedMissing = false;
}

export { shadowCacheVerdict, noteDebridCacheHonest, installDebridCacheHook, resetDebridCacheHook };
