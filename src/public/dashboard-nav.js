/* Adom Power-Movie — /dashboard: navegação por abas (Fase 0 redesign).
 * Extraído de dashboard-panels.js: switchTab passou a ser dirigido por TABELA —
 * uma entrada por aba, sem a escada de if/else que crescia a cada aba nova
 * (e que já tinha um ramo por aba repetindo as classes das outras três).
 * Hash/autofetch/colhedor/trace preservados: #hash liga a aba e a aba escreve
 * o hash de volta. Escopo global compartilhado (sem IIFE). Antes do boot.
 * ES5 puro (Fire TV / smart TV). */
"use strict";

  // Tabela única de abas: nome lógico, id do botão, id da view e hash da URL.
  // A ordem define o fallback: "geral" é a primeira e a aba default.
  var TAB_ITEMS = [
    { name: "geral", tabId: "tabGeral", viewId: "viewGeral", hash: "#geral" },
    { name: "autofetch", tabId: "tabAutofetch", viewId: "viewAutofetch", hash: "#autofetch" },
    { name: "colhedor", tabId: "tabColhedor", viewId: "viewColhedor", hash: "#colhedor" },
    { name: "trace", tabId: "tabTrace", viewId: "viewTrace", hash: "#trace" }
  ];

  function tabByName(name) {
    var i;
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      if (TAB_ITEMS[i].name === name) return TAB_ITEMS[i];
    }
    return null;
  }

  function switchTab(name) {
    var active = tabByName(name) || TAB_ITEMS[0];
    var i;
    var entry;
    var isDefault = active === TAB_ITEMS[0];
    // Guarda intacta do comportamento antigo: só comuta com os oito elementos
    // presentes (o painel pode estar truncado em teste/embed).
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      if (!$(TAB_ITEMS[i].tabId) || !$(TAB_ITEMS[i].viewId)) return;
    }
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      entry = TAB_ITEMS[i];
      var isActive = entry === active;
      $(entry.tabId).className = "tab-btn" + (isActive ? " active" : "");
      $(entry.tabId).setAttribute("aria-selected", isActive ? "true" : "false");
      $(entry.viewId).className = "tab-view" + (isActive ? "" : " hidden");
    }
    // Comportamento preservado: a aba default só REESCREVE o hash quando ele
    // aponta para outra aba conhecida — um #ancora qualquer na Geral não é
    // sobrescrito; as demais abas sempre refletem a própria hash.
    if (!isDefault) {
      if (window.location.hash !== active.hash) window.location.hash = active.hash;
    } else {
      var known = [];
      for (i = 0; i < TAB_ITEMS.length; i += 1) {
        if (TAB_ITEMS[i] !== TAB_ITEMS[0]) known.push(TAB_ITEMS[i].hash);
      }
      if (known.indexOf(window.location.hash) !== -1) window.location.hash = TAB_ITEMS[0].hash;
    }
  }

  function handleHash() {
    var hash = String(window.location.hash || "").replace(/^#/, "");
    var entry = tabByName(hash);
    // Hash desconhecido ou vazio cai na aba default (geral), como antes.
    switchTab(entry ? entry.name : TAB_ITEMS[0].name);
  }
