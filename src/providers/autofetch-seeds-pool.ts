import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { pickTopSeededCandidates } from '../utils/format.js';
import type { Stream } from '../../types/domain.js';

// Seleção do pool "seeds" do Chupim (melhor swarm), extraída do runner para
// respeitar o teto de linhas. Dois regimes de relaxamento para minSeeders=1
// (nunca abaixo de 1; o default do piso do operador fica intacto):
//
// - strict VAZIO: fallback do comportamento antigo — o relaxado preenche a
//   capacidade TOTAL (`seedsLimit` = limite imediato + queueDepth), com
//   excedentes indo para a fila persistente (título obscuro: sem isso o
//   cachedOnly deixa a UI vazia para sempre);
// - strict PARCIAL: completa SOMENTE as vagas imediatas que faltam até o
//   limite imediato. Encher a fila inteira de candidatos fracos num caso
//   comum (strict parcial é o comum) enfileiraria até 6 downloads de 1 seeder
//   sem necessidade — a fila relaxada só existe no fallback do strict vazio.
//   Medido ao vivo (The Rejuvenator, 1988): Lime/1337x com 4 seeders
//   preenchiam 1 das 2 vagas e o VHSRip de 1 seeder ficava de fora porque o
//   relaxamento antigo só rodava com o pool VAZIO.
//
// Título RARO (poucos candidatos com swarm, até `rare.threshold`): o limite
// imediato sobe de autoFetchTopSeedsMax para `rare.max`. Com 4-5 alternativas
// de 1-5 seeders, disparar só 2 aposta a obra inteira em dois torrents fracos
// — se os dois empacarem, a lista fica vazia de novo. Em título comum o
// universo passa do limiar e nada muda: a regra não enche a conta à toa.
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
    rare = { max: 0, threshold: 0, maxSeeders: 0 },
  }: {
    season?: number | null;
    queueDepth?: number;
    viable: (s: Stream) => boolean;
    rare?: { max: number; threshold: number; maxSeeders: number };
  },
): { candidates: SeedsStream[]; immediateLimit: number } {
  const seedsOpts = { season, ptFirst: live.autoFetchSeedsPtFirst };
  // `viable` conta `autofetch.seed-floor-skipped` — e os picks seguintes
  // repassam o MESMO universo. Memoize a decisão por stream: cada um é
  // avaliado (e contado) UMA vez aqui dentro; a contagem por pool (br/any/
  // seeds) do runner não muda, porque este wrapper é local ao pool seeds.
  const verdict = new Map<Stream, boolean>();
  const viableOnce = (s: Stream) => {
    let v = verdict.get(s);
    if (v === undefined) {
      v = viable(s);
      verdict.set(s, v);
    }
    return v;
  };

  // Universo com swarm (minSeeders=1, nunca 0): se couber no limiar, o título
  // é raro e o limite imediato sobe. Pede limiar+1 só para saber se passou.
  let immediateLimit = live.autoFetchTopSeedsMax;
  if (rare.threshold > 0 && rare.max > immediateLimit) {
    const universo = pickTopSeededCandidates(liveStreams, new Set(), rare.threshold + 1, {
      ...seedsOpts, minSeeders: 1,
    }).filter(isSeedsStream).filter(viableOnce);
    // Raro = poucos E fracos: o melhor abaixo de maxSeeders. Poucos com enxame
    // saudável terminam sozinhos — baixar o de 1 seeder junto é lixo na conta.
    const melhor = universo.reduce((m, s) => Math.max(m, Number((s as any)._seeders) || 0), 0);
    if (universo.length > 0 && universo.length <= rare.threshold && melhor < rare.maxSeeders) {
      immediateLimit = rare.max;
      metrics.count('autofetch.seeds.rare');
      log.info(`[autofetch] seeds: título raro (${universo.length} candidato(s), melhor com ${melhor} seeder(s)) — até ${immediateLimit} download(s) imediato(s)`);
    }
  }

  const seedsLimit = immediateLimit + queueDepth;
  let candidates = pickTopSeededCandidates(liveStreams, new Set(), seedsLimit, {
    ...seedsOpts, minSeeders: live.autoFetchMinSeeders,
  }).filter(isSeedsStream).filter(viableOnce);
  if (live.autoFetchMinSeeders > 1) {
    const strictEmpty = candidates.length === 0;
    // Capacidade do complemento: TOTAL no fallback do strict vazio; no strict
    // parcial, só as vagas imediatas que faltam até o limite imediato.
    const capacity = strictEmpty
      ? seedsLimit
      : immediateLimit - candidates.length;
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
  return { candidates, immediateLimit };
}
