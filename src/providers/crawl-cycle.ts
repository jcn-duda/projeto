// Contadores do ciclo da raspagem (extraído de `crawler.ts` pela catraca de
// 400 linhas). Estado volátil de UMA rodada de descoberta+páginas; morre no
// restart de propósito — o durável vive no `crawl.db`.
export interface CycleCounters {
  pages: number; done: number; noTorrent: number; noWork: number; errors: number; simulated: number; partial: number;
  releases: number; newReleases: number; discoveryAdded: number; discoveryRefreshed: number; discoveryFailures: number;
}

export function freshCycle(): CycleCounters {
  return {
    pages: 0, done: 0, noTorrent: 0, noWork: 0, errors: 0, simulated: 0, partial: 0, releases: 0, newReleases: 0,
    discoveryAdded: 0, discoveryRefreshed: 0, discoveryFailures: 0,
  };
}
