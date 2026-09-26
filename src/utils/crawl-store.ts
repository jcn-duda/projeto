// Estado da raspagem dos sites BR (plano "Raspagem total", Fase 0 — sem rede).
//
// Por que um SQLite PRÓPRIO (`data/crawl.db`) e não o cache (`cache.ts`)? A
// fila de URLs é ESTADO VIVO de retomada — o container reinicia no meio da
// carga inicial e o motor segue do próximo pendente — com 10 mil+ linhas por
// site. O cache tem cota por namespace, TTL e bump de versão; qualquer um dos
// três destruiria a fila. Mesmo padrão defensivo dos irmãos (magnet-bank,
// catálogo): `node:sqlite` carregado lazy com `createRequire` e, se o runtime
// não tiver o módulo (Node 20) ou a abertura falhar, o módulo segue SÓ EM
// MEMÓRIA (`crawl-store-memory.ts`, mesmos verbos, teto LRU, eviction contada)
// — nunca derruba o addon.
//
// Tabelas:
//   crawl_url — uma linha por (site, url): lastmod, tipo, status, obra,
//               tentativas, próxima tentativa e contagem de releases;
//   crawl_run — uma rodada do motor (carga inicial ou incremental), com fase,
//               cursor e contadores, para o painel mostrar progresso.
//
// A Fase 0 entrega só o armazenamento: a abertura é LAZY e nenhum caminho de
// produção a chama ainda — quem nunca chama `engine()` não paga arquivo.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import config from '../config.js';
import { DEFAULT_CRAWL_DB_PATH } from '../config/helpers.js';
import * as log from './logger.js';
import type {
  CrawlErrorGroup,
  CrawlResultStatus,
  CrawlRunPhase,
  CrawlRunRow,
  CrawlUrlRow,
  ClearSiteReport,
  DiscoveredEntry,
  MarkOpts,
  MarkResultInput,
  SiteCounters,
  UpsertReport,
} from '../providers/crawl-types.js';
import {
  URL_COLUMNS, applyResult, decideUpsert, emptyCounters, parseStatus, parseUrlRow, renderUrl,
} from './crawl-store-rules.js';
import { memoryCrawlEngine } from './crawl-store-memory.js';

export type {
  CrawlErrorGroup, CrawlPageKind, CrawlResultStatus, CrawlRunPhase, CrawlRunRow, CrawlUrlRow,
  CrawlUrlStatus, ClearSiteReport, DiscoveredEntry, MarkOpts, MarkResultInput, SiteCounters,
  UpsertReport,
} from '../providers/crawl-types.js';
export { errorBackoffMs, CRAWL_GIVE_UP_MS } from './crawl-store-rules.js';

/** Contrato único das duas engines (SQL e memória). */
export interface CrawlEngine {
  readonly kind: 'sql' | 'memory';
  /** Upsert idempotente das URLs descobertas (ver regras em crawl-store-rules). */
  upsertUrls(site: string, entries: readonly DiscoveredEntry[], now: number): UpsertReport;
  /** Próximo URL devido (pending; ou error com backoff vencido), em ordem
   * determinística; reivindica (→ inflight, `tries` preservado). */
  takeNext(site: string, now: number): CrawlUrlRow | null;
  getUrl(site: string, url: string): CrawlUrlRow | null;
  /** Grava o resultado do processamento (terminal, ou erro com tries/backoff). */
  markResult(site: string, url: string, result: MarkResultInput, now: number, opts?: MarkOpts): void;
  /** Crash recovery: `inflight` mais velho que `olderThanMs` volta a pending. */
  requeueInflight(site: string, olderThanMs: number, now: number): number;
  /** "Reprocessar erros": zera tries/next_at e reenfileira (ação do painel). */
  requeueErrors(site: string): number;
  /** Devolve UMA URL à fila (`pending`), preservando o resto — a simulação
   * usa isto para não consumir a página do ciclo de verdade. */
  requeueUrl(site: string, url: string): boolean;
  /** Contadores por status do site (progresso "x de N" no painel). */
  counters(site: string): SiteCounters;
  /** Últimas linhas num status (ordem: `checked_at` desc), para as listas do
   * painel (últimas obras, fila sem obra, erros). Teto obrigatório. */
  listByStatus(site: string, status: CrawlResultStatus, limit: number): CrawlUrlRow[];
  /** Erros agrupados por motivo, mais frequentes primeiro. */
  errorGroups(site: string, limit: number): CrawlErrorGroup[];
  /** Total de releases válidas vistas nas páginas do site (magnets gravados). */
  sumReleases(site: string): number;
  /** "Zerar site" (destrutivo): apaga SÓ o estado daquele site em `crawl.db`
   * (`crawl_url` + `crawl_run`), nunca o banco de magnets. */
  clearSite(site: string): ClearSiteReport;
  startRun(site: string, phase: CrawlRunPhase, cursor: string, now: number): number;
  finishRun(runId: number, now: number, counters?: Record<string, number>): void;
  latestRun(site: string): CrawlRunRow | null;
  /** Estado pequeno e durável por site (Fase 6: o cursor incremental).
   * `null` quando a chave nunca foi gravada. */
  getState(site: string, key: string): string | null;
  /** Grava estado do site (upsert); valor vazio é estado válido (''). */
  setState(site: string, key: string, value: string): void;
  /** Teto de linhas da engine de MEMÓRIA; `null` no SQLite (permanente). */
  memoryMax(): number | null;
  /** Evictions da engine de memória desde o boot; `0` no SQLite. */
  memoryEvictions(): number;
  clearRows(): void;
  closeEngine(): void;
}

