/* Adom Power-Movie — aba Colhedor / Harvester: ações (C3, ESM nativo).
 * Salvar/resetar configuração, pausar/retomar, drenar/limpar fila e presets.
 * Extraído de harvest.ts para respeitar o teto de 400 linhas. O refresh
 * pós-ação sai pelo hook loadStatus. Nada toca o DOM no import. */

import { $, requestJson, valueText } from './core.js';
import { hooks } from './hooks.js';
import { BOOLEAN_HARVEST_KEYS, HARVEST_KEYS, isHarvestPaused } from './harvest.js';

function setHarvestFeedback(text: string, kind?: string): void {
  const el = $('harvestFeedback');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'feedback' + (kind ? ' ' + kind : '');
}

export function saveHarvesterConfig(): void {
  const patch: any = {};
  for (let i = 0; i < HARVEST_KEYS.length; i += 1) {
    const k = HARVEST_KEYS[i];
    const input = $('harvest_' + k);
    if (input) {
      if (BOOLEAN_HARVEST_KEYS.indexOf(k) !== -1) {
        patch[k] = Boolean(input.checked);
      } else {
        const val = Number(input.value);
        if (isFinite(val)) patch[k] = val;
      }
    }
  }
  $('harvestSaveBtn').disabled = true;
  setHarvestFeedback('Salvando configurações…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'harvest-config-set', patch }),
  })
    .then((data: any) => {
      if (data && data.ok) {
        setHarvestFeedback('Configurações do Colhedor salvas com sucesso!', 'ok');
        hooks.call('loadStatus');
      } else {
        const errStr = data && data.errors ? data.errors.join(', ') : 'erro desconhecido';
        setHarvestFeedback('Erro ao salvar: ' + errStr, 'error');
      }
    })
    .catch((err: any) => {
      setHarvestFeedback('Falha na requisição: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('harvestSaveBtn').disabled = false; });
}

export function resetHarvesterConfig(): void {
  if (!window.confirm('Restaurar todos os parâmetros do Colhedor aos padrões do .env?')) return;
  $('harvestResetBtn').disabled = true;
  setHarvestFeedback('Restaurando padrões…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'harvest-config-reset', confirm: true }),
  })
    .then((data: any) => {
      if (data && data.ok) {
        setHarvestFeedback('Padrões do .env restaurados com sucesso!', 'ok');
        hooks.call('loadStatus');
      } else {
        setHarvestFeedback('Erro ao restaurar padrões.', 'error');
      }
    })
    .catch((err: any) => {
      setHarvestFeedback('Falha na requisição: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('harvestResetBtn').disabled = false; });
}

export function toggleHarvesterPause(forcedState?: any): void {
  const nextState = typeof forcedState === 'boolean' ? forcedState : !isHarvestPaused();
  const msg = nextState
    ? 'Deseja pausar o Colhedor? Obras em segundo plano não serão colhidas.'
    : 'Deseja retomar o Colhedor?';
  if (!window.confirm(msg)) return;
  setHarvestFeedback('Atualizando estado de pausa…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'harvester-pause', paused: nextState }),
  })
    .then(() => {
      setHarvestFeedback(nextState ? 'Colhedor pausado com sucesso.' : 'Colhedor retomado com sucesso.', 'ok');
      hooks.call('loadStatus');
    })
    .catch((err: any) => {
      setHarvestFeedback('Erro ao alterar pausa: ' + valueText(err && err.message ? err.message : err), 'error');
    });
}

export function drainHarvesterQueue(): void {
  if (!window.confirm('Deseja drenar uma fatia da fila do Colhedor?')) return;
  $('harvestDrainBtn').disabled = true;
  setHarvestFeedback('Drenando fatia da fila…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'harvester-drain' }),
  })
    .then((data: any) => {
      const d = data && data.drained !== undefined ? data.drained : 0;
      setHarvestFeedback('Fila drenada: ' + d + ' obra(s) processada(s).', 'ok');
      hooks.call('loadStatus');
    })
    .catch((err: any) => {
      setHarvestFeedback('Erro ao drenar: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('harvestDrainBtn').disabled = false; });
}

export function clearHarvesterQueue(): void {
  if (!window.confirm('Deseja realmente esvaziar todas as obras pendentes na fila do Colhedor?')) return;
  $('harvestClearQueueBtn').disabled = true;
  setHarvestFeedback('Limpando fila…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'harvester-clear-queue', confirm: true }),
  })
    .then((data: any) => {
      const c = data && data.cleared !== undefined ? data.cleared : 0;
      setHarvestFeedback('Fila esvaziada: ' + c + ' obra(s) removida(s).', 'ok');
      hooks.call('loadStatus');
    })
    .catch((err: any) => {
      setHarvestFeedback('Erro ao limpar fila: ' + valueText(err && err.message ? err.message : err), 'error');
    })
    .then(() => { $('harvestClearQueueBtn').disabled = false; });
}

export function applyHarvesterPreset(preset: string): void {
  if (preset === 'padrao') {
    $('harvest_harvestEnabled').checked = true;
    $('harvest_harvestMaxPerHour').value = 120;
    $('harvest_harvestIdleWindowMs').value = 600000;
    $('harvest_harvestIntervalMs').value = 60000;
    $('harvest_harvestIndexerDelayMs').value = 1500;
    $('harvest_harvestQueueMax').value = 200;
    $('harvest_harvestDrainMaxWorks').value = 5;
    $('harvest_harvestBrFirst').checked = true;
    $('harvest_harvestBrMaxWaitMs').value = 21600000;
    $('harvest_seedEnabled').checked = true;
    $('harvest_seedMaxPerCycle').value = 20;
    $('harvest_seedMinVotes').value = 1000;
    $('harvest_seedIntervalH').value = 24;
    setHarvestFeedback("Preset Padrão Balanceado carregado. Clique em 'Salvar Alterações' para aplicar.", 'warn');
  } else if (preset === 'acelerado') {
    $('harvest_harvestEnabled').checked = true;
    $('harvest_harvestMaxPerHour').value = 300;
    $('harvest_harvestIdleWindowMs').value = 120000;
    $('harvest_harvestIntervalMs').value = 30000;
    $('harvest_harvestIndexerDelayMs').value = 1000;
    $('harvest_harvestQueueMax').value = 500;
    $('harvest_harvestDrainMaxWorks').value = 15;
    $('harvest_harvestBrFirst').checked = true;
    $('harvest_harvestBrMaxWaitMs').value = 21600000;
    $('harvest_seedEnabled').checked = true;
    $('harvest_seedMaxPerCycle').value = 40;
    $('harvest_seedMinVotes').value = 500;
    $('harvest_seedIntervalH').value = 12;
    setHarvestFeedback("Preset Acelerado (Madrugada) carregado. Clique em 'Salvar Alterações' para aplicar.", 'warn');
  } else if (preset === 'silencioso') {
    $('harvest_harvestEnabled').checked = true;
    $('harvest_harvestMaxPerHour').value = 40;
    $('harvest_harvestIdleWindowMs').value = 1800000;
    $('harvest_harvestIntervalMs').value = 120000;
    $('harvest_harvestIndexerDelayMs').value = 3000;
    $('harvest_harvestQueueMax').value = 100;
    $('harvest_harvestDrainMaxWorks').value = 2;
    $('harvest_harvestBrFirst').checked = true;
    $('harvest_harvestBrMaxWaitMs').value = 21600000;
    $('harvest_seedEnabled').checked = false;
    setHarvestFeedback("Preset Silencioso / Econômico carregado. Clique em 'Salvar Alterações' para aplicar.", 'warn');
  }
}
