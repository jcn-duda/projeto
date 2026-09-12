/* Adom Power-Movie — /dashboard: painéis do índice de releases e do colhedor
 * (C3, ESM). Extraído de panels.ts para respeitar o teto de 400 linhas. Nada
 * toca o DOM no import. */

import { $, copyObject, first, isObject, origemOf, valueText } from './core.js';
import { asList, empty, formatDate, metric, metricOrigem, renderCollection, renderMetrics } from './render.js';

// Fase 5: índice de releases + colhedor. Tudo vem pronto do servidor
// (releaseIndex/harvest no dashboard-status); aqui só renderiza.
export function renderReleaseIndex(data: any): void {
  const idx = isObject(data) ? data : {};
  const metrics = $('idxMetrics');
  metrics.textContent = '';
  if (!first(idx, ['enabled'], false)) {
    empty(metrics, 'Índice desativado (RELEASE_INDEX=false).');
    return;
  }
  renderMetrics(metrics, idx, {});
}

export function renderHarvest(data: any, uptimeS: any): void {
  const harvest = isObject(data) ? data : {};
  const metrics = $('harvestMetrics');
  metrics.textContent = '';
  if (!first(harvest, ['enabled'], false)) {
    empty(metrics, 'Colhedor desativado (HARVEST_ENABLED=false).');
    empty($('harvestCards'), 'Colhedor desativado.');
    return;
  }
  // _origem: fila/orçamento = durável; enabled/paused/lastRun = amostra do processo.
  if (isObject(harvest._origem)) {
    metricOrigem(metrics, 'queriesThisHour', harvest.queriesThisHour, origemOf(harvest, 'queriesThisHour'), uptimeS);
    metricOrigem(metrics, 'queueDepth', harvest.queueDepth, origemOf(harvest, 'queueDepth'), uptimeS);
    metricOrigem(metrics, 'enabled', harvest.enabled, origemOf(harvest, 'enabled'), uptimeS);
    metricOrigem(metrics, 'paused', harvest.paused, origemOf(harvest, 'paused'), uptimeS);
    metricOrigem(metrics, 'lastRunAt', harvest.lastRunAt != null ? formatDate(harvest.lastRunAt) : harvest.lastRunAt, origemOf(harvest, 'lastRunAt'), uptimeS);
    renderMetrics(metrics, harvest, {
      _origem: true,
      queriesThisHour: true,
      queueDepth: true,
      enabled: true,
      paused: true,
      lastRunAt: true,
      queuePreview: true,
      lastWorks: true,
      config: true,
    });
  } else {
    renderMetrics(metrics, harvest, {});
  }
  const queue = asList(first(harvest, ['queuePreview'], []), 'queuePreview');
  const last = asList(first(harvest, ['lastWorks'], []), 'lastWorks');
  const mapped = queue.map((item) => { const copy = copyObject(item); copy.label = 'Na fila · ' + valueText(copy.imdbId); return copy; });
  last.forEach((item) => { const copy = copyObject(item); copy.label = 'Colhida · ' + valueText(copy.imdbId); mapped.push(copy); });
  renderCollection($('harvestCards'), mapped, 'queuePreview', {});
}
