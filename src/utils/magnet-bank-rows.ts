// Banco de magnets vivo — CAMADA DE LINHAS E ENGINE.
//
// Por que um SQLite PRÓPRIO (`data/magnets.db`) e não o cache (`cache.ts`)? O
// cache tem cota, TTL e bump de namespace — ele DESTRÓI conhecimento. Aqui
// guardamos o ACERVO: todo magnet que o Jackett já devolveu, com URI, título,
// tamanho, seeders, marcas BR/dublado e a obra/episódio de cada busca. Se um
// site cair, o que ele entregou continua no banco para a revalidação (Etapa 4).
// Sem cota, sem TTL e sem versão de namespace.
//
// Segue o MESMO padrão defensivo do cache/catálogo: `node:sqlite` carregado
// lazy com `createRequire` e, se o runtime não tiver o módulo (Node 20) ou a
// abertura falhar, o módulo segue SÓ EM MEMÓRIA com um Map e loga warn — nunca
// derruba o addon. Dois motores (SQL e memória) com os mesmos verbos, para quem
// lê não depender do engine.
//
// Tabelas (a especificação da feature):
//   magnet        — uma linha por torrent (PK hash), o conteúdo compartilhado;
//   magnet_source — de ONDE veio (PK hash,indexer);
//   magnet_work   — PARA QUAL busca apareceu (PK hash,imdb,season,episode).
// `season`/`episode` usam -1 para nulo (parte da PK; SQLite não aceita NULL em
// PRIMARY KEY de forma confiável para o nosso caso).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import config from '../config.js';
import { DEFAULT_MAGNET_BANK_DB_PATH } from '../config/helpers.js';
import * as log from './logger.js';

const _require = createRequire(import.meta.url);

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

export interface Engine {
  readonly kind: 'sql' | 'memory';
  getMagnet(hash: string): MagnetRow | null;
  getSource(hash: string, indexer: string): SourceRow | null;
  getWork(hash: string, imdb: string, season: number, episode: number): WorkRow | null;
  listSources(hash: string): SourceRow[];
  listWorks(hash: string): WorkRow[];
  listWorksByObra(imdb: string, season: number, episode: number, limit: number): WorkRow[];
  listSourcesByIndexer(indexer: string, limit: number): SourceRow[];
  writeBatch(batch: Batch): number;
  countMagnets(): number;
  countSources(): number;
  countWorks(): number;
  clearRows(): void;
  closeEngine(): void;
}

const MAGNET_COLUMNS = [
  'hash', 'uri', 'title', 'size', 'is_br', 'dubbed', 'quality',
  'seeders_max', 'seeders_last', 'first_seen', 'last_seen', 'lied',
];
const SOURCE_COLUMNS = ['hash', 'indexer', 'tracker', 'first_seen', 'last_seen', 'seeders_last'];
const WORK_COLUMNS = ['hash', 'imdb', 'season', 'episode', 'first_seen', 'last_seen', 'passed_filter'];

function renderMagnet(row: MagnetRow): (string | number)[] {
  return [
    row.hash, row.uri, row.title, row.size, row.isBr, row.dubbed, row.quality,
    row.seedersMax, row.seedersLast, row.firstSeen, row.lastSeen, row.lied,
  ];
}
function renderSource(row: SourceRow): (string | number)[] {
  return [row.hash, row.indexer, row.tracker, row.firstSeen, row.lastSeen, row.seedersLast];
}
function renderWork(row: WorkRow): (string | number)[] {
  return [row.hash, row.imdb, row.season, row.episode, row.firstSeen, row.lastSeen, row.passedFilter];
}

