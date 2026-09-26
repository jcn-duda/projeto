// Tipos e codec (colunas/parse/render) do banco de magnets vivo. Extraído de
// `magnet-bank-rows.ts` pela catraca de 400 linhas para abrir espaço às
// consultas em LOTE do fallback (`listMagnetsMany`/`listSourcesMany`), que
// evitam o N+1 de `findByWork` no caminho da resposta.
export type MagnetRow = {
  hash: string;
  uri: string;
  title: string;
  size: number;
  isBr: number;
  dubbed: number;
  quality: string;
  seedersMax: number;
  seedersLast: number;
  firstSeen: number;
  lastSeen: number;
  lied: number;
};

export type SourceRow = {
  hash: string;
  indexer: string;
  tracker: string;
  firstSeen: number;
  lastSeen: number;
  seedersLast: number;
};

export type WorkRow = {
  hash: string;
  imdb: string;
  season: number;
  episode: number;
  firstSeen: number;
  lastSeen: number;
  passedFilter: number;
};

export type Batch = { magnets: MagnetRow[]; sources: SourceRow[]; works: WorkRow[] };

/** Agregado por indexer do banco vivo (painel): `hashes` são torrents distintos,
 * `sources` são as observações (uma por indexer+hash) e `lastSeen` é a última
 * vez que aquele indexer entregou qualquer coisa. */
export type IndexerStat = { indexer: string; hashes: number; sources: number; lastSeen: number };

/** Panorama do banco (uma leitura por poll): totais + último visto global +
 * quebra por indexer. A engine SQL resolve com COUNT/MAX/GROUP BY — nunca uma
 * consulta por indexer (sem N+1). `memoryMax`/`memoryEvictions` descrevem o
 * teto da engine de MEMÓRIA: no SQLite (permanente) são `null`/`0`. */
export type BankStats = {
  magnets: number;
  sources: number;
  works: number;
  lastSeen: number;
  byIndexer: IndexerStat[];
  /** Teto de linhas da engine de memória; `null` quando a engine é o SQLite. */
  memoryMax: number | null;
  /** Evictions LRU da engine de memória desde o boot; `0` no SQLite. */
  memoryEvictions: number;
};

export const MAGNET_COLUMNS = [
  'hash', 'uri', 'title', 'size', 'is_br', 'dubbed', 'quality',
  'seeders_max', 'seeders_last', 'first_seen', 'last_seen', 'lied',
];
export const SOURCE_COLUMNS = ['hash', 'indexer', 'tracker', 'first_seen', 'last_seen', 'seeders_last'];
export const WORK_COLUMNS = ['hash', 'imdb', 'season', 'episode', 'first_seen', 'last_seen', 'passed_filter'];

export function renderMagnet(row: MagnetRow): (string | number)[] {
  return [
    row.hash, row.uri, row.title, row.size, row.isBr, row.dubbed, row.quality,
    row.seedersMax, row.seedersLast, row.firstSeen, row.lastSeen, row.lied,
  ];
}
export function renderSource(row: SourceRow): (string | number)[] {
  return [row.hash, row.indexer, row.tracker, row.firstSeen, row.lastSeen, row.seedersLast];
}
export function renderWork(row: WorkRow): (string | number)[] {
  return [row.hash, row.imdb, row.season, row.episode, row.firstSeen, row.lastSeen, row.passedFilter];
}

export function parseMagnet(any: Record<string, unknown>): MagnetRow {
  return {
    hash: String(any.hash || ''),
    uri: String(any.uri || ''),
    title: String(any.title || ''),
    size: Number(any.size) || 0,
    isBr: Number(any.is_br ?? any.isBr) || 0,
    dubbed: Number(any.dubbed) || 0,
    quality: String(any.quality || ''),
    seedersMax: Number(any.seeders_max ?? any.seedersMax) || 0,
    seedersLast: Number(any.seeders_last ?? any.seedersLast) || 0,
    firstSeen: Number(any.first_seen ?? any.firstSeen) || 0,
    lastSeen: Number(any.last_seen ?? any.lastSeen) || 0,
    lied: Number(any.lied) || 0,
  };
}
export function parseSource(any: Record<string, unknown>): SourceRow {
  return {
    hash: String(any.hash || ''),
    indexer: String(any.indexer || ''),
    tracker: String(any.tracker || ''),
    firstSeen: Number(any.first_seen ?? any.firstSeen) || 0,
    lastSeen: Number(any.last_seen ?? any.lastSeen) || 0,
    seedersLast: Number(any.seeders_last ?? any.seedersLast) || 0,
  };
}
export function parseWork(any: Record<string, unknown>): WorkRow {
  return {
    hash: String(any.hash || ''),
    imdb: String(any.imdb || ''),
    season: Number(any.season ?? -1),
    episode: Number(any.episode ?? -1),
    firstSeen: Number(any.first_seen ?? any.firstSeen) || 0,
    lastSeen: Number(any.last_seen ?? any.lastSeen) || 0,
    passedFilter: Number(any.passed_filter ?? any.passedFilter) || 0,
  };
}
