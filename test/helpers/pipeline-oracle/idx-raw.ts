// Release do índice → item cru que o `toStremioStream` do oráculo consome.
// Saiu de `src/providers/search-pool-coverage.ts`: o gateway lê o índice e
// monta a lista no núcleo, e só os testes de integração índice→oráculo ainda
// precisam desta cola.
export function idxReleasesToRaw(releases: any[]) {
  return releases.map((r) => ({
    title: r.title,
    infoHash: r.hash,
    seeders: r.seeders,
    size: r.size ?? undefined,
    indexer: r.indexer,
    tracker: r.tracker || r.indexer,
    isBr: r.isBr,
    dubbed: r.dubbed,
    lied: Boolean(r.lied),
    quality: r.quality,
    indexSource: r.source,
    mediaSource: r.mediaSource,
  }));
}
