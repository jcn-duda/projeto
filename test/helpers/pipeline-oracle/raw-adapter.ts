/**
 * Adaptador CRU do registry, sem a ponte nativa (8710). O oráculo reproduz o
 * corpo TS dos adaptadores; `debrid.current()` agora sempre embrulha o adaptador
 * na ponte (`rust-remote.ts`), então aqui se monta o mesmo objeto que o registry
 * entregava antes do embrulho: o `BY_ID` (mutável, os testes trocam métodos) e o
 * clone do Real-Debrid com `cacheCheck` dinâmico. Mantenha as duas regras em dia
 * com `current()` em `src/debrid/registry.ts`.
 */
import { opts } from '../../../src/runtime.js';
import config from '../../../src/config.js';
import * as rdOracle from '../../../src/debrid/rd-oracle.js';
import { BY_ID } from '../../../src/debrid/registry.js';
import type { DebridAdapter } from '../../../types/domain.js';

export function rawAdapter(): DebridAdapter | null {
  const { debridService, debridApiKey } = opts();
  if (!debridService || !debridApiKey) return null;
  const adapter = BY_ID.get(debridService);
  if (!adapter) return null;
  if (adapter.id === 'realdebrid') {
    return { ...adapter, cacheCheck: config.debrid.rdLedger.enabled && rdOracle.available(debridApiKey) };
  }
  return adapter;
}