// --- SQLite engine ---------------------------------------------------------

const _require = createRequire(import.meta.url);

function sqliteEngine(dbPath: string): CrawlEngine | null {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = _require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
    const putUrlStmt = db.prepare(
      `INSERT OR REPLACE INTO crawl_url (${URL_COLUMNS.join(', ')}) VALUES (${URL_COLUMNS.map(() => '?').join(', ')})`,
    );
    const getUrlStmt = db.prepare('SELECT * FROM crawl_url WHERE site = ? AND url = ?');
    // Ordem determinística de retomada: vence o mais antigo devido; dentro da
    // mesma rodada de descoberta, a ordem de inserção e depois a própria URL.
    // `error` NÃO vencido espera o backoff; vencido, volta a ser servido com o
    // `tries` preservado — é o retry automático até o `maxTries` do motor.
    const dueStmt = db.prepare(
      "SELECT * FROM crawl_url WHERE site = ? AND status IN ('pending', 'error') AND next_at <= ?"
      + ' ORDER BY next_at ASC, added_at ASC, url ASC LIMIT 1',
    );
    // Claim com guarda de status: a linha reivindicada é SEMPRE uma due
    // (`pending` ou `error` com backoff vencido) — nunca terminal.
    const claimStmt = db.prepare(
      "UPDATE crawl_url SET status = 'inflight', checked_at = ? WHERE site = ? AND url = ? AND status IN ('pending', 'error')",
    );
    const requeueInflightStmt = db.prepare(
      "UPDATE crawl_url SET status = 'pending', next_at = 0 WHERE site = ? AND status = 'inflight' AND checked_at <= ?",
    );
    const requeueErrorsStmt = db.prepare(
      "UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, error = '' WHERE site = ? AND status = 'error'",
    );
    const countersStmt = db.prepare('SELECT status, COUNT(*) AS n FROM crawl_url WHERE site = ? GROUP BY status');
    const totalStmt = db.prepare('SELECT COUNT(*) AS n FROM crawl_url WHERE site = ?');
    const requeueUrlStmt = db.prepare(
      "UPDATE crawl_url SET status = 'pending', next_at = 0 WHERE site = ? AND url = ?",
    );
    const listByStatusStmt = db.prepare(
      'SELECT * FROM crawl_url WHERE site = ? AND status = ? ORDER BY checked_at DESC, url ASC LIMIT ?',
    );
    const errorGroupsStmt = db.prepare(
      "SELECT error, COUNT(*) AS n FROM crawl_url WHERE site = ? AND status = 'error' GROUP BY error ORDER BY n DESC, error ASC LIMIT ?",
    );
    const sumReleasesStmt = db.prepare('SELECT COALESCE(SUM(releases), 0) AS n FROM crawl_url WHERE site = ?');
    const clearSiteUrlsStmt = db.prepare('DELETE FROM crawl_url WHERE site = ?');
    const clearSiteRunsStmt = db.prepare('DELETE FROM crawl_run WHERE site = ?');
    const insertRunStmt = db.prepare(
      'INSERT INTO crawl_run (id, site, phase, cursor, started_at, finished_at, counters) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    const finishRunStmt = db.prepare('UPDATE crawl_run SET finished_at = ?, counters = ? WHERE id = ?');
    const latestRunStmt = db.prepare('SELECT * FROM crawl_run WHERE site = ? ORDER BY started_at DESC, id DESC LIMIT 1');
    const nextRunIdStmt = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM crawl_run');
    const getStateStmt = db.prepare('SELECT value FROM crawl_state WHERE site = ? AND key = ?');
    const setStateStmt = db.prepare(
      'INSERT OR REPLACE INTO crawl_state (site, key, value, updated_at) VALUES (?, ?, ?, ?)',
    );
    const clearUrlsStmt = db.prepare('DELETE FROM crawl_url');
    const clearRunsStmt = db.prepare('DELETE FROM crawl_run');
    const clearStateStmt = db.prepare('DELETE FROM crawl_state');
    const clearSiteStateStmt = db.prepare('DELETE FROM crawl_state WHERE site = ?');

    const selectUrl = (site: string, url: string): CrawlUrlRow | null => {
      const r = getUrlStmt.get(String(site || ''), String(url || '')) as Record<string, unknown> | null;
      return r ? parseUrlRow(r) : null;
    };

    const parseRun = (r: Record<string, unknown>): CrawlRunRow => {
      let counters: Record<string, number> = {};
      try { counters = JSON.parse(String(r.counters || '{}')) as Record<string, number>; } catch { /* ilegível: vazio */ }
      return {
        id: Number(r.id) || 0,
        site: String(r.site || ''),
        phase: r.phase === 'incremental' ? 'incremental' : 'initial',
        cursor: String(r.cursor || ''),
        startedAt: Number(r.started_at) || 0,
        finishedAt: r.finished_at == null ? null : Number(r.finished_at),
        counters,
      };
    };

    return {
      kind: 'sql',
      // SQLite é o estado PERMANENTE da fila: sem cota e sem eviction.
      memoryMax() { return null; },
      memoryEvictions() { return 0; },
      upsertUrls(site, entries, now) {
        const s = String(site || '');
        const report: UpsertReport = { added: 0, refreshed: 0, unchanged: 0 };
        // Uma transação por leva de descoberta (um sitemap/página de listagem):
        // ou a leva inteira entra, ou nada — a fila nunca fica pela metade.
        // `transactionStarted` guarda o que de fato abriu: se o BEGIN falhar,
        // NÃO há o que desfazer; se o COMMIT falhar e o ROLLBACK também
        // falhar, o erro ORIGINAL é o que sobe — o da limpeza não o mascara.
        let transactionStarted = false;
        try {
          db.exec('BEGIN');
          transactionStarted = true;
          for (const entry of entries) {
            const { row, outcome } = decideUpsert(s, selectUrl(s, String(entry.url || '')), entry, now);
            putUrlStmt.run(...renderUrl(row));
            report[outcome] += 1;
          }
          db.exec('COMMIT');
          transactionStarted = false;
        } catch (err) {
          if (transactionStarted) {
            try { db.exec('ROLLBACK'); } catch { /* já em transação quebrada: preserva o erro original */ }
          }
          throw err;
        }
        return report;
      },
      takeNext(site, now) {
        const r = dueStmt.get(String(site || ''), now) as Record<string, unknown> | null;
        if (!r) return null;
        const row = parseUrlRow(r);
        const claim = claimStmt.run(now, row.site, row.url) as { changes?: number | bigint };
        if (!claim || Number(claim.changes) === 0) return null;
        return { ...row, status: 'inflight', checkedAt: now };
      },
      getUrl(site, url) { return selectUrl(site, url); },
      markResult(site, url, result, now, opts: MarkOpts = {}) {
        const existing = selectUrl(site, url);
        // URL desconhecida é no-op: o operador pode ter zerado o site no meio
        // de um processamento — resultado órfão não recria linha.
        if (!existing) return;
        putUrlStmt.run(...renderUrl(applyResult(existing, result, now, opts)));
      },
      requeueInflight(site, olderThanMs, now) {
        const r = requeueInflightStmt.run(String(site || ''), now - olderThanMs) as { changes?: number | bigint };
        return Number(r?.changes) || 0;
      },
      requeueErrors(site) {
        const r = requeueErrorsStmt.run(String(site || '')) as { changes?: number | bigint };
        return Number(r?.changes) || 0;
      },
      requeueUrl(site, url) {
        const r = requeueUrlStmt.run(String(site || ''), String(url || '')) as { changes?: number | bigint };
        return Number(r?.changes) > 0;
      },
      counters(site) {
        const s = String(site || '');
        const byStatus = emptyCounters();
        const rows = (countersStmt.all(s) as Record<string, unknown>[]);
        for (const r of rows) byStatus[parseStatus(r.status)] = Number(r.n) || 0;
        const total = Number((totalStmt.get(s) as Record<string, unknown>)?.n) || 0;
        return { total, byStatus };
      },
      listByStatus(site, status, limit) {
        const cap = Math.max(0, Math.trunc(Number(limit) || 0));
        if (cap <= 0) return [];
        const rows = listByStatusStmt.all(String(site || ''), String(status || ''), cap) as Record<string, unknown>[];
        return rows.map(parseUrlRow);
      },
      errorGroups(site, limit) {
        const cap = Math.max(0, Math.trunc(Number(limit) || 0));
        if (cap <= 0) return [];
        const rows = errorGroupsStmt.all(String(site || ''), cap) as Record<string, unknown>[];
        return rows.map((r) => ({ reason: String(r.error || 'erro'), count: Number(r.n) || 0 }));
      },
      sumReleases(site) {
        return Number((sumReleasesStmt.get(String(site || '')) as Record<string, unknown>)?.n) || 0;
      },
      clearSite(site) {
        const s = String(site || '');
        const urls = Number((clearSiteUrlsStmt.run(s) as { changes?: number | bigint })?.changes) || 0;
        const runs = Number((clearSiteRunsStmt.run(s) as { changes?: number | bigint })?.changes) || 0;
        // Estado derivado do site (cursor incremental) também é "o estado
        // daquele site": sem isto, o Zerar site deixaria o cursor apontando
        // para um sitemap que não existe mais na fila.
        clearSiteStateStmt.run(s);
        return { urls, runs };
      },
      startRun(site, phase, cursor, now) {
        const id = Number((nextRunIdStmt.get() as Record<string, unknown>)?.id) || 1;
        insertRunStmt.run(
          id, String(site || ''),
          phase === 'incremental' ? 'incremental' : 'initial',
          String(cursor || ''), now, '{}',
        );
        return id;
      },
      finishRun(runId, now, counters) {
        finishRunStmt.run(now, JSON.stringify(counters ?? {}), runId);
      },
      latestRun(site) {
        const r = latestRunStmt.get(String(site || '')) as Record<string, unknown> | null;
        return r ? parseRun(r) : null;
      },
      getState(site, key) {
        const r = getStateStmt.get(String(site || ''), String(key || '')) as Record<string, unknown> | null;
        return r ? String(r.value ?? '') : null;
      },
      setState(site, key, value) {
        setStateStmt.run(String(site || ''), String(key || ''), String(value ?? ''), Date.now());
      },
      clearRows() {
        // MESMA regra da memória: estado por site (cursor) também sai — cada
        // teste começa limpo de verdade, sem cursor sobrevivente.
        try { clearUrlsStmt.run(); clearRunsStmt.run(); clearStateStmt.run(); } catch { /* ignore */ }
      },
      closeEngine() {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.close();
        } catch (err) {
          log.warn('[crawl] falha ao fechar persistência:', log.errorMessage(err));
        }
      },
    };
  } catch (err: unknown) {
    log.warn('[crawl] SQLite indisponível, seguindo só em memória:', log.errorMessage(err));
    return null;
  }
}

