import type { Stream } from '../../types/domain.js';
import { relabel } from './stream-relabel.js';
import type { StreamTraceState } from './stream-trace.js';
import {
  DUBBED_QUALITY_WEIGHT,
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
} from './autofetch-pools.js';
import type { PoolsOptions, AutofetchTargetQuality } from './autofetch-pools.js';
import { rustDedupeByHash, rustSortAndLimit } from './rust-stream-ranking.js';
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

interface SortOptions {
  minSeeders?: number;
  maxResults?: number;
  qualityFilter?: string[];
  season?: number | null;
  episode?: number | null;
  preferDubbed?: boolean;
  dubbedOnly?: boolean;
  excludeCam?: boolean;
  maxSizeGb?: number;
  qualityLimits?: Partial<Record<string, number>>;
  brReservedSlots?: number;
  brReservedPerQuality?: number;
  candidateFactor?: number;
  brFirst?: boolean;
  indexerPriority?: string[];
  instant?: ((hash: string) => boolean) | null;
  /** P5 — ledger observacional; os cortes desta função ficam registrados. */
  trace?: StreamTraceState | null;
}

/**
 * Mesma release aparece em vários indexers; fica a de maior seeders. A regra
 * (idoneidade, seeders, dublado, prioridade, herança BR de espelho) é do Rust.
 */
function dedupeByHash(streams: any[], indexerPriority: string[] = [], trace?: StreamTraceState | null) {
  return rustDedupeByHash(streams, indexerPriority, trace) as any[];
}

/**
 * Dedupe + piso de seeders (com waiver BR dublado) + filtros + pool com vagas
 * BR, no Rust (`rust-stream-ranking.ts`). Os cortes entram no `trace`.
 */
function sortAndLimit(streams: (Stream | null)[], options: SortOptions = {}) {
  // Mesmo contrato de antes (`any[]`): a saída carrega os campos internos `_*`
  // que o limitReservingBr ainda lê e apaga.
  return rustSortAndLimit(streams, options) as any[];
}

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
  relabel,
  dedupeByHash,
  sortAndLimit,
};

export type { SortOptions, PoolsOptions, AutofetchOptions, AutofetchTargetQuality };
