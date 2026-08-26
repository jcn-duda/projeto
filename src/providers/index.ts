import { autofetchRunnerStatus } from './autofetch-runner.js';
import { applyDebrid } from './debrid-pipeline.js';
import {
  buildStreams, applyNoticeOrigin, onlyNotice, firstObserverStep, createFirstObserver,
  firstObserverClaim, promoteFirstObserverEligible,
} from './stream-builder.js';
import type { FirstObserverState } from './stream-builder.js';
import { findStreams, debridRefreshSatisfied, searchesInFlightCount } from './search-cache.js';
import { idxPoolCovered, poolCovered } from './search-orchestrator.js';

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
