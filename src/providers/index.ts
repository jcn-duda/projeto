import { autofetchRunnerStatus } from './autofetch-runner.js';
import { applyDebrid } from './debrid-pipeline.js';
import { buildStreams, applyNoticeOrigin, onlyNotice } from './stream-builder.js';
import {
  firstObserverStep, createFirstObserver, firstObserverClaim, promoteFirstObserverEligible,
} from './first-observer.js';
import type { FirstObserverState } from './first-observer.js';
import { findStreams, debridRefreshSatisfied, searchesInFlightCount } from './search-cache.js';
import { idxPoolCovered, poolCovered } from './search-pool-coverage.js';

/** Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário. */
function autofetchStatus() {
  return {
    ...autofetchRunnerStatus(),
    searchesInFlight: searchesInFlightCount(),
  };
}

export {
  findStreams, applyDebrid, buildStreams, debridRefreshSatisfied, applyNoticeOrigin, onlyNotice,
  autofetchStatus, idxPoolCovered, poolCovered, firstObserverStep, createFirstObserver,
  firstObserverClaim, promoteFirstObserverEligible,
};
export type { FirstObserverState };
