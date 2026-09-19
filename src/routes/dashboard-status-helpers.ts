// Helpers puros do payload do /dashboard-status.json. Extraídos de
// `dashboard-status-blocks.ts` pela catraca de 400 linhas: aqui só há
// mapeamento de snapshot → bloco, sem I/O e sem estado.
import type { AppServices } from './types.js';

/** Foto de métricas memoizada por ciclo de requisição. */
export type MetricSnapshot = ReturnType<AppServices['metrics']['snapshot']>;

export function releaseIndexStatus(services: AppServices, counters: MetricSnapshot['counters']) {
  return {
    ...services.releaseIndex.status(),
    hits: counters['search.idx.hit'] || 0,
    misses: counters['search.idx.miss'] || 0,
    gaps: counters['search.idx.gap'] || 0,
    servedReleases: counters['search.idx.served'] || 0,
    recordedReleases: counters['search.idx.recorded'] || 0,
    wouldHit: counters['search.idx.wouldHit'] || 0,
    wouldMiss: counters['search.idx.wouldMiss'] || 0,
    wastedQueries: counters['search.jackett.wastedQueries'] || 0,
    wastedMs: counters['search.jackett.wastedMs'] || 0,
    wastedQueriesBackground: counters['search.jackett.wastedQueries.background'] || 0,
    wastedMsBackground: counters['search.jackett.wastedMs.background'] || 0,
    accountSufficient: counters['search.account.sufficient'] || 0,
    fastPaths: counters['search.fastPath'] || 0,
  };
}

/** Tri-estado do serviço Jackett: `naomedido` quando o catálogo veio do .env. */
export function jackettServiceFlag(indexers: { length: number; source?: string }): boolean | 'naomedido' {
  if (indexers?.source !== 'live') return 'naomedido';
  return indexers.length > 0;
}
