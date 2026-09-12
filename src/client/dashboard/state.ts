/* Adom Power-Movie — /dashboard: estado compartilhado entre módulos (C3, ESM).
 *
 * Objeto EXPORTADO e mutado por PROPRIEDADE — reatribuir o binding importado é
 * somente leitura em ESM e quebraria os outros módulos em silêncio. Único dono
 * do token do diagnóstico, dos timers do polling, da requisição em voo, das
 * falhas consecutivas, da última medição OK e do último payload completo do
 * /dashboard-status.json (render tardio da aba oculta).
 *
 * Nada aqui toca o DOM: o entry só chama o boot depois de montar o painel. */

export interface DashStateShape {
  token: string;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  lastUpdatedTimer: ReturnType<typeof setInterval> | null;
  requestInFlight: boolean;
  consecutiveFailures: number;
  lastOkAt: number;
  lastStatusRoot: any;
}

export const DashState: DashStateShape = {
  token: '',               // token de diagnóstico corrente (campos #token/#emptyToken)
  refreshTimer: null,      // id do setTimeout do polling (scheduleRefresh/status)
  lastUpdatedTimer: null,  // id do setInterval do "Atualizado há Ns" (boot)
  requestInFlight: false,  // true enquanto a consulta do status não volta
  consecutiveFailures: 0,  // falhas seguidas: dobra o intervalo do polling
  lastOkAt: 0,             // Date.now() da última resposta renderizada
  lastStatusRoot: null,    // último payload completo (render tardio da aba)
};

/** Restaura os padrões; usado pelos testes (o import do módulo é cacheado). */
export function resetDashState(): void {
  DashState.token = '';
  DashState.refreshTimer = null;
  DashState.lastUpdatedTimer = null;
  DashState.requestInFlight = false;
  DashState.consecutiveFailures = 0;
  DashState.lastOkAt = 0;
  DashState.lastStatusRoot = null;
}