function parseMagnet(any: Record<string, unknown>): MagnetRow {
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
function parseSource(any: Record<string, unknown>): SourceRow {
  return {
    hash: String(any.hash || ''),
    indexer: String(any.indexer || ''),
    tracker: String(any.tracker || ''),
    firstSeen: Number(any.first_seen ?? any.firstSeen) || 0,
    lastSeen: Number(any.last_seen ?? any.lastSeen) || 0,
    seedersLast: Number(any.seeders_last ?? any.seedersLast) || 0,
  };
}
function parseWork(any: Record<string, unknown>): WorkRow {
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

// --- SQLite engine ---------------------------------------------------------

function sqliteEngine(dbPath: string): Engine | null {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = _require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS magnet (
        hash TEXT PRIMARY KEY,
        uri TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        is_br INTEGER NOT NULL DEFAULT 0,
        dubbed INTEGER NOT NULL DEFAULT 0,
        quality TEXT NOT NULL DEFAULT '',
        seeders_max INTEGER NOT NULL DEFAULT 0,
        seeders_last INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0,
        lied INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS magnet_source (
        hash TEXT NOT NULL,
        indexer TEXT NOT NULL,
        tracker TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0,
        seeders_last INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hash, indexer)
      );
      CREATE TABLE IF NOT EXISTS magnet_work (
        hash TEXT NOT NULL,
        imdb TEXT NOT NULL,
        season INTEGER NOT NULL DEFAULT -1,
        episode INTEGER NOT NULL DEFAULT -1,
        first_seen INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0,
        passed_filter INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hash, imdb, season, episode)
      );
      CREATE INDEX IF NOT EXISTS magnet_work_obra ON magnet_work (imdb, season, episode);
      CREATE INDEX IF NOT EXISTS magnet_source_indexer ON magnet_source (indexer, last_seen);
    `);
    const magnetStmt = db.prepare(`INSERT OR REPLACE INTO magnet (${MAGNET_COLUMNS.join(', ')}) VALUES (${MAGNET_COLUMNS.map(() => '?').join(', ')})`);
    const sourceStmt = db.prepare(`INSERT OR REPLACE INTO magnet_source (${SOURCE_COLUMNS.join(', ')}) VALUES (${SOURCE_COLUMNS.map(() => '?').join(', ')})`);
    const workStmt = db.prepare(`INSERT OR REPLACE INTO magnet_work (${WORK_COLUMNS.join(', ')}) VALUES (${WORK_COLUMNS.map(() => '?').join(', ')})`);
    const getMagnetStmt = db.prepare('SELECT * FROM magnet WHERE hash = ?');
    const getSourceStmt = db.prepare('SELECT * FROM magnet_source WHERE hash = ? AND indexer = ?');
    const getWorkStmt = db.prepare('SELECT * FROM magnet_work WHERE hash = ? AND imdb = ? AND season = ? AND episode = ?');
    const listSourcesStmt = db.prepare('SELECT * FROM magnet_source WHERE hash = ? ORDER BY last_seen DESC');
    const listWorksStmt = db.prepare('SELECT * FROM magnet_work WHERE hash = ? ORDER BY last_seen DESC');
    const listWorksObraStmt = db.prepare('SELECT * FROM magnet_work WHERE imdb = ? AND season = ? AND episode = ? ORDER BY last_seen DESC LIMIT ?');
    const listSourcesIndexerStmt = db.prepare('SELECT * FROM magnet_source WHERE indexer = ? ORDER BY last_seen DESC LIMIT ?');
    const countMagnetStmt = db.prepare('SELECT COUNT(*) AS n FROM magnet');
    const countSourceStmt = db.prepare('SELECT COUNT(*) AS n FROM magnet_source');
    const countWorkStmt = db.prepare('SELECT COUNT(*) AS n FROM magnet_work');
    const clearMagnetStmt = db.prepare('DELETE FROM magnet');
    const clearSourceStmt = db.prepare('DELETE FROM magnet_source');
    const clearWorkStmt = db.prepare('DELETE FROM magnet_work');

    const all = (stmt: any, ...args: any[]): Record<string, unknown>[] =>
      (stmt.all(...args) as Record<string, unknown>[]);

    return {
      kind: 'sql',
      getMagnet(hash) {
        const r = getMagnetStmt.get(String(hash || '').toLowerCase()) as Record<string, unknown> | null;
        return r ? parseMagnet(r) : null;
      },
      getSource(hash, indexer) {
        const r = getSourceStmt.get(String(hash || '').toLowerCase(), String(indexer || '')) as Record<string, unknown> | null;
        return r ? parseSource(r) : null;
      },
      getWork(hash, imdb, season, episode) {
        const r = getWorkStmt.get(String(hash || '').toLowerCase(), String(imdb || ''), season, episode) as Record<string, unknown> | null;
        return r ? parseWork(r) : null;
      },
      listSources(hash) { return all(listSourcesStmt, String(hash || '').toLowerCase()).map(parseSource); },
      listWorks(hash) { return all(listWorksStmt, String(hash || '').toLowerCase()).map(parseWork); },
      listWorksByObra(imdb, season, episode, limit) {
        return all(listWorksObraStmt, String(imdb || ''), season, episode, limit).map(parseWork);
      },
      listSourcesByIndexer(indexer, limit) {
        return all(listSourcesIndexerStmt, String(indexer || ''), limit).map(parseSource);
      },
      writeBatch(batch) {
        // Uma transação por lote (uma busca/captura): fora do caminho da
        // resposta, mas atômico — ou o acervo inteiro da leva entra, ou nada.
        db.exec('BEGIN');
        try {
          for (const row of batch.magnets) magnetStmt.run(...renderMagnet(row));
          for (const row of batch.sources) sourceStmt.run(...renderSource(row));
          for (const row of batch.works) workStmt.run(...renderWork(row));
          // Hook de teste: a falha entra DEPOIS dos INSERTs e ANTES do COMMIT,
          // então o ROLLBACK é exercitado de verdade (sem cast/mock de engine).
          if (consumeFailNextWrite()) throw new Error('falha de escrita injetada (teste)');
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch { /* já em transação quebrada */ }
          throw err;
        }
        return batch.magnets.length + batch.sources.length + batch.works.length;
      },
      countMagnets() { return Number((countMagnetStmt.get() as Record<string, unknown>)?.n) || 0; },
      countSources() { return Number((countSourceStmt.get() as Record<string, unknown>)?.n) || 0; },
      countWorks() { return Number((countWorkStmt.get() as Record<string, unknown>)?.n) || 0; },
      clearRows() {
        try { clearMagnetStmt.run(); clearSourceStmt.run(); clearWorkStmt.run(); } catch { /* ignore */ }
      },
      closeEngine() {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.close();
        } catch (err) {
          log.warn('[magnetbank] falha ao fechar persistência:', log.errorMessage(err));
        }
      },
    };
  } catch (err: unknown) {
    log.warn('[magnetbank] SQLite indisponível, seguindo só em memória:', log.errorMessage(err));
    return null;
  }
}

// --- Memória engine (fallback) ---------------------------------------------

function memoryEngine(): Engine {
  const magnets = new Map<string, MagnetRow>();
  const sources = new Map<string, SourceRow>();
  const works = new Map<string, WorkRow>();
  const h = (hash: string) => String(hash || '').toLowerCase();
  const sourceKey = (hash: string, indexer: string) => `${h(hash)}\u0000${String(indexer || '')}`;
  const workKey = (hash: string, imdb: string, season: number, episode: number) =>
    `${h(hash)}\u0000${String(imdb || '')}\u0000${season}\u0000${episode}`;
  return {
    kind: 'memory',
    getMagnet(hash) { return magnets.get(h(hash)) || null; },
    getSource(hash, indexer) { return sources.get(sourceKey(hash, indexer)) || null; },
    getWork(hash, imdb, season, episode) { return works.get(workKey(hash, imdb, season, episode)) || null; },
    listSources(hash) {
      const prefix = `${h(hash)}\u0000`;
      const out: SourceRow[] = [];
      for (const [k, row] of sources) if (k.startsWith(prefix)) out.push(row);
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out;
    },
    listWorks(hash) {
      const prefix = `${h(hash)}\u0000`;
      const out: WorkRow[] = [];
      for (const [k, row] of works) if (k.startsWith(prefix)) out.push(row);
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out;
    },
    listWorksByObra(imdb, season, episode, limit) {
      const out: WorkRow[] = [];
      for (const row of works.values()) {
        if (row.imdb === String(imdb || '') && row.season === season && row.episode === episode) out.push(row);
      }
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out.slice(0, limit);
    },
    listSourcesByIndexer(indexer, limit) {
      const out: SourceRow[] = [];
      for (const row of sources.values()) if (row.indexer === String(indexer || '')) out.push(row);
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out.slice(0, limit);
    },
    writeBatch(batch) {
      if (consumeFailNextWrite()) throw new Error('falha de escrita injetada (teste)');
      for (const row of batch.magnets) magnets.set(h(row.hash), row);
      for (const row of batch.sources) sources.set(sourceKey(row.hash, row.indexer), row);
      for (const row of batch.works) works.set(workKey(row.hash, row.imdb, row.season, row.episode), row);
      return batch.magnets.length + batch.sources.length + batch.works.length;
    },
    countMagnets() { return magnets.size; },
    countSources() { return sources.size; },
    countWorks() { return works.size; },
    clearRows() { magnets.clear(); sources.clear(); works.clear(); },
    closeEngine() { magnets.clear(); sources.clear(); works.clear(); },
  };
}

// --- Abertura lazy e estado global -----------------------------------------

let store: Engine | null = null;

// Hook de teste: uma escrita injetada falha dentro da transação para provar o
// ROLLBACK e a métrica `magnetbank.flush.failed` — sem mock de engine nem cast
// espalhado. Consumido no primeiro `writeBatch` após o armamento.
let failNextWrite = false;
function consumeFailNextWrite(): boolean {
  if (!failNextWrite) return false;
  failNextWrite = false;
  return true;
}
export function failNextWriteForTests(): void {
  failNextWrite = true;
}

/** Desarma o gatilho. O flush chama no `finally`: armado para um lote que não
 * escreveu, ele não pode atravessar e derrubar uma escrita real depois. */
export function disarmFailNextWrite(): void {
  failNextWrite = false;
}

/**
 * Abre o armazenamento. Idempotente: a primeira chamada define o banco.
 * `dbPathOverride`/`forceMemory` só valem na primeira abertura (os testes
 * apontam um caminho temporário ou forçam a engine de memória).
 */
export function open(dbPathOverride?: string, opts: { forceMemory?: boolean } = {}): void {
  if (store) return;
  const dbPath = dbPathOverride ?? config.magnetBank?.dbPath ?? DEFAULT_MAGNET_BANK_DB_PATH;
  if (opts.forceMemory) { store = memoryEngine(); return; }
  store = sqliteEngine(dbPath) ?? memoryEngine();
}

export function engine(): Engine {
  if (!store) open();
  // open() garante store não-nulo (o fallback em memória nunca retorna null).
  return store as Engine;
}

/** Engine já aberto, SEM abrir nada — deixa a fachada evitar SQLite à toa. */
export function currentEngine(): Engine | null {
  return store;
}

/** Fecha o engine (e o arquivo SQLite). Idempotente. */
export function close(): void {
  if (store) {
    try { store.closeEngine(); } catch { /* best-effort */ }
  }
  store = null;
}

/** Teste: limpa linhas e esquece o path — cada teste começa limpo. */
export function resetForTests(): void {
  if (store) {
    try { store.clearRows(); } catch { /* ignore */ }
    try { store.closeEngine(); } catch { /* ignore */ }
  }
  store = null;
  failNextWrite = false;
}
