/* Adom Power-Movie — /dashboard: boot e wiring (C3, ESM nativo).
 * Único módulo (com o entry) que liga DOM; o entry registra os hooks antes de
 * chamar bind(). Importar este módulo NÃO executa wiring — só o entry chama
 * bind() depois de montar o painel e registrar os hooks. */

import { $, RATE_KEY, TOKEN_KEY, readStored } from './core.js';
import { DashState } from './state.js';
import { loadStatus, saveToken, scheduleRefresh, updateLastUpdated } from './status-root.js';
import { runAction, updateCacheScopeAvailability } from './status-actions.js';
import { activeTabName, bindSectionNav, bindSectionToggles, handleHash, initSectionToggles, markActiveSection, renderSectionNav, switchTab } from './nav.js';
import { bindHealthPanel } from './health.js';
import { runIndexerTest } from './probes.js';
import { fillDebridTestServices, runDebridAccountTest } from './debrid-test.js';
import { fillHarvestDebridServices, resetHarvestDebrid, saveHarvestDebrid, testHarvestDebridKey, updateHarvestDebridCaps } from './harvest-debrid.js';
import { applyHarvesterPreset, clearHarvesterQueue, drainHarvesterQueue, resetHarvesterConfig, saveHarvesterConfig, toggleHarvesterPause } from './harvest-actions.js';
import { applyAutofetchPreset, drainAutofetchQueues, resetAutofetchConfig, saveAutofetchConfig, toggleAutofetchPause } from './autofetch-actions.js';
import { runCatalogAudit, runCatalogCleanupApply, runCatalogCleanupPreview, runCatalogDedupApply, runCatalogDedupPreview, runCatalogList, runCatalogManualDelete, runCatalogRequeue, runCatalogReport, runCatalogScan } from './catalog-actions.js';
import { refreshCatalogSelection, toggleCatalogSelectAll } from './catalog-render.js';
import { bindMagnetPanel } from './magnets.js';
import { runTraceLive, runTraceQuery } from './trace.js';

/* Foco acessível para WebView sem :focus-visible: Tab liga keyboard-nav (o anel
 * de foco do dashboard.css volta); ponteiro desliga — clique de mouse não deixa
 * contorno permanente. Navegador com :focus-visible resolve pela pseudo-classe e
 * a classe é redundante e inofensiva. */
