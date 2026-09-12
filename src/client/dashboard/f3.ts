/* Adom Power-Movie — /dashboard: cobertura BR (F3) na aba Geral (C3, ESM).
 * renderF3Panel pinta os gauges f3.br.popular.* (metrics.gauges) e o f3.latest
 * completo — alvo, descoberta, miss/unknown, releases e os cortes movie/series.
 * Sem rede, sem ações. Nada toca o DOM no import. */

import { $, isObject, origemOf, valueText } from './core.js';
import { empty, formatDate, metric, metricOrigem } from './render.js';

function formatF3Rate(value: any): string {
  if (value === undefined || value === null || value === '') return '—';
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return Math.round(n * 100) + '%';
}

const F3_GAUGE_PREFIX = 'f3.br.popular.';

function f3Gauge(gauges: any, name: string): any {
  return isObject(gauges) ? gauges[F3_GAUGE_PREFIX + name] : undefined;
}

// Prefere o gauge corrente (nível vivo do sampler) e cai no último sample quando
// a fase está desligada ou os gauges foram limpos com a coorte.
function f3Number(gauges: any, latest: any, gaugeName: string, latestField: string): string {
  let value = f3Gauge(gauges, gaugeName);
  if (value === undefined && latest) value = latest[latestField];
  if (value === undefined || value === null) return '—';
  return valueText(value);
}

// Cada tipo (movie/series) carrega os mesmos contadores num sub-objeto que o
// renderMetrics genérico descarta por ser objeto; aqui vira linha legível.
function f3TypeLine(box: any, label: string, counts: any): void {
  const c = isObject(counts) ? counts : {};
  metric(box, label + ' em cache / indexadas', valueText(c.cached) + '/' + valueText(c.indexed));
  metric(box, label + ' com BR / miss / unknown', valueText(c.withBr) + '/' + valueText(c.knownMiss) + '/' + valueText(c.unknown));
}

export function renderF3Panel(f3: any, uptimeS: any, gauges: any): void {
  const box = $('f3Metrics');
  if (!box) return;
  box.textContent = '';
  if (!f3 || !isObject(f3)) {
    empty(box, 'sem amostra');
    return;
  }
  if (!f3.enabled) {
    empty(box, 'F3 desligado (F3_ENABLED / F3_BR_ENABLED).');
    return;
  }
  const latest = isObject(f3.latest) ? f3.latest : null;
  const counters = isObject(f3.counters) ? f3.counters : {};
  metric(box, 'targetWorks', f3Number(gauges, latest, 'target', 'targetWorks'));
  metric(box, 'indexedWorks', f3Number(gauges, latest, 'indexed', 'indexedWorks'));
  metric(box, 'worksWithBr', f3Number(gauges, latest, 'withBr', 'worksWithBr'));
  metric(box, 'worksCached', f3Number(gauges, latest, 'cached', 'worksCached'));
  metric(box, 'worksKnownMiss', f3Number(gauges, latest, 'knownMiss', 'worksKnownMiss'));
  metric(box, 'worksUnknown', f3Number(gauges, latest, 'unknown', 'worksUnknown'));
  metric(box, 'releasesWithBr', f3Number(gauges, latest, 'releasesWithBr', 'releasesWithBr'));
  metric(box, 'releasesCached', f3Number(gauges, latest, 'releasesCached', 'releasesCached'));
  metricOrigem(box, 'popularCoverage', formatF3Rate(f3.popularCoverage), origemOf(f3, 'popularCoverage'), uptimeS);
  metricOrigem(box, 'discoveryRate', formatF3Rate(f3.discoveryRate), origemOf(f3, 'discoveryRate'), uptimeS);
  metricOrigem(box, 'brWarmRate', formatF3Rate(f3.brWarmRate), origemOf(f3, 'brWarmRate'), uptimeS);
  f3TypeLine(box, 'movie', latest ? latest.movie : null);
  f3TypeLine(box, 'series', latest ? latest.series : null);
  metric(box, 'samples', counters.sample != null ? counters.sample : f3.samples);
  if (f3.baselineAt) metric(box, 'baselineAt', formatDate(f3.baselineAt));
  if (latest && latest.cohortAt) metric(box, 'cohortAt', formatDate(latest.cohortAt));
  if (latest && latest.at) metric(box, 'latest', formatDate(latest.at));
  else if (!latest) metric(box, 'latest', 'sem amostra');
}
