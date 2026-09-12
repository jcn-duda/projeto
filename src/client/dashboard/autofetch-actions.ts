/* Adom Power-Movie — aba Chupim / Autofetch: ações (C3, ESM nativo).
 * Salvar/resetar configuração, pausar/retomar, drenar filas e presets. Extraído
 * de autofetch.ts para respeitar o teto de 400 linhas. O refresh pós-ação sai
 * pelo hook loadStatus. Nada toca o DOM no import. */

import { $, requestJson, valueText } from './core.js';
import { hooks } from './hooks.js';
import { AF_KEYS, BOOLEAN_AF_KEYS, isAutofetchPaused } from './autofetch.js';

function setAfFeedback(text: string, kind?: string): void {
  const el = $('afFeedback');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'feedback' + (kind ? ' ' + kind : '');
}

export function saveAutofetchConfig(): void {
  const patch: any = {};
  for (let i = 0; i < AF_KEYS.length; i += 1) {
    const k = AF_KEYS[i];
    const input = $('af_' + k);
    if (input) {
      if (BOOLEAN_AF_KEYS.indexOf(k) !== -1) {
        patch[k] = Boolean(input.checked);
      } else {
        const val = Number(input.value);
        if (isFinite(val)) patch[k] = val;
      }
    }
  }
  $('afSaveBtn').disabled = true;
  setAfFeedback('Salvando configurações…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'autofetch-config-set', patch }),
  })
    .then((data: any) => {
      if (data && data.ok) {
        setAfFeedback('Configurações do Chupim salvas com sucesso!', 'ok');
        hooks.call('loadStatus');
      } else {
        const errStr = data && data.errors ? data.errors.join(', ') : 'erro desconhecido';
        setAfFeedback('Erro ao salvar: ' + errStr, 'error');
      }
    })
    .catch((err: any) => {
      setAfFeedback('Falha na requisição: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('afSaveBtn').disabled = false; });
}

export function resetAutofetchConfig(): void {
  if (!window.confirm('Restaurar todos os parâmetros do Chupim aos padrões do .env?')) return;
  $('afResetBtn').disabled = true;
  setAfFeedback('Restaurando padrões…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'autofetch-config-reset', confirm: true }),
  })
    .then((data: any) => {
      if (data && data.ok) {
        setAfFeedback('Padrões do .env restaurados com sucesso!', 'ok');
        hooks.call('loadStatus');
      } else {
        setAfFeedback('Erro ao restaurar padrões.', 'error');
      }
    })
    .catch((err: any) => {
      setAfFeedback('Falha na requisição: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('afResetBtn').disabled = false; });
}

export function toggleAutofetchPause(forcedState?: any): void {
  const nextState = typeof forcedState === 'boolean' ? forcedState : !isAutofetchPaused();
  const msg = nextState
    ? 'Deseja pausar o Chupim? Novos downloads não serão enviados ao debrid.'
    : 'Deseja retomar o Chupim?';
  if (!window.confirm(msg)) return;
  setAfFeedback('Atualizando estado de pausa…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'autofetch-pause', paused: nextState }),
  })
    .then(() => {
      setAfFeedback(nextState ? 'Chupim pausado com sucesso.' : 'Chupim retomado com sucesso.', 'ok');
      hooks.call('loadStatus');
    })
    .catch((err: any) => {
      setAfFeedback('Erro ao alterar pausa: ' + valueText(err && err.message ? err.message : err), 'error');
    });
}

export function drainAutofetchQueues(): void {
  if (!window.confirm('Deseja realmente esvaziar todas as filas do Chupim?')) return;
  $('afDrainBtn').disabled = true;
  setAfFeedback('Drenando filas…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'autofetch-drain', confirm: true }),
  })
    .then((data: any) => {
      const q = data && data.queues ? data.queues : 0;
      const it = data && data.items ? data.items : 0;
      setAfFeedback('Filas drenadas: ' + q + ' fila(s), ' + it + ' item(ns) removidos.', 'ok');
      hooks.call('loadStatus');
    })
    .catch((err: any) => {
      setAfFeedback('Erro ao drenar filas: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('afDrainBtn').disabled = false; });
}

export function applyAutofetchPreset(preset: string): void {
  if (preset === 'conservador') {
    $('af_autoFetchMax').value = 1;
    $('af_autoFetchTopSeedsMax').value = 1;
    $('af_autoFetchQueueDepth').value = 2;
    $('af_autoFetchEnqueueMaxHour').value = 15;
    $('af_autoFetchMinSeeders').value = 2;
    $('af_autoFetchStallStreak').value = 2;
    setAfFeedback("Preset Conservador carregado no formulário. Clique em 'Salvar Alterações' para aplicar.", 'warn');
  } else if (preset === 'agressivo') {
    $('af_autoFetchMax').value = 3;
    $('af_autoFetchTopSeedsMax').value = 2;
    $('af_autoFetchQueueDepth').value = 6;
    $('af_autoFetchEnqueueMaxHour').value = 40;
    $('af_autoFetchMinSeeders').value = 0;
    $('af_autoFetchStallStreak').value = 3;
    setAfFeedback("Preset Agressivo carregado no formulário. Clique em 'Salvar Alterações' para aplicar.", 'warn');
  } else if (preset === 'swarm') {
    $('af_autoFetchTopSeeds').checked = true;
    $('af_autoFetchSeedsPtFirst').checked = true;
    $('af_autoFetchTopSeedsMax').value = 3;
    $('af_autoFetchAnyDubbed').checked = true;
    setAfFeedback("Preset Foco em Swarm carregado no formulário. Clique em 'Salvar Alterações' para aplicar.", 'warn');
  }
}
