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
import * as metrics from './metrics.js';
import {
  MAGNET_COLUMNS, SOURCE_COLUMNS, WORK_COLUMNS,
  renderMagnet, renderSource, renderWork,
  parseMagnet, parseSource, parseWork,
} from './magnet-bank-schema.js';
import type { MagnetRow, SourceRow, WorkRow, Batch, BankStats, IndexerStat } from './magnet-bank-schema.js';
import { memoryEngine } from './magnet-bank-memory.js';

export type { MagnetRow, SourceRow, WorkRow, Batch, BankStats, IndexerStat } from './magnet-bank-schema.js';

/** Padrão de LIKE para substring de título com escape dos curingas (`%`/`_`) e
 * do próprio `\`. Sem escapar, um `%` digitado pelo operador varreria a tabela
 * inteira; com ESCAPE, o texto é literal. */
function likePattern(substring: string): string {
  return `%${substring.replace(/[\\%_]/g, '\\$&')}%`;
}

const _require = createRequire(import.meta.url);

export interface Engine {
  readonly kind: 'sql' | 'memory';
  getMagnet(hash: string): MagnetRow | null;
  getSource(hash: string, indexer: string): SourceRow | null;
  getWork(hash: string, imdb: string, season: number, episode: number): WorkRow | null;
  listSources(hash: string): SourceRow[];
  listWorks(hash: string): WorkRow[];
  /** `indexers` não vazio: só obras cujo hash tem fonte num deles. */
  listWorksByObra(imdb: string, season: number, episode: number, limit: number, indexers?: readonly string[]): WorkRow[];
  listSourcesByIndexer(indexer: string, limit: number): SourceRow[];
  /** Títulos da obra (qualquer temporada) com extensão executável no título/URI. */
  listExecutableTitles(imdb: string, limit: number): string[];
  /** Magnets de VÁRIOS hashes numa consulta (fallback sem N+1). */
  listMagnetsMany(hashes: readonly string[]): MagnetRow[];
  /** Fontes de VÁRIOS hashes numa consulta (fallback sem N+1). */
  listSourcesMany(hashes: readonly string[]): SourceRow[];
  /** Obras de VÁRIOS hashes numa consulta (busca do painel sem N+1). */
  listWorksMany(hashes: readonly string[]): WorkRow[];
  /** Magnets mais recentes (busca vazia do painel, limitada). */
  listRecentMagnets(limit: number): MagnetRow[];
  /**
   * Magnets cujo título contém QUALQUER uma das variantes (mais recentes).
   * A fachada manda as variantes de caixa (original/lower/upper) para o LIKE
   * ASCII do SQLite casar acento (`Épico` × `épico`) sem schema novo; a memória
   * espelha com `toLowerCase`.
   */
  searchMagnetsByTitle(variants: readonly string[], limit: number): MagnetRow[];
  /** Panorama agregado numa passada (COUNT/MAX/GROUP BY, sem N+1). */
  stats(): BankStats;
  writeBatch(batch: Batch): number;
  countMagnets(): number;
  countSources(): number;
  countWorks(): number;
  /**
   * Teto de linhas da engine de MEMÓRIA (`null` no SQLite, que é permanente e
   * sem cota). Leitura O(1); alimenta o aviso do painel.
   */
  memoryMax(): number | null;
  /** Evictions LRU da engine de memória desde o boot (`0` no SQLite). */
  memoryEvictions(): number;
  clearRows(): void;
  closeEngine(): void;
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
    const listWorksObraStmt = db.prepare('SELECT * FROM magnet_work WHERE imdb = ? AND season = ? AND episode = ? ORDER BY passed_filter DESC, last_seen DESC LIMIT ?');
    // Fallback de indexer FALHO: filtrar pela fonte ANTES do LIMIT. Sem isto a
    // janela (last_seen desc) enchia de globais recém-vistos e o BR de 1 seeder
    // nunca era lido — Star Trek Into Darkness: 339 obras, 0 BR nas 80 lidas.
    // `passed_filter` na frente: o site BR devolve toda a franquia para a
    // busca (102 posts de outra obra Star Trek contra 4 do filme, todos
    // separados por ele). Ordena, não decide — o build refiltra.
    const listWorksObraIxStmt = db.prepare(
      'SELECT * FROM magnet_work w WHERE w.imdb = ? AND w.season = ? AND w.episode = ? AND EXISTS ('
      + 'SELECT 1 FROM magnet_source s WHERE s.hash = w.hash AND s.indexer IN (SELECT value FROM json_each(?))'
      + ') ORDER BY w.passed_filter DESC, w.last_seen DESC LIMIT ?',
    );
    // Pré-filtro barato por LIKE; a regra exata (extensão no fim do nome) roda
    // em JS no fake-release, que é quem decide.
    const exeTitlesStmt = db.prepare(
      "SELECT DISTINCT m.title FROM magnet_work w JOIN magnet m ON m.hash = w.hash WHERE w.imdb = ? AND ("
      + ['exe', 'scr', 'lnk', 'bat', 'cmd', 'msi', 'pif', 'vbs'].map((x) => `m.title LIKE '%.${x}%' OR m.uri LIKE '%.${x}%'`).join(' OR ')
      + ') LIMIT ?',
    );
    const listSourcesIndexerStmt = db.prepare('SELECT * FROM magnet_source WHERE indexer = ? ORDER BY last_seen DESC LIMIT ?');
    const recentMagnetsStmt = db.prepare('SELECT * FROM magnet ORDER BY last_seen DESC LIMIT ?');
    // Busca por título com OR de 1..3 variantes (original/lower/upper). O LIKE
    // do SQLite só faz casefold ASCII; variar a caixa da QUERY fecha o acento
    // (`É`/`é`) sem coluna normalizada nova. `IS`/placeholders fixos por aridade.
    const searchTitleStmts = [1, 2, 3].map((n) => db.prepare(
      `SELECT * FROM magnet WHERE ${new Array(n).fill("title LIKE ? ESCAPE '\\'").join(' OR ')} ORDER BY last_seen DESC LIMIT ?`,
    ));
    const maxMagnetSeenStmt = db.prepare('SELECT COALESCE(MAX(last_seen), 0) AS t FROM magnet');
    const maxSourceSeenStmt = db.prepare('SELECT COALESCE(MAX(last_seen), 0) AS t FROM magnet_source');
    // Agregação por indexer numa ÚNICA consulta (GROUP BY usa o índice
    // magnet_source_indexer): o painel não paga uma query por indexer.
    const indexerStatsStmt = db.prepare(
      'SELECT indexer, COUNT(DISTINCT hash) AS hashes, COUNT(*) AS sources, MAX(last_seen) AS last_seen FROM magnet_source GROUP BY indexer ORDER BY last_seen DESC, indexer ASC',
    );
    const countMagnetStmt = db.prepare('SELECT COUNT(*) AS n FROM magnet');
    const countSourceStmt = db.prepare('SELECT COUNT(*) AS n FROM magnet_source');
    const countWorkStmt = db.prepare('SELECT COUNT(*) AS n FROM magnet_work');
    const clearMagnetStmt = db.prepare('DELETE FROM magnet');
    const clearSourceStmt = db.prepare('DELETE FROM magnet_source');
    const clearWorkStmt = db.prepare('DELETE FROM magnet_work');

