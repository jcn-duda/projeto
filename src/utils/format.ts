/**
 * PLANO_MELHORIAS 5.3: format.ts virou barrel de reexport depois do split em
 * 7 submódulos (title-normalization, release-matching, episode-matching,
 * audio-quality, stream-quotas, stream-ranking, search-names). É a API pública
 * de conveniência: 70 nomes, 99 consumidores (src/, test/, resolvers/) — a
 * remoção (migrar cada consumidor para o submódulo direto) é decisão posterior,
 * com grep de uso. O barrel NÃO guarda cópia: todo nome reexportado existe no
 * módulo de origem, muitos deles hoje wrappers finos do núcleo Rust. Reexport
 * morto (símbolo que saiu) quebra o typecheck, então o gate é o próprio tsc.
 */
export { bytesToSize, extractInfoHash, decodeEntities, normalizeTitle, stripDiacritics } from './title-normalization.js';

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

export {
  pickBrDubbedCandidate,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
  cachedBrDubbedTargetQualities,
  isAutofetchTargetQuality,
  AUTOFETCH_TARGET_QUALITIES,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  topSeededPool,
  hasCachedBrDubbed,
  hasCachedAnyDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
} from './stream-ranking.js';
