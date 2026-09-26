// Corte do teto por obra do índice de releases — irmão extraído de
// release-index.ts pela catraca de linhas. O pai chama cutProtected() no
// record(); lookup e gravação continuam lá.
//
// `max` chega já normalizado (>= 1) pelo pai.
//
// Proteção BR/dublado: nunca caem pelo relógio — o colhedor é o único caminho
// de volta para um global expulso —, mas não podem ocupar TODAS as vagas: numa
// obra com mais BR do que o teto de proteção (série longa), sem limite nenhum
// global recém-visto entrava — só BR mais novo substituía BR. O excedente
// protegido ainda preenche o que sobrar (obra que só tem BR não encolhe); o
// que não couber vira métrica (`search.idx.protCap`).
import * as metrics from './metrics.js';
import type { IndexedRelease } from './release-index-types.js';

export function cutProtected(values: Iterable<IndexedRelease>, max: number): IndexedRelease[] {
  const protectedCap = Math.max(1, Math.floor(max * 2 / 3));
  const ordered = [...values]
    .sort((a, b) => Number(b.isBr || b.dubbed) - Number(a.isBr || a.dubbed)
      || b.seenAt - a.seenAt || b.seeders - a.seeders);
  const releases: IndexedRelease[] = [];
  const protectedBlocked: IndexedRelease[] = [];
  let protectedKept = 0;
  for (const rel of ordered) {
    if (releases.length >= max) break;
    if (!rel.isBr && !rel.dubbed) {
      releases.push(rel);
      continue;
    }
    if (protectedKept < protectedCap) {
      protectedKept += 1;
      releases.push(rel);
    } else {
      protectedBlocked.push(rel);
    }
  }
  // Vagas ociosas vão para o excedente protegido: o teto existe para o global
  // não morrer de fome, não para encolher uma obra que só tem BR.
  let protectedDropped = 0;
  for (const rel of protectedBlocked) {
    if (releases.length < max) releases.push(rel);
    else protectedDropped += 1;
  }
  if (protectedDropped > 0) metrics.count('search.idx.protCap', protectedDropped);
  return releases;
}
