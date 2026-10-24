// Schema e migração do `crawl.db` (extraído de `crawl-store.ts` pela catraca
// de 400 linhas). Duas responsabilidades:
//
// 1. Criar as tabelas (DDL de sempre) e a coluna que a versão anterior não
//    tinha;
// 2. RECONSTRUIR `crawl_url` quando a definição legada não serve mais. São três
//    causas, e as três são resolvidas pelo MESMO rebuild:
//    a) `CHECK` sobre `status` (schema hipotético de versões com a trava): o
//       status novo `simulated` (dry-run que leu página com releases, mas não
//       gravou) não passa, e o erro só explodiria na PRIMEIRA gravação — tarde,
//       dentro do processamento;
//    b) ausência da coluna `progress` (Fase 7 v2);
//    c) identidade por `url` cheia em vez de `(site, url_key)` (Fase 8) — a
//       chave passa a ser o CAMINHO, para a fila sobreviver à troca de
//       domínio do site. O SQLite não troca chave primária por `ALTER`, e a
//       `url_key` é calculada em TypeScript (normalizar caminho não é
//       expressável em SQL com honestidade), então a fusão das linhas que
//       passaram a ser a mesma página acontece AQUI, no meio da transação.
//
// O rebuild é uma transação só (CREATE new → INSERT → DROP → RENAME); os
// índices são recriados pelo `CREATE INDEX IF NOT EXISTS` logo abaixo. Falha
// qualquer faz ROLLBACK e o erro sobe — o store cai na engine de memória em
// vez de abrir um banco pela metade. Idempotente: banco já no formato corrente
// não é tocado (uma leitura de `PRAGMA` + `sqlite_master`).
import * as log from './logger.js';
import { crawlUrlKey, mergeCrawlUrlRows } from './crawl-url-key.js';
import { parseUrlRow, renderUrl } from './crawl-store-rules.js';
import type { CrawlUrlRow } from '../providers/crawl-types.js';

/** Superfície mínima do `node:sqlite` usada aqui (o store passa o db real). */
export interface CrawlSchemaDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}

const CRAWL_URL_DDL = `
  CREATE TABLE crawl_url (
    site TEXT NOT NULL,
    url TEXT NOT NULL,
    url_key TEXT NOT NULL DEFAULT '',
    lastmod TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'movie',
    status TEXT NOT NULL DEFAULT 'pending',
    imdb TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL DEFAULT 0,
    releases INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    progress TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site, url_key)
  )`;

/** Mesma ordem do DDL: o INSERT do rebuild e o codec `renderUrl` dependem. */
const CRAWL_URL_COLUMNS = [
  'site', 'url', 'url_key', 'lastmod', 'kind', 'status', 'imdb',
  'tries', 'next_at', 'checked_at', 'releases', 'error', 'progress', 'added_at',
];

function tableExists(db: CrawlSchemaDb): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crawl_url'",
  ).get() as Record<string, unknown> | null;
  return Boolean(row);
}

function tableColumns(db: CrawlSchemaDb): string[] {
  return (db.prepare('PRAGMA table_info(crawl_url)').all() as Array<Record<string, unknown>>)
    .map((c) => String(c?.name || ''));
}

/** A definição da tabela existente trava `status` com CHECK? */
function hasStatusCheck(db: CrawlSchemaDb): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'crawl_url'",
  ).get() as Record<string, unknown> | null;
  return /\bCHECK\s*\(/i.test(String(row?.sql || ''));
}

