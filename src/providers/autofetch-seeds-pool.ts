import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { pickTopSeededCandidates } from '../utils/format.js';
import type { Stream } from '../../types/domain.js';

// Seleção do pool "seeds" do Chupim (melhor swarm), extraída do runner para
// respeitar o teto de linhas. Dois regimes de relaxamento para minSeeders=1
// (nunca abaixo de 1; o default do piso do operador fica intacto):
//
// - strict VAZIO: fallback do comportamento antigo — o relaxado preenche a
//   capacidade TOTAL (`seedsLimit` = autoFetchTopSeedsMax + queueDepth), com
//   excedentes indo para a fila persistente (título obscuro: sem isso o
//   cachedOnly deixa a UI vazia para sempre);
// - strict PARCIAL: completa SOMENTE as vagas imediatas que faltam até
//   autoFetchTopSeedsMax. Encher a fila inteira de candidatos fracos num caso
//   comum (strict parcial é o comum) enfileiraria até 6 downloads de 1 seeder
//   sem necessidade — a fila relaxada só existe no fallback do strict vazio.
//   Medido ao vivo (The Rejuvenator, 1988): Lime/1337x com 4 seeders
//   preenchiam 1 das 2 vagas e o VHSRip de 1 seeder ficava de fora porque o
//   relaxamento antigo só rodava com o pool VAZIO.
//
// Dedupe por hash: o que o strict escolheu não reaparece como complemento.

type SeedsStream = Stream & { infoHash: string };

function isSeedsStream(stream: Stream): stream is SeedsStream {
  return typeof stream.infoHash === 'string' && stream.infoHash.length > 0;
}

export function pickSeedsPool(
  liveStreams: Stream[],
  live: {
    autoFetchMinSeeders: number;
    autoFetchTopSeedsMax: number;
    autoFetchSeedsPtFirst: boolean;
  },
  {
    season = null,
    queueDepth = 0,
    viable,
  }: { season?: number | null; queueDepth?: number; viable: (s: Stream) => boolean },
): SeedsStream[] {
  const seedsLimit = live.autoFetchTopSeedsMax + queueDepth;
  const seedsOpts = { season, ptFirst: live.autoFetchSeedsPtFirst };
  // `viable` conta `autofetch.seed-floor-skipped` — e o pick relaxado repassa
  // o MESMO universo. Memoize a decisão por stream: cada um é avaliado (e
  // contado) UMA vez aqui dentro; a contagem por pool (br/any/seeds) do
  // runner não muda, porque este wrapper é local ao pool seeds.
  const verdict = new Map<Stream, boolean>();
  const viableOnce = (s: Stream) => {
    let v = verdict.get(s);
    if (v === undefined) {
      v = viable(s);
      verdict.set(s, v);
    }
    return v;
  };
  let candidates = pickTopSeededCandidates(liveStreams, new Set(), seedsLimit, {
    ...seedsOpts, minSeeders: live.autoFetchMinSeeders,
  }).filter(isSeedsStream).filter(viableOnce);
  if (live.autoFetchMinSeeders > 1) {
    const strictEmpty = candidates.length === 0;
    // Capacidade do complemento: TOTAL no fallback do strict vazio; no strict
    // parcial, só as vagas imediatas que faltam até autoFetchTopSeedsMax.
    const capacity = strictEmpty
      ? seedsLimit
      : live.autoFetchTopSeedsMax - candidates.length;
    if (capacity > 0) {
      const chosen = new Set(candidates.map((s) => String(s.infoHash || '').toLowerCase()));
      const relaxed = pickTopSeededCandidates(liveStreams, new Set(), seedsLimit, {
        ...seedsOpts, minSeeders: 1,
      }).filter(isSeedsStream).filter(viableOnce)
        .filter((s) => !chosen.has(String(s.infoHash || '').toLowerCase()))
        .slice(0, capacity);
      if (relaxed.length > 0) {
        candidates = [...candidates, ...relaxed];
        metrics.count('autofetch.top-seeded-relaxed');
        metrics.count('autofetch.top-seeded-relaxed.added', relaxed.length);
        log.info(`[autofetch] seeds: pool estrito ${strictEmpty ? 'vazio' : 'parcial'} complementado com ${relaxed.length} candidato(s) minSeeders=1`);
      }
    }
  }
  return candidates;
}
