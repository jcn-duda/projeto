// Schema e migração do `crawl.db` (extraído de `crawl-store.ts` pela catraca
// de 400 linhas). Duas responsabilidades:
//
// 1. Criar as tabelas (mesmo DDL de sempre);
// 2. MIGRAR um `crawl_url` legado cuja definição carrega CHECK sobre `status`:
//    o status novo `simulated` (dry-run que leu página com releases, mas não
//    gravou) não passa numa CHECK antiga, e o erro só explodiria na PRIMEIRA
//    gravação — tarde, dentro do processamento. A migração reconstrói a tabela
//    (CREATE new → INSERT SELECT → DROP → RENAME) numa ÚNICA transação,
//    preservando TODAS as linhas e recriando os índices. Idempotente: sem
//    CHECK, é um no-op de uma leitura de `sqlite_master`.
//
// O schema REAL deste repositório nunca teve CHECK — a migração existe como
// defesa para bancos criados por versões com a trava, e é ela que o teste de
// migração legada exercita.
import * as log from './logger.js';

/** Superfície mínima do `node:sqlite` usada aqui (o store passa o db real). */
export interface CrawlSchemaDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}

const CRAWL_URL_DDL = `
  CREATE TABLE crawl_url (
    site TEXT NOT NULL,
    url TEXT NOT NULL,
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
    PRIMARY KEY (site, url)
  )`;

const CRAWL_URL_COLUMNS = [
  'site', 'url', 'lastmod', 'kind', 'status', 'imdb',
  'tries', 'next_at', 'checked_at', 'releases', 'error', 'progress', 'added_at',
];

/** A definição da tabela existente trava `status` com CHECK? */
function hasStatusCheck(db: CrawlSchemaDb): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'crawl_url'",
  ).get() as Record<string, unknown> | null;
  const ddl = String(row?.sql || '');
  if (!ddl) return false;
  return /\bCHECK\s*\(/i.test(ddl);
}

/** Rebuild seguro da tabela com CHECK legada: uma transação, linhas e índices
 * preservados. Qualquer falha faz ROLLBACK e sobe — o store cai na engine de
 * memória em vez de abrir um banco pela metade. */
function rebuildCrawlUrl(db: CrawlSchemaDb): void {
  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM crawl_url').get() as Record<string, unknown>)?.n) || 0;
  // A tabela legada pode não ter colunas novas (`progress`): o INSERT usa a
  // INTERSEÇÃO das colunas existentes — a que falta nasce com o DEFAULT do
  // DDL novo ('' para progress), nunca erro de coluna desconhecida.
  const existingCols = ((db.prepare('PRAGMA table_info(crawl_url)').all() as Array<Record<string, unknown>>)
    .map((c) => String(c?.name || '')));
  const cols = CRAWL_URL_COLUMNS.filter((c) => existingCols.includes(c)).join(', ');
  let started = false;
  try {
    db.exec('BEGIN');
    started = true;
    db.exec(CRAWL_URL_DDL.replace('CREATE TABLE crawl_url', 'CREATE TABLE crawl_url_new'));
    db.exec(`INSERT INTO crawl_url_new (${cols}) SELECT ${cols} FROM crawl_url`);
    db.exec('DROP TABLE crawl_url');
    db.exec('ALTER TABLE crawl_url_new RENAME TO crawl_url');
    db.exec('COMMIT');
    started = false;
    log.warn(`[crawl] tabela crawl_url com CHECK legada migrada para aceitar 'simulated' (${total} linha(s) preservada(s))`);
  } catch (err) {
    if (started) {
      try { db.exec('ROLLBACK'); } catch { /* transação já quebrada: sobe o erro original */ }
    }
    throw err;
  }
}

export function ensureCrawlSchema(db: CrawlSchemaDb): void {
  if (hasStatusCheck(db)) rebuildCrawlUrl(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_url (
      site TEXT NOT NULL,
      url TEXT NOT NULL,
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
      PRIMARY KEY (site, url)
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

/** Banco existente sem a coluna `progress` (formato anterior à Fase 7 v2):
 * ALTER idempotente. O rebuild do CHECK legado já copia pelas colunas, então
 * o caso dele é coberto; aqui sobra o banco criado pela versão anterior SEM
 * CHECK. Falha sobe — o sqliteEngine cai na engine de memória (defesa já
 * existente), em vez de abrir um banco pela metade. */
function ensureProgressColumn(db: CrawlSchemaDb): void {
  const cols = db.prepare('PRAGMA table_info(crawl_url)').all() as Array<Record<string, unknown>>;
  const has = cols.some((c) => String(c?.name || '') === 'progress');
  if (has) return;
  db.exec("ALTER TABLE crawl_url ADD COLUMN progress TEXT NOT NULL DEFAULT ''");
  log.warn('[crawl] coluna progress adicionada a crawl_url (linhas preservadas)');
}
