/* Adom Power-Movie — /dashboard: estado compartilhado entre módulos (Fase 2
 * do saneamento). Único dono do estado mutável que antes vivia espalhado em
 * `var` de topo (core/status): token do diagnóstico, timers do ciclo de
 * polling, requisição em voo, falhas consecutivas, última medição OK e o
 * último payload do /dashboard-status.json. Os módulos leem e escrevem
 * PROPRIEDADES deste objeto — reatribuir o binding importado quebraria os
 * outros módulos em silêncio — e nenhum módulo declara essas variáveis de
 * novo. Nada roda no load; carrega ANTES do core (consumidor). Escopo global
 * (sem IIFE). ES5 puro (Fire TV / smart TV). */
"use strict";

var DashState = {
  token: "",               // token de diagnóstico corrente (campos #token/#emptyToken)
  refreshTimer: null,      // id do setTimeout do polling (scheduleRefresh/status)
  lastUpdatedTimer: null,  // id do setInterval do "Atualizado há Ns" (boot)
  requestInFlight: false,  // true enquanto a consulta do status não volta
  consecutiveFailures: 0,  // falhas seguidas: dobra o intervalo do polling
  lastOkAt: 0,             // Date.now() da última resposta renderizada
  lastStatusRoot: null     // último payload completo (render tardio da aba)
};
