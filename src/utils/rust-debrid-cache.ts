/**
 * Veredito de cache do debrid em Rust (`debridCacheVerdict`): a partir da
 * resposta que o Node já obteve (conjunto/registro de hashes, completude ou o
 * motivo da falha), o Rust decide `cached`, `known` e `unusable`. Não há
 * segunda chamada de API; métrica, log e aviso de conta inutilizável ficam no
 * Node (`cache-check.ts`). O TS da regra saiu do branch (oráculo no `esm`).
 */
import { requireCore } from './rust-core.js';
import * as metrics from './metrics.js';

export type CacheVerdictShape = {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string; message: string };
};

/** O que o Node sabe da resposta do serviço. */
export type CacheProbe = {
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
  debridCacheVerdict(
    form: string,
    cached: string[],
    complete: boolean | null,
    failure: string | null,
    message: string,
  ): CacheVerdictNapi;
};

function cacheVerdict(probe: CacheProbe): CacheVerdictShape {
  metrics.count('rust.debrid.cache.calls');
  const core = requireCore() as unknown as CacheCore;
  const raw = core.debridCacheVerdict(probe.form, probe.cached, probe.complete, probe.failure, probe.message);
  if (!raw || !Array.isArray(raw.cached) || typeof raw.known !== 'boolean') {
    throw new Error('veredito de cache do Rust veio quebrado');
  }
  const verdict: CacheVerdictShape = { cached: new Set(raw.cached.map((hash) => String(hash))), known: raw.known };
  if (raw.reason) verdict.unusable = { reason: String(raw.reason), message: String(raw.message || '') };
  return verdict;
}

export { cacheVerdict };
