// Catálogo durável da conta AllDebrid + limpador BR com prova — CAMADA DE
// LINHAS E ENGINE.
//
// Por que um SQLite PRÓPRIO e não o cache (`src/utils/cache.ts`)? O cache tem
// cota, TTL e bump de namespace — ele DESTRÓI conhecimento. Aqui guardamos
// HISTÓRICO: o que a conta teve, o momento em que cada magnet apareceu, o
// veredito de estrangeiro que o condenou e a data em que foi deletado. Perder
// isso por um bump de `cache-keys.ts` ou por evicção de cota jogaria fora o
// próprio dado que o limpador precisa para não apagar acervo bom. Tabela única
// `magnet`, TOMBSTONE em vez de DELETE, sem cota e sem TTL: o que saiu da
// conta continua gravado com `deleted_at` + `delete_reason`.
//
// Segue o MESMO padrão defensivo do cache: `node:sqlite` carregado lazy com
// `createRequire` e, se o runtime não tiver o módulo (Node 20) ou a abertura
// falhar, o módulo segue SÓ EM MEMÓRIA com um Map e loga warn — nunca derruba
// o addon. Dois motores (SQL e memória) com os mesmos verbos para quem lê não
// depender do engine.
//
// Esta é a camada de armazenamento; a fachada pública é `src/utils/catalog.ts`
// e as features leem/escrevem por aqui: varredura (`catalog-scan.ts`),
// deduplicação (`catalog-dedup.ts`), planos de limpeza (`catalog-cleanup.ts`)
// e fila de auditoria (`catalog-audit.ts`).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import config from '../config.js';
import * as log from './logger.js';

const _require = createRequire(import.meta.url);

// Estados dos quais a AllDebrid ainda está trabalhando: a limpeza nunca toca
// download em curso. Replicada aqui com a MESMA expressão do adaptador
// (`src/debrid/alldebrid.ts`, que não a exporta) — se ela mudar lá, este
// comentário e os testes que cobrem as guardas apontam o desvio.
const ACTIVE_RE = /^(?:queued|downloading|processing|compressing|moving|uploading)$/i;

export function isActive(status: string): boolean {
  return ACTIVE_RE.test(String(status || ''));
}

// ---------------------------------------------------------------------------
// Linhas e engine
// ---------------------------------------------------------------------------

export type Row = {
  adapter: string;
  account: string;
  serviceId: string;
  hash: string;
  filename: string;
  size: number;
  status: string;
  ready: number;
  uploadedAt: number;
  bucket: string;
  audio: string;
  foreignProof: string;
  ptProof: string;
  imdbId: string;
  workTitle: string;
  workIsBr: number;
  workDubbed: number;
  workLied: number;
  season: number | null;
  episode: number | null;
  cached: string;
  cachedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Quando a auditoria de ARQUIVOS mediu esta linha (prova durável; ver rowsNeedingAudit). */
  auditedAt: number;
  deletedAt: number;
  deleteReason: string;
};

export type MarkInput = { serviceId: string | number; reason: string };

export interface Engine {
  getRow(adapter: string, account: string, serviceId: string | number): Row | null;
  insertRow(row: Row): void;
  updateRow(row: Row): void;
  listRows(adapter: string, account: string): Row[];
  markDeleted(adapter: string, account: string, items: MarkInput[]): number;
  clearRows(): void;
  closeEngine(): void;
}

const COLUMNS = [
  'adapter', 'account', 'service_id', 'hash', 'filename', 'size', 'status',
  'ready', 'uploaded_at', 'bucket', 'audio', 'foreign_proof', 'pt_proof',
  'imdb_id', 'work_title', 'work_is_br', 'work_dubbed', 'work_lied', 'season',
  'episode', 'cached', 'cached_at', 'first_seen_at', 'last_seen_at', 'audited_at',
  'deleted_at', 'delete_reason',
];

