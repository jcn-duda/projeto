import config from '../config.js';
import * as held from '../debrid/protected.js';
import { accountScope } from '../utils/request-key.js';
import { forgetLotProgress } from './autofetch-progress.js';
import type { RuntimeContext } from '../runtime.js';

// LRU dos lotes em estabilização (settle), extraído de `autofetch-recheck.ts`
// para respeitar o teto de linhas. Quando o número de lotes em settle passa de
// `autoFetchSettleMaxLots`, evicta os mais antigos: limpa o timer e libera os
// holds — sem isso o lote settleado ocuparia vaga e hold até o TTL.
//
// Tipo mínimo e estrutural: o módulo não conhece `RecheckLot` inteiro (importar
// o tipo de lá criaria ciclo), só os campos que usa.
type SettleLot = {
  isSettle: boolean;
  createdAt?: number;
  timer: ReturnType<typeof setTimeout> | null;
  ctx: RuntimeContext | null;
  hashes: Set<string>;
  /**
   * Adapter DONO do lote, gravado no enqueue/recheck. A evicção usa ESTE id —
   * nunca `debrid.current()`, que no contexto de outra request pode ser outro
   * serviço: num lote misto, limpar com o adapter errado deixaria a memória de
   * progresso do lote evictado para trás. Vazio = limpeza impossível (não
   * inventa chave).
   */
  adapterId: string;
};

export function manageSettleLru(lots: Map<string, SettleLot>): void {
  const settleLots: Array<{ key: string; createdAt: number; lot: SettleLot }> = [];
  for (const [key, lot] of lots) {
    if (lot.isSettle) settleLots.push({ key, createdAt: lot.createdAt || 0, lot });
  }
  const maxLots = config.debrid.autoFetchSettleMaxLots;
  if (settleLots.length <= maxLots) return;
  settleLots.sort((a, b) => a.createdAt - b.createdAt);
  for (const { key, lot } of settleLots.slice(0, settleLots.length - maxLots)) {
    if (lot.timer) clearTimeout(lot.timer);
    const account = accountScope(lot.ctx?.opts?.debridApiKey || '');
    // Fim de lote também é fim da memória de progresso: limpa com o adapter do
    // PRÓPRIO lote, ANTES do delete, para um hash reenfileirado não herdar
    // streak residual de outra janela.
    for (const h of lot.hashes) held.release(h, account);
    if (lot.adapterId) forgetLotProgress(lot.adapterId, account, lot.hashes);
    lots.delete(key);
  }
}
