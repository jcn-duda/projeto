/**
 * Decisão "este hash pode sair da conta?", em Rust (`debridMayDelete`). O Node
 * executa o apagamento; inventário ausente, hold e knownBefore entram como
 * fatos e fecham o fail-safe na regra do núcleo. O TS da regra saiu do branch
 * (oráculo no `esm`).
 */
import { requireCore } from './rust-core.js';
import * as metrics from './metrics.js';

export type DeleteFacts = {
  inventoryLoaded: boolean;
  knownBefore: boolean;
  protected: boolean;
};

type CleanCore = {
  debridMayDelete(inventoryLoaded: boolean, knownBefore: boolean, protectedHash: boolean): boolean;
};

function mayDeleteHash(facts: DeleteFacts): boolean {
  metrics.count('rust.debrid.clean.calls');
  const core = requireCore() as unknown as CleanCore;
  // Só `true` autoriza: qualquer outra resposta mantém o hash na conta.
  return core.debridMayDelete(facts.inventoryLoaded, facts.knownBefore, facts.protected) === true;
}

export { mayDeleteHash };
export type { CleanCore };