    const all = (stmt: any, ...args: any[]): Record<string, unknown>[] =>
      (stmt.all(...args) as Record<string, unknown>[]);
    // Consulta em LOTE por lista de hashes (chunks de 200): o fallback lê N
    // magnets/fontes de uma vez em vez de N+1 queries. A tabela é literal
    // interna, nunca vinda de input.
    const many = (table: 'magnet' | 'magnet_source' | 'magnet_work', hashes: readonly string[]): Record<string, unknown>[] => {
      const list = [...new Set(hashes.map((h) => String(h || '').toLowerCase()).filter(Boolean))];
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200);
        const stmt = db.prepare(`SELECT * FROM ${table} WHERE hash IN (${chunk.map(() => '?').join(',')})`);
        out.push(...all(stmt, ...chunk));
      }
      return out;
    };

    return {
      kind: 'sql',
      // SQLite é o acervo PERMANENTE: sem cota e sem eviction por LRU.
      memoryMax() { return null; },
      memoryEvictions() { return 0; },
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
      listWorksByObra(imdb, season, episode, limit, indexers) {
        if (indexers && indexers.length > 0) {
          return all(listWorksObraIxStmt, String(imdb || ''), season, episode, JSON.stringify(indexers), limit).map(parseWork);
        }
        return all(listWorksObraStmt, String(imdb || ''), season, episode, limit).map(parseWork);
      },
      listSourcesByIndexer(indexer, limit) {
        return all(listSourcesIndexerStmt, String(indexer || ''), limit).map(parseSource);
      },
      listExecutableTitles(imdb, limit) {
        return all(exeTitlesStmt, String(imdb || ''), limit).map((r) => String(r.title || ''));
      },
      listMagnetsMany(hashes) { return many('magnet', hashes).map(parseMagnet); },
      listSourcesMany(hashes) { return many('magnet_source', hashes).map(parseSource); },
      listWorksMany(hashes) { return many('magnet_work', hashes).map(parseWork); },
      listRecentMagnets(limit) { return all(recentMagnetsStmt, limit).map(parseMagnet); },
      searchMagnetsByTitle(variants, limit) {
        const list = (variants.length > 0 ? variants : ['']).slice(0, 3);
        const patterns = list.map(likePattern);
        return all(searchTitleStmts[patterns.length - 1], ...patterns, limit).map(parseMagnet);
      },
      stats() {
        const magnetMax = Number((maxMagnetSeenStmt.get() as Record<string, unknown>)?.t) || 0;
        const sourceMax = Number((maxSourceSeenStmt.get() as Record<string, unknown>)?.t) || 0;
        const byIndexer: IndexerStat[] = all(indexerStatsStmt).map((r) => ({
          indexer: String(r.indexer || ''),
          hashes: Number(r.hashes) || 0,
          sources: Number(r.sources) || 0,
          lastSeen: Number(r.last_seen) || 0,
        }));
        return {
          magnets: Number((countMagnetStmt.get() as Record<string, unknown>)?.n) || 0,
          sources: Number((countSourceStmt.get() as Record<string, unknown>)?.n) || 0,
          works: Number((countWorkStmt.get() as Record<string, unknown>)?.n) || 0,
          lastSeen: Math.max(magnetMax, sourceMax),
          byIndexer,
          memoryMax: null,
          memoryEvictions: 0,
        };
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

// A engine de memória (fallback) mora em `magnet-bank-memory.ts` desde a
// catraca de 400 linhas; o hook de falha de escrita, o teto LRU e o callback
// de eviction (métrica `magnetbank.memory.evicted`) são injetados na fábrica.
// O teto é lido por GETTER: um knob baixado em runtime passa a valer na
// próxima passagem do `enforceCap` sem recriar a engine.

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
  const cap = () => config.magnetBank?.memoryMax ?? 20000;
  // A eviction da engine de memória é observável (métrica + aviso no painel):
  // o callback mora aqui para a engine não importar metrics/config.
  const onEvict = (count: number) => metrics.count('magnetbank.memory.evicted', count);
  if (opts.forceMemory) { store = memoryEngine(consumeFailNextWrite, cap, onEvict); return; }
  store = sqliteEngine(dbPath) ?? memoryEngine(consumeFailNextWrite, cap, onEvict);
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
