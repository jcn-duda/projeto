/* Adom Power-Movie — /dashboard: painéis de cache e namespaces/L2 (C3, ESM).
 * Extraído de panels.ts para respeitar o teto de 400 linhas. Nada toca o DOM no
 * import. */

import { $, first, isObject } from './core.js';
import { formatBytes, metric, metricGroupTitle, metricMaybeOrigem, renderCollection, renderMetrics } from './render.js';

// Fase 3.3 do redesign: cache por namespace. Os contadores cache.hit.<balde> e
// cache.miss.<balde> existem desde a Fase 0 do cache, mas a tela só mostrava o
// hit-rate global — o balde que está pagando rede de novo ficava invisível.
// `cache.expired` é global (o contador não carrega balde).
export const CACHE_BUCKETS = ['raw', 'streams', 'meta', 'tmdb', 'idx', 'mag', 'dinv', 'dlmag', 'seed', 'autofetch', 'indexer-status'];

function cacheBucketRate(hits: number, misses: number): string {
  const total = hits + misses;
  return total > 0 ? Math.round((hits / total) * 100) + '%' : '—';
}

function renderCacheNamespaces(metrics: any, counters: any): void {
  const source = isObject(counters) ? counters : {};
  let any = 0;
  const expired = Number(source['cache.expired'] || 0);
  for (let i = 0; i < CACHE_BUCKETS.length; i += 1) {
    const name = CACHE_BUCKETS[i];
    if ((Number(source['cache.hit.' + name] || 0) + Number(source['cache.miss.' + name] || 0)) > 0) any += 1;
  }
  if (!any && !expired) return;
  metricGroupTitle(metrics, 'Cache por namespace');
  for (let i = 0; i < CACHE_BUCKETS.length; i += 1) {
    const name = CACHE_BUCKETS[i];
    const hits = Number(source['cache.hit.' + name] || 0);
    const misses = Number(source['cache.miss.' + name] || 0);
    if (!hits && !misses) continue;
    metric(metrics, name + ' (hit/miss)', cacheBucketRate(hits, misses) + ' · ' + hits + '/' + misses);
  }
  metric(metrics, 'expirados', expired);
}

export function renderCache(data: any, counters: any): void {
  const source = isObject(data) ? data : {};
  const metrics = $('cacheMetrics');
  const cards = $('cacheCards');
  const namespaces = first(source, ['namespaces', 'byNamespace', 'stats'], []);
  metrics.textContent = '';
  renderMetrics(metrics, source, { namespaces: true, byNamespace: true, stats: true, l2: true });
  if (isObject(source.l2)) {
    metricGroupTitle(metrics, 'Persistência L2 (SQLite)');
    // Os quatro campos passam pelo mesmo rótulo, como no Colhedor: `duravel` nos
    // três medidos do disco, `amostra` na fila pendente, que é deste processo e
    // zera no restart. Rotular só o divergente deixaria os outros três sem
    // procedência declarada. `uptimeS` fica undefined: renderCache recebe a
    // seção `cache`, que não carrega o uptime.
    metricMaybeOrigem(metrics, 'L2 banco (tamanho)', formatBytes(source.l2.fileSizeBytes || 0), source.l2, 'fileSizeBytes', undefined);
    metricMaybeOrigem(metrics, 'L2 WAL (tamanho)', formatBytes(source.l2.walSizeBytes || 0), source.l2, 'walSizeBytes', undefined);
    metricMaybeOrigem(metrics, 'L2 freelist (páginas)', source.l2.freelistCount || 0, source.l2, 'freelistCount', undefined);
    metricMaybeOrigem(metrics, 'L2 fila pendente', source.l2.pendingWrites || 0, source.l2, 'pendingWrites', undefined);
  }
  renderCacheNamespaces(metrics, counters);
  renderCollection(cards, namespaces, 'namespaces', {});
}
