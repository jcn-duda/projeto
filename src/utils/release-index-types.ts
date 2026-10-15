export type IndexedRelease = {
  hash: string;
  title: string;
  size: number | null;
  indexer: string;
  /** Rótulo real da fonte (ex.: ThePirateBay no pool Torrentio). Não confundir com `indexer`. */
  tracker?: string;
  isBr: boolean;
  dubbed: boolean;
  quality: string;
  seeders: number;
  seenAt: number;
  /** Prova por arquivo real: o post prometia PT, mas era release EN. */
  lied?: boolean;
  /** Submissão do Chupim é visível, mas não declara cobertura da obra. */
  source?: 'autofetch';
  /** BluRay/WEB-DL/CAM (sourceFromTitle). NÃO confundir com `source` (origem da entrada). */
  mediaSource?: string;
};

export type IndexEntry = { at: number; releases: IndexedRelease[]; partial?: boolean };
export type ObraLocation = { season?: number | null; episode?: number | null };