// --- Abertura lazy e estado global -----------------------------------------

let store: CrawlEngine | null = null;

/**
 * Abre o armazenamento. Idempotente: a primeira chamada define a engine.
 * `dbPathOverride`/`forceMemory` só valem na primeira abertura (os testes
 * apontam um caminho temporário ou forçam a engine de memória).
 */
export function open(dbPathOverride?: string, opts: { forceMemory?: boolean } = {}): void {
  if (store) return;
  const dbPath = dbPathOverride ?? config.crawl.dbPath ?? DEFAULT_CRAWL_DB_PATH;
  if (opts.forceMemory) { store = memoryCrawlEngine(); return; }
  store = sqliteEngine(dbPath) ?? memoryCrawlEngine();
}

export function engine(): CrawlEngine {
  if (!store) open();
  // open() garante engine não-nula (o fallback em memória nunca retorna null).
  return store as CrawlEngine;
}

/** Engine já aberta, SEM abrir nada — deixa o status evitar SQLite à toa. */
export function currentEngine(): CrawlEngine | null {
  return store;
}

/** Fecha a engine (e o arquivo SQLite, com checkpoint de WAL). Idempotente. */
export function close(): void {
  if (store) {
    try { store.closeEngine(); } catch { /* best-effort */ }
  }
  store = null;
}

/** Teste: limpa linhas e esquece a engine — cada teste começa limpo. */
export function resetForTests(): void {
  if (store) {
    try { store.clearRows(); } catch { /* ignore */ }
    try { store.closeEngine(); } catch { /* ignore */ }
  }
  store = null;
}
