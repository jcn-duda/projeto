// Orçamento horário do Chupim lido do KV nativo. Desde o corte do TS (B4) quem
// reserva a cota é o worker do gateway (`enqueue_gates.rs::reserve_budget`):
// os Maps do Node ficaram sem escritor de produção e o painel mostrava "0 / 0".
import { kvKeys, kvPeek } from '../utils/native-kv.js';

/** Prefixo do `BUDGET_PREFIX` do Rust; a chave termina no sha256 de `adapter:conta`. */
export const NATIVE_BUDGET_PREFIX = 'autofetch-worker:v1:budget:';
const HOUR_MS = 3600_000;

export type BudgetAccount = { id: string; used: number; limit: number };

/** Contas com reserva na última hora (a chave nativa vence 1 h após a última). */
export function nativeBudgetAccounts(limitPerAccount: number, now = Date.now()): BudgetAccount[] {
  const out: BudgetAccount[] = [];
  for (const key of kvKeys(NATIVE_BUDGET_PREFIX, now)) {
    const raw = kvPeek(key, now);
    const used = Array.isArray(raw)
      ? raw.filter((at) => typeof at === 'number' && at > now - HOUR_MS).length
      : 0;
    out.push({ id: key.slice(NATIVE_BUDGET_PREFIX.length, NATIVE_BUDGET_PREFIX.length + 12), used, limit: limitPerAccount });
  }
  return out;
}
