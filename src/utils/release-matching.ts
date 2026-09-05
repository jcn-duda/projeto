/**
 * release-matching.ts — fachada do matching de releases pós-divisão em quatro
 * módulos coesos (todos <=400 linhas, teto de 400 por arquivo):
 *
 * - `matching-vocabulary.ts` — vocabulário fechado de tokens e marcas
 *   (PACK_WORDS, TECH_NOISE, LEADING_ARTICLES, EPISODE_TOKEN, ano-faixa,
 *   pack forte…) compartilhado pelo matching e pelo áudio;
 * - `matching-tokens.ts` — leitura estrutural de tokens: sequência
 *   (`extractSequenceMarkers`), precisão (`titlePrecision`), recorte de obra
 *   por episódio (`episodeWorkTokens`) e a regra única de ano
 *   (`yearContradicts`);
 * - `release-name-matching.ts` — cobertura de busca e franquia: `matchesName`,
 *   `isMultiWorkCollection`, `franchiseRoot(s)`, `containsTokenRun`;
 * - `release-title-rules.ts` — os portões compostos: `matchesTitleStructure`,
 *   `matchesBrTitle`, `matchesEpisodeWorkIdentity`,
 *   `matchesGlobalSeriesNoMarker`;
 * - `release-filters.ts` — filtros em lote sobre RawItem: `filterRelevantRaw`,
 *   `filterInventoryRelevant`, `magnetYearContradicts`.
 *
 * Este arquivo reexporta os MESMOS nomes de antes do split, na mesma ordem,
 * para que `format.ts` (barrel), `audio-quality.ts` e `search-names.ts` — que
 * importam daqui — não precisem mudar. O contrato público é este export list;
 * mover um nome daqui sem atualizar o barrel é quebra.
 */
import { TECH_NOISE, LEADING_ARTICLES } from './matching-vocabulary.js';
import { yearContradicts } from './matching-tokens.js';
import {
  matchesName,
  isMultiWorkCollection,
  franchiseRoot,
  franchiseRoots,
  endsWithSequenceMarker,
  containsTokenRun,
} from './release-name-matching.js';
import {
  matchesTitleStructure,
  matchesBrTitle,
  matchesEpisodeWorkIdentity,
  matchesGlobalSeriesNoMarker,
} from './release-title-rules.js';
import {
  filterRelevantRaw,
  filterInventoryRelevant,
  magnetYearContradicts,
} from './release-filters.js';

export {
  TECH_NOISE,
  LEADING_ARTICLES,
  matchesName,
  matchesBrTitle,
  matchesTitleStructure,
  matchesEpisodeWorkIdentity,
  matchesGlobalSeriesNoMarker,
  yearContradicts,
  isMultiWorkCollection,
  franchiseRoot,
  franchiseRoots,
  endsWithSequenceMarker,
  containsTokenRun,
  filterInventoryRelevant,
  filterRelevantRaw,
  magnetYearContradicts,
};
