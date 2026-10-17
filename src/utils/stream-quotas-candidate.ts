import type { StreamCandidate } from '../../types/domain.js';
import { UNKNOWN_QUALITY, qualityFromTitle } from './audio-quality.js';
import { nativeCore } from './native-core.js';
import { coreJson } from './native-json.js';

const QUALITY_KEYS = ['2160p', '1080p', '720p', '480p', 'SD', UNKNOWN_QUALITY];
type QualityLimits = Partial<Record<string, number>>;

function streamQuality(stream: StreamCandidate) {
  return stream?._quality || qualityFromTitle(stream?.title || stream?.name || '');
}

/** Um stream como as cotas do núcleo o leem (`streamQuality` + reserva BR). */
function quotaStreamInput(stream: StreamCandidate) {
  return {
    // `qualityFromTitle` do núcleo lê o título; `name` é o fallback do TS.
    title: stream?.title || stream?.name || '',
    quality: stream?._quality,
    indexer: stream?._indexer,
    isBr: Boolean(stream?._br),
    isDubbed: Boolean(stream?._dubbed),
    isDubClaim: Boolean(stream?._dubClaim),
    isLied: Boolean(stream?._lied),
  };
}

type CandidateCore = { selectQualityCandidatesNapi(input: string): string };

/**
 * Separa espaço no pool pré-debrid para cada qualidade configurada. Sem isso,
 * centenas de 4K poderiam ocupar o pool inteiro e impedir que a cota pedida de
 * 1080p tivesse candidatos para sobreviver ao filtro de cache. A regra (reserva
 * BR global e por faixa, round-robin das cotas, ilimitadas no fim) é do núcleo
 * (`adom_core::select_quality_candidates`); a ordem original é preservada.
 */
function selectQualityCandidates(
  streams: StreamCandidate[],
  {
    maxResults = 40,
    qualityLimits = {} as QualityLimits,
    brReservedSlots = 0,
    brReservedPerQuality = 0,
    candidateFactor = 1,
    brFirst = true,
  }: {
    maxResults?: number;
    qualityLimits?: QualityLimits;
    brReservedSlots?: number;
    brReservedPerQuality?: number;
    candidateFactor?: number;
    brFirst?: boolean;
    indexerPriority?: string[];
  } = {},
) {
  const kept = JSON.parse(nativeCore<CandidateCore>().selectQualityCandidatesNapi(coreJson({
    streams: streams.map(quotaStreamInput),
    opts: { maxResults, qualityLimits, brReservedSlots, brReservedPerQuality, candidateFactor, brFirst },
  }))) as number[];
  return kept.map((index) => streams[index]);
}

export {
  QUALITY_KEYS,
  streamQuality,
  quotaStreamInput,
  selectQualityCandidates,
};

export type {
  QualityLimits,
};