function bindKeyboardFocus(): void {
  const root = document.documentElement;
  function enableKeyboardNav(event: any): void {
    if ((event.key !== undefined ? event.key : '') === 'Tab' || event.keyCode === 9) {
      if ((' ' + root.className + ' ').indexOf(' keyboard-nav ') === -1) root.className += ' keyboard-nav';
    }
  }
  function disableKeyboardNav(): void {
    root.className = String(root.className).replace(/(^|\s)keyboard-nav(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  }
  document.addEventListener('keydown', enableKeyboardNav);
  document.addEventListener('pointerdown', disableKeyboardNav);
  document.addEventListener('mousedown', disableKeyboardNav);
  document.addEventListener('touchstart', disableKeyboardNav);
}

export function bind(): void {
  bindKeyboardFocus();
  const savedToken = readStored(TOKEN_KEY);
  const savedRate = readStored(RATE_KEY);
  const actions = document.querySelectorAll('.action-button');
  if (savedToken) { DashState.token = String(savedToken).replace(/\s+/g, ''); $('token').value = DashState.token; }
  if (savedRate === '5' || savedRate === '10' || savedRate === '30' || savedRate === 'off') $('refreshRate').value = savedRate;
  $('saveToken').addEventListener('click', saveToken);
  $('refreshButton').addEventListener('click', loadStatus);
  $('refreshRate').addEventListener('change', scheduleRefresh);
  $('token').addEventListener('keydown', (event: any) => { if (event.key === 'Enter') saveToken(); });
  $('testIndexerButton').addEventListener('click', () => { runIndexerTest($('testIndexerId').value, $('testIndexerButton')); });
  fillDebridTestServices();
  $('debridTestButton').addEventListener('click', () => { runDebridAccountTest($('debridTestButton')); });
  $('debridTestKey').addEventListener('keydown', (event: any) => { if (event.key === 'Enter') runDebridAccountTest($('debridTestButton')); });
  fillHarvestDebridServices();
  updateHarvestDebridCaps();
  $('harvestDebridService').addEventListener('change', updateHarvestDebridCaps);
  $('harvestDebridTestBtn').addEventListener('click', () => { testHarvestDebridKey($('harvestDebridTestBtn')); });
  $('harvestDebridSaveBtn').addEventListener('click', () => { saveHarvestDebrid($('harvestDebridSaveBtn')); });
  $('harvestDebridResetBtn').addEventListener('click', () => { resetHarvestDebrid($('harvestDebridResetBtn')); });
  $('harvestDebridKey').addEventListener('keydown', (event: any) => { if (event.key === 'Enter') saveHarvestDebrid($('harvestDebridSaveBtn')); });
  $('cacheNamespace').addEventListener('change', updateCacheScopeAvailability);
  for (let i = 0; i < actions.length; i += 1) actions[i].addEventListener('click', function () { runAction(this); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (DashState.refreshTimer) { clearTimeout(DashState.refreshTimer); DashState.refreshTimer = null; }
      return;
    }
    loadStatus();
    scheduleRefresh();
  });
  $('tabGeral').addEventListener('click', () => { switchTab('geral'); });
  $('tabAutofetch').addEventListener('click', () => { switchTab('autofetch'); });
  $('tabColhedor').addEventListener('click', () => { switchTab('colhedor'); });
  $('tabTrace').addEventListener('click', () => { switchTab('trace'); });
  $('traceQueryBtn').addEventListener('click', () => { runTraceQuery($('traceQueryBtn')); });
  $('traceLiveBtn').addEventListener('click', () => { runTraceLive($('traceLiveBtn')); });
  $('harvestPauseToggleBtn').addEventListener('click', () => { toggleHarvesterPause(); });
  $('harvestBannerResumeBtn').addEventListener('click', () => { toggleHarvesterPause(false); });
  $('harvestDrainBtn').addEventListener('click', drainHarvesterQueue);
  $('harvestClearQueueBtn').addEventListener('click', clearHarvesterQueue);
  $('harvestSaveBtn').addEventListener('click', saveHarvesterConfig);
  $('harvestResetBtn').addEventListener('click', resetHarvesterConfig);
  $('harvestPresetPadrao').addEventListener('click', () => { applyHarvesterPreset('padrao'); });
  $('harvestPresetAcelerado').addEventListener('click', () => { applyHarvesterPreset('acelerado'); });
  $('harvestPresetSilencioso').addEventListener('click', () => { applyHarvesterPreset('silencioso'); });
  $('afPauseToggleBtn').addEventListener('click', () => { toggleAutofetchPause(); });
  $('afBannerResumeBtn').addEventListener('click', () => { toggleAutofetchPause(false); });
  $('afDrainBtn').addEventListener('click', drainAutofetchQueues);
  $('afSaveBtn').addEventListener('click', saveAutofetchConfig);
  $('afResetBtn').addEventListener('click', resetAutofetchConfig);
  $('afPresetConservador').addEventListener('click', () => { applyAutofetchPreset('conservador'); });
  $('afPresetAgressivo').addEventListener('click', () => { applyAutofetchPreset('agressivo'); });
  $('afPresetSwarm').addEventListener('click', () => { applyAutofetchPreset('swarm'); });
  $('catalogScanBtn').addEventListener('click', runCatalogScan);
  $('catalogReportBtn').addEventListener('click', runCatalogReport);
  $('catalogAuditBtn').addEventListener('click', runCatalogAudit);
  $('catalogRequeueBtn').addEventListener('click', runCatalogRequeue);
  $('catalogListBtn').addEventListener('click', runCatalogList);
  $('catalogSelectAllBtn').addEventListener('click', toggleCatalogSelectAll);
  $('catalog_manual').addEventListener('change', refreshCatalogSelection);
  $('catalogManualDeleteBtn').addEventListener('click', runCatalogManualDelete);
  $('catalogDedupPreviewBtn').addEventListener('click', runCatalogDedupPreview);
  $('catalogDedupApplyBtn').addEventListener('click', runCatalogDedupApply);
  $('catalogCleanupPreviewBtn').addEventListener('click', runCatalogCleanupPreview);
  $('catalogCleanupApplyBtn').addEventListener('click', runCatalogCleanupApply);
  bindMagnetPanel();
  // Estado vazio honesto (campo de token próprio) e chips de âncora por aba, com
  // realce da seção visível no scroll.
  bindHealthPanel();
  bindSectionNav();
  // Disclosure das 9 seções da Geral — sincroniza os toggles com o estado do HTML
  // (secGeral aberto, resto [hidden]) e liga o clique.
  initSectionToggles();
  bindSectionToggles();
  window.addEventListener('hashchange', handleHash);
  handleHash();
  renderSectionNav(activeTabName());
  markActiveSection();

  DashState.lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
  scheduleRefresh();
  loadStatus();
}
