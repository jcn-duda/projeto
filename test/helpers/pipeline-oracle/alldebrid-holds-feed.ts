/**
 * Régua TS do feed de holds da AllDebrid (antigo `POST /internal/debrid/holds`).
 *
 * A rota Node saiu: o gateway calcula estes fatos sozinho (`al_cleanup_facts`).
 * Este módulo fica só no oráculo de teste para conferir a MESMA auditoria do
 * lado TS: a conta (`account`, `accountScope` da chave) e os hashes avaliados
 * (`evaluated`), além dos fatos de `alldebridCleanupFacts`. Sem chave, nada é
 * provado: `account` vazio e `evaluated` vazio.
 */
import { accountScope } from '../../../src/utils/request-key.js';
import { id as alldebridId } from '../../../src/debrid/alldebrid-api.js';
import { heldHashesFor } from '../../../src/debrid/protected.js';
import { alldebridCleanupFacts } from '../../../src/debrid/alldebrid-cleanup-facts.js';
import { assertSafeTestDb } from '../db-guard.js';

// Os fatos leem o inventário e a posse no KV nativo: sem setup-env o destino
// seria o `data/cache.db` do repositório.
assertSafeTestDb('alldebrid-holds-feed');

/** Fatos do feed: os da limpeza + identidade da conta + lote avaliado. */
export interface HoldsFeedFacts extends ReturnType<typeof alldebridCleanupFacts> {
  /** `accountScope(apiKey)` (`sha256` hex) — nunca a chave. */
  account: string;
  /** Hashes do lote avaliados por `isHeld || isDurablyProtected`. */
  evaluated: string[];
}

export function alldebridHoldsFeedFacts(apiKey: string, hashes: readonly string[]): HoldsFeedFacts {
  const facts = alldebridCleanupFacts(apiKey, hashes);
  if (!apiKey) return { ...facts, account: '', evaluated: [] };
  const account = accountScope(apiKey);
  return { ...facts, account, evaluated: heldHashesFor(hashes, account, alldebridId).evaluated };
}
