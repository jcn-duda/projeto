// Barril dos picks do autofetch (pools, alvos de qualidade e seleção BR).
// O ranking da lista (dedupe/sortAndLimit) é do gateway; a casca TS dele foi
// para o oráculo de teste na fase 1.
import {
  DUBBED_QUALITY_WEIGHT,
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
} from './autofetch-pools.js';
import type { PoolsOptions, AutofetchTargetQuality } from './autofetch-pools.js';
import {
  hashSet,
  pickFromPool,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
  cachedBrDubbedTargetQualities,
  pickBrDubbedCandidate,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  hasCachedAnyDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
} from './autofetch-picks.js';
import type { AutofetchOptions } from './autofetch-picks.js';

export {
  DUBBED_QUALITY_WEIGHT,
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
  hashSet,
  pickFromPool,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
  cachedBrDubbedTargetQualities,
  pickBrDubbedCandidate,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  hasCachedAnyDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
};

export type { PoolsOptions, AutofetchOptions, AutofetchTargetQuality };
