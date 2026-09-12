/* Adom Power-Movie — aba Colhedor / Harvester: render (C3, ESM nativo).
 * Extraído para respeitar o teto de 400 linhas; as ações vivem em
 * harvest-actions.ts e a conta de debrid de fundo em harvest-debrid.ts. Nada
 * toca o DOM no import. */

import { $, isObject, origemOf, valueText } from './core.js';
import { applyOrigem, formatDate } from './render.js';
import { renderHarvestDebridAccount } from './harvest-debrid.js';

export const HARVEST_KEYS = [
  'harvestEnabled', 'harvestMaxPerHour', 'harvestIdleWindowMs', 'harvestIntervalMs',
  'harvestIndexerDelayMs', 'harvestQueueMax', 'harvestDrainMaxWorks', 'harvestEntryTtl',
  'harvestBrFirst', 'harvestBrMaxWaitMs',
  'seedEnabled', 'seedMaxPerCycle', 'seedMinVotes', 'seedIntervalH',
];

export const BOOLEAN_HARVEST_KEYS = ['harvestEnabled', 'harvestBrFirst', 'seedEnabled'];

let harvestPaused = false;

export function setHarvestPaused(value: boolean): void { harvestPaused = value; }
export function isHarvestPaused(): boolean { return harvestPaused; }

export function renderHarvesterPanel(harvest: any, counters: any, uptimeS: any): void {
  if (!harvest) return;
  const cfg = harvest.config || {};
  const eff = cfg.effective || {};
  const env = cfg.envDefaults || {};
  const overridden = cfg.overriddenKeys || [];
  const ctr = isObject(counters) ? counters : {};

  setHarvestPaused(Boolean(cfg.paused || harvest.paused));

  // _origem: queueDepth/queriesThisHour = duravel; enabled/paused/lastRunAt =
  // amostra. Sem _origem → fail-open (número antigo, sem title).
  const stEl = $('harvestMetricState');
  if (stEl) {
    stEl.style.color = harvestPaused ? 'var(--red)' : 'var(--green)';
    applyOrigem(stEl, harvestPaused ? 'PAUSADO' : 'ATIVO', origemOf(harvest, 'paused'), uptimeS);
  }

  const qEl = $('harvestMetricQueue');
  if (qEl) {
    applyOrigem(qEl, valueText(harvest.queueDepth) + ' obra(s) / max ' + valueText(harvest.queueMax), origemOf(harvest, 'queueDepth'), uptimeS);
  }

  const cEl = $('harvestMetricQueries');
  if (cEl) {
    applyOrigem(cEl, valueText(harvest.queriesThisHour) + ' / ' + valueText(harvest.maxPerHour), origemOf(harvest, 'queriesThisHour'), uptimeS);
  }

  const hEl = $('harvestMetricHarvested');
  if (hEl) applyOrigem(hEl, harvest.harvested, origemOf(harvest, 'harvested'), uptimeS);

  const dEl = $('harvestMetricDone');
  if (dEl) applyOrigem(dEl, ctr['harvest.done'], origemOf(ctr, 'harvest.done'), uptimeS);
  const eEl = $('harvestMetricEmpty');
  if (eEl) applyOrigem(eEl, ctr['harvest.empty'], origemOf(ctr, 'harvest.empty'), uptimeS);

  const rEl = $('harvestMetricLastRun');
  if (rEl) {
    applyOrigem(rEl, harvest.lastRunAt ? formatDate(harvest.lastRunAt) : '—', origemOf(harvest, 'lastRunAt'), uptimeS);
  }

  const pauseBtn = $('harvestPauseToggleBtn');
  if (pauseBtn) {
    pauseBtn.textContent = harvestPaused ? 'Retomar Colhedor' : 'Pausar Colhedor';
    pauseBtn.className = harvestPaused ? 'danger' : 'primary';
  }

  const banner = $('harvestPauseBanner');
  if (banner) {
    if (harvestPaused) {
      banner.className = 'pause-banner visible';
      let txt = 'Colhedor está PAUSADO';
      if (cfg.pausedSince) txt += ' desde ' + formatDate(cfg.pausedSince);
      txt += '. Nenhuma obra em segundo plano será colhida.';
      $('harvestPauseBannerText').textContent = txt;
    } else {
      banner.className = 'pause-banner';
    }
  }

  for (let i = 0; i < HARVEST_KEYS.length; i += 1) {
    const k = HARVEST_KEYS[i];
    const input = $('harvest_' + k);
    const envSpan = $('env_harvest_' + k);
    const badge = $('badge_harvest_' + k);
    if (input) {
      if (BOOLEAN_HARVEST_KEYS.indexOf(k) !== -1) {
        input.checked = Boolean(eff[k]);
      } else {
        input.value = eff[k] !== undefined && eff[k] !== null ? eff[k] : '';
      }
    }
    if (envSpan) {
      envSpan.textContent = env[k] !== undefined && env[k] !== null ? String(env[k]) : '—';
    }
    if (badge) {
      badge.style.display = overridden.indexOf(k) !== -1 ? 'inline-block' : 'none';
    }
  }
  // Conta de debrid de fundo (quota-warn / warm RD): identidade mascarada do
  // snapshot — a chave crua nunca chega ao painel.
  renderHarvestDebridAccount(harvest.debridAccount, harvest.debridResolved);
}
