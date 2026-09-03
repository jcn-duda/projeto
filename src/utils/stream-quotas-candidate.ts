import type { StreamCandidate } from '../../types/domain.js';
import { UNKNOWN_QUALITY, qualityFromTitle } from './audio-quality.js';

const QUALITY_KEYS = ['2160p', '1080p', '720p', '480p', 'SD', UNKNOWN_QUALITY];
type QualityLimits = Partial<Record<string, number>>;

function streamQuality(stream: StreamCandidate) {
  return stream?._quality || qualityFromTitle(stream?.title || stream?.name || '');
}

/**
 * Separa espaço no pool pré-debrid para cada qualidade configurada. Sem isso,
 * centenas de 4K poderiam ocupar o pool inteiro e impedir que a cota pedida de
 * 1080p tivesse candidatos para sobreviver ao filtro de cache.
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
    indexerPriority = [],
  } = {},
) {
  const poolSize = Math.max(0, Math.trunc(maxResults));
  const custom = QUALITY_KEYS.filter((quality: string) => Number(qualityLimits[quality]) < 100);
  const customSet = new Set(custom);
  // Os mapas abaixo são populados para TODA qualidade de `custom` na criação,
  // então `.get(quality)` nunca devolve undefined quando `quality` pertence a
  // `custom`. O strictNullChecks não enxerga esse invariante; os casts
  // documentam a garantia sem mudar runtime.
  const buckets = new Map<string, StreamCandidate[]>(custom.map((quality) => [quality, []]));
  for (const stream of streams) {
    const bucket = buckets.get(streamQuality(stream));
    if (bucket) bucket.push(stream);
  }

  const selected = new Set();
  const positions = new Map<string, number>(custom.map((quality) => [quality, 0]));
  const counts = new Map<string, number>(custom.map((quality) => [quality, 0]));
  const factor = Math.max(1, Math.trunc(candidateFactor));
  const targets = new Map<string, number>(
    custom.map((quality) => [
      quality,
      Math.max(0, Math.trunc(Number(qualityLimits[quality]) || 0)) * factor,
    ]),
  );

  // A reserva precisa existir também quando a qualidade está em 100. Se os BR
  // forem considerados só no corte final, seeders globais podem preencher o
  // pool ampliado antes deles chegarem ao debrid.
  const brTarget = brFirst ? poolSize : brReservedSlots;

  // Reserva por faixa: sem ela, BR de 1080p abundante consumia as vagas BR na
  // ordem em que chegam e a faixa 4K/720p ficava sem BR no pool pré-debrid —
  // o corte final nunca vê candidato que aqui foi cortado.
  const perFaixa = Math.max(0, Math.trunc(Number(brReservedPerQuality) || 0));
  if (perFaixa > 0) {
    const faixaCounts = new Map<string, number>();
    for (const stream of streams) {
      if (selected.size >= poolSize || selected.size >= brTarget) break;
      if (!stream._br || selected.has(stream)) continue;
      const quality = streamQuality(stream);
      const usados = faixaCounts.get(quality) || 0;
      if (usados >= perFaixa) continue;
      if (customSet.has(quality) &&
        (counts.get(quality) as number) >= (targets.get(quality) as number)) continue;
      faixaCounts.set(quality, usados + 1);
      selected.add(stream);
      if (customSet.has(quality)) counts.set(quality, (counts.get(quality) as number) + 1);
    }
  }

  for (const stream of streams) {
    if (selected.size >= poolSize || selected.size >= brTarget) break;
    if (!stream._br || selected.has(stream)) continue;
    const quality = streamQuality(stream);
    if (customSet.has(quality) &&
      (counts.get(quality) as number) >= (targets.get(quality) as number)) continue;
    selected.add(stream);
    if (customSet.has(quality)) counts.set(quality, (counts.get(quality) as number) + 1);
  }

  // Round-robin evita que a primeira qualidade consuma todo o pool quando a
  // soma das cotas configuradas ultrapassa o máximo global.
  let progressed = true;
  while (selected.size < poolSize && progressed) {
    progressed = false;
    for (const quality of custom) {
      const bucket = buckets.get(quality) as StreamCandidate[];
      let position = positions.get(quality) as number;
      while (position < bucket.length && selected.has(bucket[position])) position += 1;
      positions.set(quality, position);
      if ((counts.get(quality) as number) >= (targets.get(quality) as number)) continue;
      if (position >= bucket.length) continue;
      selected.add(bucket[position]);
      positions.set(quality, position + 1);
      counts.set(quality, (counts.get(quality) as number) + 1);
      progressed = true;
      if (selected.size >= poolSize) break;
    }
  }

  // Qualidades em 100 são ilimitadas e preenchem o espaço restante sem tomar
  // as vagas já separadas para as cotas explícitas.
  for (const stream of streams) {
    if (selected.size >= poolSize) break;
    if (selected.has(stream)) continue;
    if (customSet.has(streamQuality(stream))) continue;
    selected.add(stream);
  }

  // A seleção reserva espaço, mas a ordem original de qualidade/seeders segue
  // intacta para a listagem e para o debrid.
  return streams.filter((stream) => selected.has(stream));
}

export {
  QUALITY_KEYS,
  streamQuality,
  selectQualityCandidates,
};

export type {
  QualityLimits,
};
