export type IndexedRelease = {
  hash: string;
  title: string;
  size: number | null;
  indexer: string;
  isBr: boolean;
  dubbed: boolean;
  quality: string;
  seeders: number;
  seenAt: number;
  /** Prova por arquivo real: o post prometia PT, mas era release EN. */
  lied?: boolean;
  /** Submissão do Chupim é visível, mas não declara cobertura da obra. */
  source?: 'autofetch';
};

export type IndexEntry = { at: number; releases: IndexedRelease[]; partial?: boolean };
export type ObraLocation = { season?: number | null; episode?: number | null };
