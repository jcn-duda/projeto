/* Adom Power-Movie — /dashboard: ações e escopo de cache (C3, ESM).
 * Extraído de status.ts para respeitar o teto de 400 linhas. O refresh
 * pós-ação sai pelo hook loadStatus (registrado pelo entry), que é o sentido
 * que fecha o ciclo sem status-actions → status-root. Nada toca o DOM no
 * import. */

import { $, first, isObject, requestJson, setFeedback, valueText } from './core.js';
import { asList } from './render.js';
import { hooks } from './hooks.js';

export function hasConfiguredInstallation(): boolean {
  const parts = String(window.location.pathname || '').replace(/^\/+|\/+$/g, '').split('/');
  return parts.length === 2 && parts[1] === 'dashboard' && parts[0] !== 'dashboard';
}

export function updateCacheScopeAvailability(): void {
  const available = hasConfiguredInstallation();
  const checkbox = $('cacheInstallation');
  checkbox.disabled = !available || Boolean($('cacheNamespace').value);
  if (checkbox.disabled) checkbox.checked = false;
  $('cacheInstallationLabel').style.opacity = available ? '1' : '0.55';
}

export function updateCacheScopes(root: any): void {
  const select = $('cacheNamespace');
  const cache = first(root, ['cache'], {});
  const namespaces = first(cache, ['namespaces'], {});
  const current = select.value;
  const names = Object.keys(namespaces || {}).sort();
  select.innerHTML = '<option value="">Todo o cache</option>';
  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = 'Somente ' + name;
    if (name === current) option.selected = true;
    select.appendChild(option);
  });
  updateCacheScopeAvailability();
}

export function updateActionAvailability(root: any): void {
  const harvest = first(root, ['harvest', 'harvester'], {});
  const debrid = first(root, ['debrid', 'debridStatus'], {});
  const af = first(root, ['autofetch', 'autoFetch', 'autofetchStatus'], {});
  $('harvesterPauseButton').textContent = harvest.paused ? 'Retomar colhedor' : 'Pausar colhedor';
  $('harvesterPauseButton').setAttribute('data-paused', harvest.paused ? 'false' : 'true');
  $('harvesterDrainButton').disabled = !harvest.queueDepth;
  $('afSuppressedDrainBtn').disabled = !af.suppressed;
  $('testAllIndexersButton').disabled = !asList(root.indexers, 'indexers').length;
  $('refreshInventoryButton').disabled = !debrid.active;
  updateCacheScopes(root);
}

function actionLabel(action: string | null): string {
  const labels: Record<string, string> = {
    'sweep-dead': 'a varredura de magnets mortos', 'clear-cache': 'a limpeza do cache',
    'harvester-pause': 'a alteração do estado do colhedor', 'harvester-drain': 'a drenagem imediata da fila',
    'autofetch-suppressed-drain': 'a drenagem das remoções represadas',
    'test-all-indexers': 'o teste sequencial de todos os indexadores', 'refresh-inventory': 'a reavaliação do inventário',
  };
  return (action && labels[action]) || 'esta ação';
}

// Feedback com o SALDO da drenagem (removidas / elegíveis / restantes — os três
// da conta do operador; o número do painel é agregado e a diferença tem de ficar
// visível). Demais ações mantêm o contrato antigo (message/result).
function actionFeedback(action: string, data: any): string {
  if (action === 'autofetch-suppressed-drain' && isObject(data)) {
    return 'Remoções represadas: ' + Number(first(data, ['removidas'], 0)) + ' removida(s) · ' +
      Number(first(data, ['elegiveis'], 0)) + ' elegível(is) na conta do operador · ' +
      Number(first(data, ['restantes'], 0)) + ' restante(s) na conta do operador.';
  }
  return valueText(first(data, ['message', 'result'], 'Ação concluída.'));
}

export function runAction(button: any): void {
  const action = button.getAttribute('data-action');
  if (!window.confirm('Confirmar ' + actionLabel(action) + '?')) return;
  button.disabled = true;
  setFeedback('Executando ' + action + '…', 'warn');
  const payload: any = { action, paused: button.getAttribute('data-paused') === 'true', confirm: true };
  if (action === 'clear-cache') {
    const namespace = $('cacheNamespace').value;
    if (namespace) payload.scope = { namespace };
    else if ($('cacheInstallation').checked) payload.scope = { installation: true };
  }
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((data: any) => {
      setFeedback(actionFeedback(action, data), 'ok');
      hooks.call('loadStatus');
    })
    .catch((error: any) => { setFeedback('Ação não concluída: ' + valueText(error && error.message ? error.message : error), 'error'); })
    .then(() => { button.disabled = false; });
}
