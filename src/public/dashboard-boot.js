/* Adom Power-Movie — /dashboard: boot e wiring (Fase 1 painel).
 * Único módulo que RODA no load: bind() liga controles e dispara o 1º status.
 * Carrega por último, depois de core/panels/status/debrid-test/trace/
 * autofetch/harvest/catalog. Escopo global compartilhado (sem IIFE). ES5. */
"use strict";

function bind() {
  var savedToken = readStored(TOKEN_KEY);
  var savedRate = readStored(RATE_KEY);
  var actions = document.querySelectorAll(".action-button");
  var i;
  if (savedToken) { currentToken = String(savedToken).replace(/\s+/g, ""); $("token").value = currentToken; }
  if (savedRate === "5" || savedRate === "10" || savedRate === "30" || savedRate === "off") $("refreshRate").value = savedRate;
  $("saveToken").addEventListener("click", saveToken);
  $("refreshButton").addEventListener("click", loadStatus);
  $("refreshRate").addEventListener("change", scheduleRefresh);
  $("token").addEventListener("keydown", function (event) { if (event.key === "Enter") saveToken(); });
  $("testIndexerButton").addEventListener("click", function () { runIndexerTest($("testIndexerId").value, $("testIndexerButton")); });
  fillDebridTestServices();
  $("debridTestButton").addEventListener("click", function () { runDebridAccountTest($("debridTestButton")); });
  $("debridTestKey").addEventListener("keydown", function (event) { if (event.key === "Enter") runDebridAccountTest($("debridTestButton")); });
  $("cacheNamespace").addEventListener("change", updateCacheScopeAvailability);
  for (i = 0; i < actions.length; i += 1) actions[i].addEventListener("click", function () { runAction(this); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      return;
    }
    loadStatus();
    scheduleRefresh();
  });
  $("tabGeral").addEventListener("click", function () { switchTab("geral"); });
  $("tabAutofetch").addEventListener("click", function () { switchTab("autofetch"); });
  $("tabColhedor").addEventListener("click", function () { switchTab("colhedor"); });
  $("tabTrace").addEventListener("click", function () { switchTab("trace"); });
  $("traceQueryBtn").addEventListener("click", function () { runTraceQuery($("traceQueryBtn")); });
  $("traceLiveBtn").addEventListener("click", function () { runTraceLive($("traceLiveBtn")); });
  $("harvestPauseToggleBtn").addEventListener("click", function () { toggleHarvesterPause(); });
  $("harvestBannerResumeBtn").addEventListener("click", function () { toggleHarvesterPause(false); });
  $("harvestDrainBtn").addEventListener("click", drainHarvesterQueue);
  $("harvestClearQueueBtn").addEventListener("click", clearHarvesterQueue);
  $("harvestSaveBtn").addEventListener("click", saveHarvesterConfig);
  $("harvestResetBtn").addEventListener("click", resetHarvesterConfig);
  $("harvestPresetPadrao").addEventListener("click", function () { applyHarvesterPreset("padrao"); });
  $("harvestPresetAcelerado").addEventListener("click", function () { applyHarvesterPreset("acelerado"); });
  $("harvestPresetSilencioso").addEventListener("click", function () { applyHarvesterPreset("silencioso"); });
  $("afPauseToggleBtn").addEventListener("click", function () { toggleAutofetchPause(); });
  $("afBannerResumeBtn").addEventListener("click", function () { toggleAutofetchPause(false); });
  $("afDrainBtn").addEventListener("click", drainAutofetchQueues);
  $("afSaveBtn").addEventListener("click", saveAutofetchConfig);
  $("afResetBtn").addEventListener("click", resetAutofetchConfig);
  $("afPresetConservador").addEventListener("click", function () { applyAutofetchPreset("conservador"); });
  $("afPresetAgressivo").addEventListener("click", function () { applyAutofetchPreset("agressivo"); });
  $("afPresetSwarm").addEventListener("click", function () { applyAutofetchPreset("swarm"); });
  $("catalogScanBtn").addEventListener("click", runCatalogScan);
  $("catalogReportBtn").addEventListener("click", runCatalogReport);
  $("catalogAuditBtn").addEventListener("click", runCatalogAudit);
  $("catalogRequeueBtn").addEventListener("click", runCatalogRequeue);
  $("catalogListBtn").addEventListener("click", runCatalogList);
  $("catalogSelectAllBtn").addEventListener("click", toggleCatalogSelectAll);
  $("catalog_manual").addEventListener("change", refreshCatalogSelection);
  $("catalogManualDeleteBtn").addEventListener("click", runCatalogManualDelete);
  $("catalogDedupPreviewBtn").addEventListener("click", runCatalogDedupPreview);
  $("catalogDedupApplyBtn").addEventListener("click", runCatalogDedupApply);
  $("catalogCleanupPreviewBtn").addEventListener("click", runCatalogCleanupPreview);
  $("catalogCleanupApplyBtn").addEventListener("click", runCatalogCleanupApply);
  window.addEventListener("hashchange", handleHash);
  handleHash();

  lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
  scheduleRefresh();
  loadStatus();
}

bind();
