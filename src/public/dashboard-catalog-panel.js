/* Adom Power-Movie — /dashboard: relatório de catálogo no load/poll (Fase 3.4
 * do redesign). O /dashboard-status.json já carrega `catalog` = { ok, report }
 * em TODA resposta (catalogStatusEnv), mas a tela só pintava o relatório depois
 * de um POST manual em catalog-report — o número calculado a cada poll era
 * jogado fora. Este módulo popula #catalog_report a partir do payload, sem
 * disparar POST nenhum. Escopo global (sem IIFE), declaração pura — nada roda
 * no load. Depois de dashboard-catalog.js (usa o renderCatalogReport dele).
 * ES5 puro (Fire TV / smart TV). */
"use strict";

  function renderCatalogPanel(root) {
    var catalog;
    // Sem a chave no payload (cache/rota antiga) não sobrescreve o estado
    // inicial: a seção continua com o convite a rodar a varredura.
    if (!isObject(root) || !own(root, "catalog")) return;
    if (typeof renderCatalogReport !== "function") return;
    catalog = root.catalog;
    if (!isObject(catalog)) return;
    // Relatório presente OU indisponibilidade explicada (ok:false + reason/
    // hint); qualquer outro shape não é um catálogo e não deve apagar a seção.
    if (!own(catalog, "report") && catalog.ok !== false) return;
    renderCatalogReport(catalog);
  }