/** Rebuild seguro: uma transação, linhas fundidas e índices recriados depois. */
function rebuildCrawlUrl(db: CrawlSchemaDb): void {
  // `parseUrlRow` tolera coluna ausente (todo campo fora de forma vira
  // default), então a legada sem `progress` passa por aqui sem caso especial.
  const legacy = (db.prepare('SELECT * FROM crawl_url').all() as Record<string, unknown>[]).map(parseUrlRow);
  // Duas URLs que só diferem no host (ou na barra final) são a MESMA página
  // desde a Fase 8: colapsam numa linha, e o vencedor é o que tinha trabalho
  // registrado — ver `mergeCrawlUrlRows`.
  const byKey = new Map<string, CrawlUrlRow[]>();
  for (const row of legacy) {
    const k = `${row.site}\u0000${crawlUrlKey(row.url)}`;
    const bucket = byKey.get(k);
    if (bucket) bucket.push(row);
    else byKey.set(k, [row]);
  }
  const merged: CrawlUrlRow[] = [];
  for (const rows of byKey.values()) {
    const row = mergeCrawlUrlRows(rows);
    if (row) merged.push(row);
  }
  const collapsed = legacy.length - merged.length;
  const hadCheck = hasStatusCheck(db);
  // `prepare` COMPILA o SQL: a tabela nova precisa existir antes, senão o erro
  // é "no such table" e a migration inteira cai na engine de memória.
  let ins: ReturnType<CrawlSchemaDb['prepare']> | null = null;
  let started = false;
  try {
    db.exec('BEGIN');
    started = true;
    db.exec(CRAWL_URL_DDL.replace('CREATE TABLE crawl_url', 'CREATE TABLE crawl_url_new'));
    ins = db.prepare(
      `INSERT INTO crawl_url_new (${CRAWL_URL_COLUMNS.join(', ')}) VALUES (${CRAWL_URL_COLUMNS.map(() => '?').join(', ')})`,
    );
    for (const row of merged) ins.run(...renderUrl(row));
    db.exec('DROP TABLE crawl_url');
    db.exec('ALTER TABLE crawl_url_new RENAME TO crawl_url');
    db.exec('COMMIT');
    started = false;
  } catch (err) {
    if (started) {
      try { db.exec('ROLLBACK'); } catch { /* transação já quebrada: sobe o erro original */ }
    }
    throw err;
  }
  log.warn(
    `[crawl] crawl_url migrada para identidade (site, url_key): ${merged.length} linha(s)`
    + `${collapsed ? `, ${collapsed} colapsada(s) por mesmo caminho` : ''}`
    + `${hadCheck ? ' (CHECK legada removida)' : ''}`,
  );
}

/**
 * Abre o arquivo do `crawl.db` já PRONTO: PRAGMAs + schema/migração. Qualquer
 * falha depois do handle aberto fecha o banco antes de propagar — sem isso a
 * queda para a engine de memória deixaria o handle vivo, e no Windows um handle
 * vivo TRAVA o arquivo, justamente o `crawl.db` que o operador precisa reparar
 * ou remover depois de uma abertura ruim.
 */
export function openCrawlDatabase(dbPath: string, DatabaseSync: new (path: string) => unknown): unknown {
  const db = new DatabaseSync(dbPath) as CrawlSchemaDb;
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    ensureCrawlSchema(db);
  } catch (err: unknown) {
    try { (db as unknown as { close?: () => void }).close?.(); } catch { /* best-effort */ }
    throw err;
  }
  return db;
}

export function ensureCrawlSchema(db: CrawlSchemaDb): void {
  const exists = tableExists(db);
  // Banco ausente: o `CREATE TABLE IF NOT EXISTS` abaixo já nasce no formato
  // novo, sem rebuild. Banco presente sem `url_key` (ou com CHECK): rebuild.
  if (exists && (!tableColumns(db).includes('url_key') || hasStatusCheck(db))) rebuildCrawlUrl(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_url (
      site TEXT NOT NULL,
      url TEXT NOT NULL,
      url_key TEXT NOT NULL DEFAULT '',
      lastmod TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'movie',
      status TEXT NOT NULL DEFAULT 'pending',
      imdb TEXT,
      tries INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0,
      releases INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site, url_key)
    );
    CREATE INDEX IF NOT EXISTS crawl_url_due ON crawl_url (site, status, next_at);
    CREATE TABLE IF NOT EXISTS crawl_run (
      id INTEGER PRIMARY KEY,
      site TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'initial',
      cursor TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER,
      counters TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS crawl_run_site ON crawl_run (site, started_at);
    CREATE TABLE IF NOT EXISTS crawl_state (
      site TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site, key)
    );
  `);
  ensureProgressColumn(db);
}

/** Rede de segurança para um banco com `url_key` mas sem `progress` (não existe
 * nesta versão, mas o rebuild já normaliza): `ALTER` idempotente. Falha sobe —
 * o sqliteEngine cai na engine de memória (defesa já existente), em vez de abrir
 * um banco pela metade. */
function ensureProgressColumn(db: CrawlSchemaDb): void {
  if (tableColumns(db).includes('progress')) return;
  db.exec("ALTER TABLE crawl_url ADD COLUMN progress TEXT NOT NULL DEFAULT ''");
  log.warn('[crawl] coluna progress adicionada a crawl_url (linhas preservadas)');
}
