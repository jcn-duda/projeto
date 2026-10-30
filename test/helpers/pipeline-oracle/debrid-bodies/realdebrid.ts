/**
 * Corpo TS do `checkCached` do Real-Debrid, tirado de `src/debrid/realdebrid.ts`.
 * Produção não roda isto: a checagem é a ponte nativa (`wrap` em
 * `rust-remote.ts`). Só o oráculo de paridade chama, via `rawAdapter()`.
 */
import * as rdLedger from '../../../../src/debrid/rd-ledger.js';

/**
 * O Real-Debrid aposentou o /torrents/instantAvailability: não há mais como
 * perguntar em lote o que está em cache. Devolvemos vazio e o orquestrador
 * trata todos como "não sei" — ver `cacheCheck` em `realdebrid-core.ts`.
 */
async function checkCached(_apiKey: string, hashes: string[]) {
  // O endpoint oficial aposentou a disponibilidade em lote. Quando o oráculo
  // está ativo, ele já gravou no ledger antes desta chamada; só afirmamos
  // complete se TODO hash possui evidência (hit/miss/blocked), nunca por falta.
  const cached = new Set<string>();
  let known = true;
  for (const raw of hashes) {
    const hash = String(raw || '').toLowerCase();
    const state = rdLedger.peek(hash);
    if (state === 'hit') cached.add(hash);
    else if (state === 'unknown') known = false;
  }
  return { cached, complete: known };
}
export const bodies = { checkCached };
