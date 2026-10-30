// Retrato do gate de ocupação da conta para o painel. O corpo TS do gate
// (decisão, memo e refresh) saiu de `src/`: em produção ninguém o chama, e o
// oráculo congelado mora em test/helpers/pipeline-oracle/autofetch-account-gate.ts.
import autofetchLive from '../utils/autofetch-live.js';

type AccountGateEntry = { id: string; count: number; max: number; at: number; source: string; blocked: boolean };

/**
 * O gate de ocupação da conta é do worker nativo do Chupim (os números dele
 * saem pela admin 8711). Este retrato fica VAZIO por contrato: sem memo em
 * produção não há conta medida, e "naomedido" declara isso em vez de pintar
 * saúde. Só `pauseAt` vem da config viva.
 */
function accountGateSnapshot(): {
  pauseAt: number;
  blocked: boolean;
  accounts: AccountGateEntry[];
  inFlight: number;
  _origem: { accounts: 'naomedido' | 'amostra' };
} {
  return {
    pauseAt: autofetchLive.effective().autoFetchPauseAt,
    blocked: false,
    accounts: [],
    inFlight: 0,
    _origem: { accounts: 'naomedido' },
  };
}

export { accountGateSnapshot };
