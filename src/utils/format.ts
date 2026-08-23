/**
 * PLANO_MELHORIAS 5.3: format.ts virou barrel de reexport depois do split em
 * 7 submódulos (title-normalization, release-matching, episode-matching,
 * audio-quality, stream-ranking, stream-quotas, search-names). Mantém os
 * mesmos 57 nomes exportados de antes, para os ~19 arquivos de teste e os
 * consumidores em src/providers/ e src/debrid/ que importam daqui não
 * precisarem mudar. A remoção do barrel (migrar cada consumidor para o
 * submódulo direto) é decisão posterior, com grep de uso.
 */
export { bytesToSize, extractInfoHash, decodeEntities, normalizeTitle } from './title-normalization.js';

export {
  matchesEpisode,
  parseTitleSeasonEpisode,
  seasonCoverageExcludes,
  isSeasonPackRelease,
  isSeasonPackFillEligible,
} from './episode-matching.js';

export {
  matchesName,
  matchesBrTitle,
  matchesEpisodeWorkIdentity,
  isMultiWorkCollection,
  franchiseRoot,
  franchiseRoots,
  containsTokenRun,
  filterInventoryRelevant,
  filterRelevantRaw,
  magnetYearContradicts,
} from './release-matching.js';

export {
  UNKNOWN_QUALITY,
  stripQualityTagBlob,
  qualityFromTitle,
  sourceFromTitle,
  editionFromTitle,
  explicitPtAudio,
  hasPtAudioMark,
  strongEnSceneMark,
  dubbedLieVerdict,
  audioFromTitle,
  hasExplicitForeignAudio,
  looksPtBr,
} from './audio-quality.js';

export {
  QUALITY_KEYS,
  selectQualityCandidates,
  limitByIndexer,
  limitByQuality,
  limitReservingBr,
} from './stream-quotas.js';

export {
  TRACKERS,
  streamDisplayName,
  markDebridName,
  matchesQualityFilter,
  passesQualityFilter,
  toStremioStream,
  resolveSearchNames,
  parseStremioId,
  buildSearchQuery,
  numeralSearchVariant,
} from './search-names.js';

export {
  dedupeByHash,
  sortAndLimit,
  pickBrDubbedCandidate,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  topSeededPool,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
} from './stream-ranking.js';
