// Barril dos picks do autofetch (pools, alvos de qualidade e seleção BR).
// Era `src/utils/stream-ranking.ts`: saiu de `src/` porque, desde o corte do
// Chupim (B4) e da família `obra`, nenhum caminho de produção chama estes
// nomes — a seleção é do worker nativo. Fica para os testes e os geradores de
// golden medirem a régua TS congelada.
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
