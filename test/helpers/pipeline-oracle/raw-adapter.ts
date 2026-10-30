/**
 * Adaptador CRU do registry, sem a ponte nativa (8710). O oráculo reproduz o
 * corpo TS dos adaptadores; `debrid.current()` agora sempre embrulha o adaptador
 * na ponte (`rust-remote.ts`), então aqui se monta o mesmo objeto que o registry
 * entregava antes do embrulho.
 *
 * Precedência: o método do `BY_ID` (mutável, os testes trocam métodos) GANHA
 * quando existe; o corpo de `debrid-bodies/` só entra onde o `BY_ID` não tem o
 * método (o `checkCached`/`resolveLink` tirados de `src/`). Assim um mock feito
 * no `BY_ID` continua sendo o que o oráculo usa, e não há cópia de corpo
 * sobrescrevendo o teste. O clone do Real-Debrid mantém o `cacheCheck` dinâmico.
 * Mantenha as regras em dia com `current()` em `src/debrid/registry.ts`.
 */
import { opts } from '../../../src/runtime.js';
import config from '../../../src/config.js';
import * as rdOracle from '../../../src/debrid/rd-oracle.js';
import { BY_ID } from '../../../src/debrid/registry.js';
import type { DebridAdapter } from '../../../types/domain.js';
import { bodiesFor } from './debrid-bodies/index.js';

/** Adaptador cru com `checkCached` garantido (o oráculo não chama sem ele). */
export type CheckableAdapter = DebridAdapter & Required<Pick<DebridAdapter, 'checkCached'>>;

export function rawAdapter(): CheckableAdapter | null {
  const { debridService, debridApiKey } = opts();
  if (!debridService || !debridApiKey) return null;
  const adapter = BY_ID.get(debridService);
  if (!adapter) return null;
  const merged: DebridAdapter = { ...bodiesFor(adapter.id), ...adapter };
  const raw = adapter.id === 'realdebrid'
    ? { ...merged, cacheCheck: config.debrid.rdLedger.enabled && rdOracle.available(debridApiKey) }
    : merged;
  return checkable(raw);
}

/** Sem `checkCached` não há o que o oráculo chame: devolve null, como adaptador ausente. */
function checkable(raw: DebridAdapter): CheckableAdapter | null {
  return typeof raw.checkCached === 'function' ? { ...raw, checkCached: raw.checkCached } : null;
}
