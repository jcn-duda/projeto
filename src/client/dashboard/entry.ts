/* Adom Power-Movie — /dashboard: entry ESM nativo (C3).
 *
 * Único ponto que REGISTRA os hooks e dispara o wiring: os módulos provedores só
 * exportam funções, e aqui a composição fica explícita (quem provê cada hook) e
 * visível num lugar só. Importar o entry executa registerHooks() + bind(); os
 * demais módulos não têm efeito de topo algum. */

import { hooks } from './hooks.js';
import { loadStatus, rerenderActiveTab } from './status-root.js';
import { activeTabName } from './nav.js';
import { dashDebugEnabled, renderAttentionStrip, renderHealthStrip, updateEmptyState } from './health.js';
import { runIndexerTest, runResolverTest } from './probes.js';
import { renderGeneralDiagnostics } from './general.js';
import { renderTimersPanel } from './timers.js';
import { renderF3Panel } from './f3.js';
import { renderCatalogPanel } from './catalog-panel.js';
import { renderCatalogReport } from './catalog-render.js';
import { renderAutofetchStall } from './af-stall.js';
import { bind } from './boot.js';

/** Composição fechada de hooks da página: nome → função provedora. Separado do
 * bind para os testes poderem registrar sem montar todo o DOM. */
export function registerHooks(): void {
  hooks.register('loadStatus', loadStatus);
  hooks.register('rerenderActiveTab', rerenderActiveTab);
  hooks.register('activeTabName', activeTabName);
  hooks.register('renderHealthStrip', renderHealthStrip);
  hooks.register('renderAttentionStrip', renderAttentionStrip);
  hooks.register('updateEmptyState', updateEmptyState);
  hooks.register('dashDebugEnabled', dashDebugEnabled);
  hooks.register('runIndexerTest', runIndexerTest);
  hooks.register('runResolverTest', runResolverTest);
  hooks.register('renderGeneralDiagnostics', renderGeneralDiagnostics);
  hooks.register('renderTimersPanel', renderTimersPanel);
  hooks.register('renderF3Panel', renderF3Panel);
  hooks.register('renderCatalogPanel', renderCatalogPanel);
  hooks.register('renderCatalogReport', renderCatalogReport);
  hooks.register('renderAutofetchStall', renderAutofetchStall);
}

registerHooks();
bind();
