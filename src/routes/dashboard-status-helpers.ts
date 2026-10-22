// Helpers puros do payload do /dashboard-status.json. Extraídos de
// `dashboard-status-blocks.ts` pela catraca de 400 linhas: aqui só há
// mapeamento de snapshot → bloco, sem I/O e sem estado.
import type { AppServices } from './types.js';
import {
  nativeReleaseIndexCounters,
  type NativeMetrics,
  type NativeReleaseIndexCounters,
} from '../utils/native-metrics.js';

/** Foto de métricas memoizada por ciclo de requisição. */
export type MetricSnapshot = ReturnType<AppServices['metrics']['snapshot']>;

/**
 * Bloco `metrics` com a leitura nativa ADITIVA (Fase 0.7). O contrato antigo
 * (`uptimeS`/`counters`/`gauges`/`timers`/`eventLoop`) fica intacto; `native`
 * só existe quando alguma superfície do Rust respondeu — sem resposta, omitir
 * é a resposta honesta (zero inventado nunca).
 */
export function panelMetrics(snapshot: MetricSnapshot, native: NativeMetrics | null) {
  return native ? { ...snapshot, native } : snapshot;
}

/**
 * `search.first.*` não tem produtor: o `/stream` saiu do Node e o Rust não
 * portou o primeiro resultado (`search_budget_metadata.rs` registra a lacuna).
 * Os campos numéricos ficam pelo contrato, mas o KPI se declara NÃO MEDIDO em
 * vez de fingir zero.
 */
export const SEARCH_FIRST_UNAVAILABLE = {
  available: false,
  source: 'nativo-ausente',
  reason: 'o /stream responde no gateway Rust e `search.first.*` não tem contrapartida nativa',
} as const;

export function searchFirstBlock(counters: MetricSnapshot['counters']) {
  return {
    responses: counters['search.first.responses'] || 0,
    brFound: counters['search.first.brFound'] || 0,
    brCached: counters['search.first.brCached'] || 0,
    brHidden: counters['search.first.brHidden'] || 0,
    brVisible: counters['search.first.brVisible'] || 0,
    brLate: counters['search.first.brLate'] || 0,
    ...SEARCH_FIRST_UNAVAILABLE,
  };
}

/** Campo com contrapartida nativa: o Rust vence quando mediu; senão, o Node. */
function pick(
  bridged: NativeReleaseIndexCounters,
  field: keyof NativeReleaseIndexCounters,
  nodeValue: number,
): number {
  const value = bridged[field];
  return typeof value === 'number' ? value : nodeValue;
}

export function releaseIndexStatus(
  services: AppServices,
  counters: MetricSnapshot['counters'],
  native: NativeMetrics | null = null,
) {
  // Só cinco campos têm contrapartida nativa (`index.rust.*`). Os demais
  // (wouldHit/wasted*/accountSufficient/fastPaths) seguem do Node: sem fonte
  // nativa, não se inventa número.
  const bridged = nativeReleaseIndexCounters(native?.counters);
  return {
    ...services.releaseIndex.status(),
    hits: pick(bridged, 'hits', counters['search.idx.hit'] || 0),
    misses: pick(bridged, 'misses', counters['search.idx.miss'] || 0),
    gaps: pick(bridged, 'gaps', counters['search.idx.gap'] || 0),
    servedReleases: pick(bridged, 'servedReleases', counters['search.idx.served'] || 0),
    recordedReleases: pick(bridged, 'recordedReleases', counters['search.idx.recorded'] || 0),
    wouldHit: counters['search.idx.wouldHit'] || 0,
    wouldMiss: counters['search.idx.wouldMiss'] || 0,
    wastedQueries: counters['search.jackett.wastedQueries'] || 0,
    wastedMs: counters['search.jackett.wastedMs'] || 0,
    wastedQueriesBackground: counters['search.jackett.wastedQueries.background'] || 0,
    wastedMsBackground: counters['search.jackett.wastedMs.background'] || 0,
    accountSufficient: counters['search.account.sufficient'] || 0,
    fastPaths: counters['search.fastPath'] || 0,
    // De onde vieram hits/misses/gaps/served/recorded neste payload.
    source: Object.keys(bridged).length ? 'nativo' : 'node',
  };
}

/** Tri-estado do serviço Jackett: `naomedido` quando o catálogo veio do .env. */
export function jackettServiceFlag(indexers: readonly { virtual?: boolean }[] & { source?: string }): boolean | 'naomedido' {
  if (indexers?.source !== 'live') return 'naomedido';
  // O card virtual do Mico não prova que o Jackett tem indexer.
  return indexers.some((item) => !item?.virtual);
}