function render(row: Row): (string | number | null)[] {
  return [
    row.adapter, row.account, row.serviceId, row.hash, row.filename, row.size, row.status,
    row.ready, row.uploadedAt, row.bucket, row.audio, row.foreignProof, row.ptProof,
    row.imdbId, row.workTitle, row.workIsBr, row.workDubbed, row.workLied, row.season,
    row.episode, row.cached, row.cachedAt, row.firstSeenAt, row.lastSeenAt, row.auditedAt,
    row.deletedAt, row.deleteReason,
  ];
}

function parse(any: Record<string, unknown>): Row {
  return {
    adapter: String(any.adapter || ''),
    account: String(any.account || ''),
    serviceId: String(any.service_id ?? any.serviceId ?? ''),
    hash: String(any.hash || ''),
    filename: String(any.filename || ''),
    size: Number(any.size) || 0,
    status: String(any.status || ''),
    ready: Number(any.ready) || 0,
    uploadedAt: Number(any.uploaded_at ?? any.uploadedAt) || 0,
    bucket: String(any.bucket || ''),
    audio: String(any.audio || ''),
    foreignProof: String(any.foreign_proof ?? any.foreignProof) || '',
    ptProof: String(any.pt_proof ?? any.ptProof) || '',
    imdbId: String(any.imdb_id ?? any.imdbId) || '',
    workTitle: String(any.work_title ?? any.workTitle) || '',
    workIsBr: Number(any.work_is_br ?? any.workIsBr) || 0,
    workDubbed: Number(any.work_dubbed ?? any.workDubbed) || 0,
    workLied: Number(any.work_lied ?? any.workLied) || 0,
    season: any.season == null ? null : Number(any.season),
    episode: any.episode == null ? null : Number(any.episode),
    cached: String(any.cached || 'unknown'),
    cachedAt: Number(any.cached_at ?? any.cachedAt) || 0,
    firstSeenAt: Number(any.first_seen_at ?? any.firstSeenAt) || 0,
    lastSeenAt: Number(any.last_seen_at ?? any.lastSeenAt) || 0,
    auditedAt: Number(any.audited_at ?? any.auditedAt) || 0,
    deletedAt: Number(any.deleted_at ?? any.deletedAt) || 0,
    deleteReason: String(any.delete_reason ?? any.deleteReason) || '',
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
        adapter TEXT NOT NULL, account TEXT NOT NULL, service_id TEXT NOT NULL,
        hash TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '', ready INTEGER NOT NULL DEFAULT 0,
        uploaded_at INTEGER NOT NULL DEFAULT 0,
        bucket TEXT NOT NULL DEFAULT '',
        audio TEXT NOT NULL DEFAULT '',
        foreign_proof TEXT NOT NULL DEFAULT '',
        pt_proof TEXT NOT NULL DEFAULT '',
        imdb_id TEXT NOT NULL DEFAULT '', work_title TEXT NOT NULL DEFAULT '',
        work_is_br INTEGER NOT NULL DEFAULT 0, work_dubbed INTEGER NOT NULL DEFAULT 0,
        work_lied INTEGER NOT NULL DEFAULT 0,
        season INTEGER, episode INTEGER,
        cached TEXT NOT NULL DEFAULT 'unknown',
        cached_at INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL DEFAULT 0,
        audited_at INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER NOT NULL DEFAULT 0, delete_reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (adapter, account, service_id)
      );
      CREATE INDEX IF NOT EXISTS magnet_hash ON magnet (hash);
      CREATE INDEX IF NOT EXISTS magnet_imdb ON magnet (imdb_id);
      CREATE INDEX IF NOT EXISTS magnet_bucket ON magnet (bucket);
      CREATE INDEX IF NOT EXISTS magnet_cached ON magnet (cached);
    `);
    // Migração: bancos criados antes da auditoria durável não têm a coluna.
    // SQLite não tem ADD COLUMN IF NOT EXISTS — o erro de duplicata é o "já
    // existe", ignorado. O UPDATE marca como auditadas as linhas cuja prova
    // 'arquivo' veio de medição real (scan por título nunca grava 'arquivo'
    // sem evidência viva; ver classifyWithEvidence/noteAudit).
    try {
      db.exec('ALTER TABLE magnet ADD COLUMN audited_at INTEGER NOT NULL DEFAULT 0');
    } catch { /* coluna já existe */ }
    try {
      db.exec("UPDATE magnet SET audited_at = last_seen_at WHERE audited_at = 0 AND pt_proof = 'arquivo'");
    } catch { /* melhor esforço */ }
    const getStmt = db.prepare('SELECT * FROM magnet WHERE adapter = ? AND account = ? AND service_id = ?');
    const insertStmt = db.prepare(`INSERT INTO magnet (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    const updateStmt = db.prepare(`UPDATE magnet SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE adapter = ? AND account = ? AND service_id = ?`);
    const markStmt = db.prepare('UPDATE magnet SET deleted_at = ?, delete_reason = ? WHERE adapter = ? AND account = ? AND service_id = ?');
    const clearStmt = db.prepare('DELETE FROM magnet');
    const listStmt = db.prepare('SELECT * FROM magnet WHERE adapter = ? AND account = ?');

    return {
      getRow(adapter, account, serviceId) {
        const r = getStmt.get(adapter, account, String(serviceId)) as Record<string, unknown> | null;
        return r ? parse(r) : null;
      },
      insertRow(row) { insertStmt.run(...render(row)); },
      updateRow(row) { updateStmt.run(...render(row), row.adapter, row.account, row.serviceId); },
      listRows(adapter, account) {
        return (listStmt.all(adapter, account) as Record<string, unknown>[]).map(parse);
      },
      markDeleted(adapter, account, items) {
        const now = Date.now();
        db.exec('BEGIN');
        try {
          for (const item of items) markStmt.run(now, item.reason, adapter, account, String(item.serviceId));
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
        return items.length;
      },
      clearRows() { try { clearStmt.run(); } catch {} },
      closeEngine() {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.close();
        } catch (err) {
          log.warn('[catalog] falha ao fechar persistência:', log.errorMessage(err));
        }
      },
    };
  } catch (err: unknown) {
    log.warn('[catalog] SQLite indisponível, seguindo só em memória:', log.errorMessage(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memória engine (fallback)
// ---------------------------------------------------------------------------

function memoryEngine(): Engine {
  const map = new Map<string, Row>();
  const pk = (adapter: string, account: string, serviceId: string | number) => `${adapter}:${account}:${serviceId}`;
  return {
    getRow(adapter, account, serviceId) {
      return map.get(pk(adapter, account, String(serviceId))) || null;
    },
    insertRow(row) { map.set(pk(row.adapter, row.account, row.serviceId), row); },
    updateRow(row) { map.set(pk(row.adapter, row.account, row.serviceId), row); },
    listRows(adapter, account) {
      const prefixKey = `${adapter}:${account}:`;
      const out: Row[] = [];
      for (const [k, row] of map) {
        if (k.startsWith(prefixKey)) out.push(row);
      }
      return out;
    },
    markDeleted(adapter, account, items) {
      const now = Date.now();
      for (const item of items) {
        const row = map.get(pk(adapter, account, item.serviceId));
        if (row && row.deletedAt === 0) {
          row.deletedAt = now;
          row.deleteReason = item.reason;
        }
      }
      return items.length;
    },
    clearRows() { map.clear(); },
    closeEngine() { map.clear(); },
  };
}

// ---------------------------------------------------------------------------
// Abertura lazy e estado global
// ---------------------------------------------------------------------------

let store: Engine | null = null;
let openedPath: string | null = null;

/**
 * Abre o armazenamento. Idempotente: se já aberto, é no-op — a primeira
 * chamada define o banco. `dbPathOverride` só vale na primeira abertura (os
 * testes apontam um arquivo temporário); sem override usa `config.catalog.dbPath`.
 */
export function open(dbPathOverride?: string): void {
  if (store) return;
  const dbPath = dbPathOverride ?? config.catalog.dbPath;
  openedPath = dbPath;
  store = sqliteEngine(dbPath) ?? memoryEngine();
}

export function engine(): Engine {
  if (!store) open();
  // open() garante store não-nulo (fallback em memória nunca retorna nulo).
  return store as Engine;
}

/** Fecha o engine (e o arquivo SQLite) e esquece o path para a próxima `open`. */
export function close(): void {
  if (store) {
    try { store.closeEngine(); } catch { /* idem: best-effort */ }
  }
  store = null;
  openedPath = null;
}

/** Teste: limpa linhas, fecha e esquece o path — cada teste começa limpo. */
export function resetForTests(): void {
  if (store) {
    try { store.clearRows(); } catch { /* ignore */ }
    try { store.closeEngine(); } catch { /* ignore */ }
  }
  store = null;
  openedPath = null;
}

// Adapter do OPERADOR (config.debrid.service) — default de quem não recebe
// `adapterId` explícito (report, dedup, review e auditoria).
export function configOperatorAdapter(): string {
  return String(config.debrid.service || 'alldebrid').toLowerCase();
}

// ---------------------------------------------------------------------------
// Upsert que preserva o histórico
// ---------------------------------------------------------------------------

export function upsertRow(e: Engine, row: Row): void {
  const prev = e.getRow(row.adapter, row.account, row.serviceId);
  if (!prev) { e.insertRow(row); return; }
  // A prova medida em AUDITORIA DE ARQUIVOS é durável. O `fileEvidence` do
  // índice tem TTL finito (herdado do pipeline de busca): quando ele expira,
  // o scan recalcula só pelo título do post — e NÃO pode apagar o
  // veredito que foi medido nos arquivos reais. Só uma evidência NOVA
  // (row.auditedAt > 0, ou seja, este scan ainda vê fileEvidence) sobrescreve.
  // Título nunca vence arquivo: um post pode mentir o áudio, o .mkv não.
  //
  // Preservar NÃO é incondicional: só vale evidência REAL de arquivo. Uma
  // absolvição por TÍTULO (`ptProof === 'titulo'`, ex. produzida pelo BR_MARK
  // genérico `.org`) NÃO congela: um re-scan com o título corrigido precisa
  // poder recalcular e revogar a prova falsa. A condição de arquivo é
  // `prev.ptProof === 'arquivo'` ou a condena medida em path no runtime
  // (`prev.foreignProof !== '' && prev.auditedAt > 0` — `markAuditedUnlessCondemned`
  // nunca marca quem está condenado; foreignProof+auditedAt vem de `noteAudit`).
  const keepAudited =
    row.auditedAt === 0 &&
    (prev.ptProof === 'arquivo' || (prev.foreignProof !== '' && prev.auditedAt > 0));
  const merged: Row = {
    ...row,
    // first_seen é a primeira aparição — nunca regride.
    firstSeenAt: prev.firstSeenAt || row.firstSeenAt,
    // Uma vez medida nos arquivos, a linha fica marcada para sempre (fila
    // retomável); só avança no tempo, nunca regride a 0.
    auditedAt: Math.max(prev.auditedAt, row.auditedAt),
    foreignProof: keepAudited ? prev.foreignProof : row.foreignProof,
    ptProof: keepAudited ? prev.ptProof : row.ptProof,
    audio: keepAudited ? (row.audio || prev.audio) : row.audio,
    // cached_at só renova quando o veredito MUDA (evita re-datar leitura quieta).
    cachedAt: prev.cached !== '' && row.cached === prev.cached ? prev.cachedAt : row.cachedAt,
    // O MESMO service_id voltou à conta: reabre (limpa o tombstone).
    deletedAt: 0,
    deleteReason: '',
  };
  e.updateRow(merged);
}
