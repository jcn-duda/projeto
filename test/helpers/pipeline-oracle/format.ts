// Barril do que saiu de `src/utils/format.ts` na fase 1 (ranking, cotas,
// nome do stream e a fábrica `toStremioStream`). Sem chamador em produção:
// o gateway monta a lista; os testes e o oráculo seguem medindo a régua TS,
// que chama o núcleo pelo napi.
export { dedupeByHash, sortAndLimit } from './stream-ranking.js';
export type { SortOptions } from './stream-ranking.js';
export { relabel } from './stream-relabel.js';
export { streamDisplayName } from './stream-display.js';
export type { StreamDisplayOptions } from './stream-display.js';
export { limitByIndexer, limitByQualityAndIndexer, limitByQuality, limitReservingBr } from './stream-quotas.js';
export type { LimitBrOptions } from './stream-quotas.js';
export { toStremioStream } from './to-stremio-stream.js';
export { buildRankingInput, rustSortAndLimit, rustDedupeByHash } from './rust-stream-ranking.js';
export type { RankingCore, RankingInputNapi, RankingOutputNapi, SortOptionsLike } from './rust-stream-ranking.js';

// Vocabulário de títulos/áudio/nomes: o antigo barrel de `src/utils/format.ts`.
// A régua decide no núcleo; estes wrappers só servem à suíte.
export { bytesToSize, extractInfoHash, decodeEntities, normalizeTitle, stripDiacritics } from '../../../src/utils/title-normalization.js';

export {
  matchesEpisode,
  parseTitleSeasonEpisode,
  seasonCoverageExcludes,
  isSeasonPackRelease,
  isSeasonPackFillEligible,
} from './episode-matching.js';

export {
  matchesName,
  nameCoverageTokens,
  matchesShortNameIdentity,
  shortNameIdentity,
  matchesBrTitle,
  matchesEpisodeWorkIdentity,
  matchesGlobalSeriesNoMarker,
  isMultiWorkCollection,
  franchiseRoot,
  endsWithSequenceMarker,
  containsTokenRun,
  filterInventoryRelevant,
  filterRelevantRaw,
  magnetYearContradicts,
  magnetSeasonContradicts,
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
  streamQuality,
  selectQualityCandidates,
} from './stream-quotas-candidate.js';

export {
  TRACKERS,
  markDebridName,
  matchesQualityFilter,
  passesQualityFilter,
  resolveSearchNames,
  resolveOriginalStepName,
  parseStremioId,
  buildSearchQuery,
  numeralSearchVariant,
} from './search-names.js';
