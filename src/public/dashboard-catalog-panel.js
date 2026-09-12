/* Adom Power-Movie — /dashboard: relatório de catálogo no load/poll (Fase 3.4
 * do redesign). O /dashboard-status.json já carrega `catalog` = { ok, report }
 * em TODA resposta (catalogStatusEnv), mas a tela só pintava o relatório depois
 * de um POST manual em catalog-report — o número calculado a cada poll era
 * jogado fora. Este módulo popula #catalog_report a partir do payload, sem
 * disparar POST nenhum. Escopo global (sem IIFE). Depois de dashboard-catalog.js
 * — o renderCatalogReport dele é consumido por hook (Fase 1 do saneamento):
 * registro ausente mantém a seção intacta, como a guarda antiga. ES5 puro
 * (Fire TV / smart TV). */
"use strict";

  function renderCatalogPanel(root) {
    var catalog;
    // Sem a chave no payload (cache/rota antiga) não sobrescreve o estado
    // inicial: a seção continua com o convite a rodar a varredura.
    if (!isObject(root) || !own(root, "catalog")) return;
    // Fase 1 do saneamento: a dependência interna obrigatória no
    // renderCatalogReport (dashboard-catalog.js) é o registro no DashHooks —
    // has() mantém o early-return da guarda antiga sem citar o global.
    if (!DashHooks.has("renderCatalogReport")) return;
    catalog = root.catalog;
    if (!isObject(catalog)) return;
    // Relatório presente OU indisponibilidade explicada (ok:false + reason/
    // hint); qualquer outro shape não é um catálogo e não deve apagar a seção.
    if (!own(catalog, "report") && catalog.ok !== false) return;
    DashHooks.call("renderCatalogReport", catalog);
  }

  // Fase 1 do saneamento — registro declarativo no DashHooks (única execução
  // no load deste módulo): o renderGeralPanels (dashboard-status.js) consome o
  // painel por DashHooks.call, sem citar o símbolo global deste arquivo.
  DashHooks.register("renderCatalogPanel", renderCatalogPanel);
