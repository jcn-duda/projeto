// Catálogo durável da conta AllDebrid + limpador BR com prova.
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
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import {
  audioBucket, foreignVerdict, hasExplicitForeignAudio, strongEnSceneMark, audioFromTitle,
} from './audio-quality.js';
import { fileEvidence, snapshotAllWorks } from './release-index.js';
import { releaseStatus, operatorCtx } from './br-coverage.js';
import type { OperatorCtx } from './br-coverage.js';
import * as held from '../debrid/protected.js';
import type { AllDebridMagnetRow } from '../debrid/alldebrid.js';

const _require = createRequire(import.meta.url);

// Estados dos quais a AllDebrid ainda está trabalhando: a limpeza nunca toca
// download em curso. Replicada aqui com a MESMA expressão do adaptador
// (`src/debrid/alldebrid.ts`, que não a exporta) — se ela mudar lá, este
// comentário e os testes que cobrem as guardas apontam o desvio.
const ACTIVE_RE = /^(?:queued|downloading|processing|compressing|moving|uploading)$/i;

function isActive(status: string): boolean {
  return ACTIVE_RE.test(String(status || ''));
}

// ---------------------------------------------------------------------------
// Linhas e engine
// ---------------------------------------------------------------------------

type Row = {
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

type MarkInput = { serviceId: string | number; reason: string };

interface Engine {
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

function engine(): Engine {
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

// ---------------------------------------------------------------------------
// Upsert que preserva o histórico
// ---------------------------------------------------------------------------

function upsertRow(e: Engine, row: Row): void {
  const prev = e.getRow(row.adapter, row.account, row.serviceId);
  if (!prev) { e.insertRow(row); return; }
  // A prova medida em AUDITORIA DE ARQUIVOS é durável. O `fileEvidence` do
  // índice tem TTL curto (15min, herdado do pipeline de busca): quando ele
  // expira, o scan recalcula só pelo título do post — e NÃO pode apagar o
  // veredito que foi medido nos arquivos reais. Só uma evidência NOVA
  // (row.auditedAt > 0, ou seja, este scan ainda vê fileEvidence) sobrescreve.
  // Título nunca vence arquivo: um post pode mentir o áudio, o .mkv não.
  const keepAudited = prev.auditedAt > 0 && row.auditedAt === 0;
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

// ---------------------------------------------------------------------------
// Classificação e o rótulo da PROVA
// ---------------------------------------------------------------------------

function foreignProofLabel(candidates: string[]): string {
  for (const p of candidates) {
    if (strongEnSceneMark(p)) return 'cena';
  }
  for (const p of candidates) {
    if (hasExplicitForeignAudio(p)) return 'audio';
  }
  return 'sim';
}

type Proof = { bucket: string; audio: string; foreignProof: string; ptProof: string };

// Sem evidência de arquivo: o título do post é a única fonte.
function classifyByTitle(filename: string): Proof {
  const verdict = foreignVerdict(filename);
  let foreignProof = '';
  let ptProof = '';
  if (verdict === 'condena') foreignProof = foreignProofLabel([filename]);
  else if (verdict === 'absolve') ptProof = 'titulo';
  return { audio: '', bucket: audioBucket(filename), foreignProof, ptProof };
}

// Prova dos ARQUIVOS reais (fileEvidence): o rótulo de áudio não vem do título.
function classifyWithEvidence(filename: string, evidenceN: string | undefined): Proof {
  const paths = evidenceN ? [evidenceN] : [];
  const verdict = foreignVerdict(filename, paths);
  let foreignProof = '';
  let ptProof = '';
  if (verdict === 'condena') foreignProof = foreignProofLabel(paths.length ? [filename, ...paths] : [filename]);
  else if (verdict === 'absolve') ptProof = 'arquivo';
  return { bucket: audioBucket(filename), audio: '', foreignProof, ptProof };
}

// ---------------------------------------------------------------------------
// Tipos públicos e API
// ---------------------------------------------------------------------------

export type CatalogReport = {
  scannedAt: number;
  /** Quantos magnets processados na última varredura. */
  scanned: number;
  /** Quantos estão ATIVOS agora (deleted_at == 0). */
  magnets: number;
  ready: number;
  totals: { count: number; bytes: number };
  byBucket: Record<string, { count: number; bytes: number }>;
  byCached: Record<string, number>;
  works: { known: number; unknown: number };
  /** Magnets cujo hash não estava no índice reverso (limite keysMatching/L1). */
  unresolvedHashes: number;
};

export type ScanInput = {
  adapterId: string;
  account: string;
  magnets: AllDebridMagnetRow[];
  ctx: OperatorCtx;
};

function emptyReport(scannedAt: number): CatalogReport {
  return {
    scannedAt, scanned: 0, magnets: 0, ready: 0,
    totals: { count: 0, bytes: 0 },
    byBucket: {}, byCached: {},
    works: { known: 0, unknown: 0 }, unresolvedHashes: 0,
  };
}

function configOperatorAdapter(): string {
  return String(config.debrid.service || 'alldebrid').toLowerCase();
}

/** Índice reverso hash → Obra (primeira obra por hash; o snapshot já dedupe). */
function reverseIndex(): Map<string, { imdbId: string; title: string; isBr: boolean; dubbed: boolean; lied: boolean }> {
  const reverse = new Map<string, { imdbId: string; title: string; isBr: boolean; dubbed: boolean; lied: boolean }>();
  for (const [imdbId, releases] of snapshotAllWorks()) {
    for (const rel of releases) {
      if (!rel || !rel.hash || reverse.has(rel.hash)) continue;
      reverse.set(rel.hash, {
        imdbId: String(imdbId),
        title: rel.title || '',
        isBr: Boolean(rel.isBr),
        dubbed: Boolean(rel.dubbed),
        lied: Boolean(rel.lied),
      });
    }
  }
  return reverse;
}

/**
 * Varre a conta: upsert de cada magnet com classificação/provas, associa o
 * índice reverso, mede a disponibilidade quieta e tomba os da última varredura
 * que sumiram. Registra `catalog.scan` e `catalog.scan.unresolved`.
 */
export function scan(input: ScanInput): CatalogReport {
  const e = engine();
  const now = Date.now();
  const report = emptyReport(now);
  report.scanned = input.magnets?.length || 0;

  const reverse = reverseIndex();
  const serviceIdsSeen = new Set<string>();
  const bucketTotals = new Map<string, { count: number; bytes: number }>();
  let unresolved = 0;

  for (const m of input.magnets || []) {
    if (m == null || m.id == null || !m.hash) continue;
    const hash = String(m.hash).toLowerCase();
    const serviceId = String(m.id);
    serviceIdsSeen.add(serviceId);
    const filename = String(m.filename || '').trim();
    const evidence = fileEvidence(hash);
    let proof: Proof;
    if (evidence) {
      proof = { ...classifyWithEvidence(filename, evidence.n), audio: String(evidence.a || '') };
    } else {
      proof = classifyByTitle(filename);
    }
    const work = reverse.get(hash);
    if (!work) unresolved += 1;
    // Para a AllDebrid, magnet `ready` NA CONTA é tocável na hora — é
    // EXATAMENTE o ⚡ que o play usa (o inventário-como-fonte marca esses com
    // ⚡). O `releaseStatus` (ledger RD + davail + mag) só enxerga o que ESTE
    // processo/instância mediu, então o acervo pronto da conta ficaria
    // 'unknown' e o relatório mentiria sobre o que dá ⚡. O releaseStatus
    // quieto continua informando quem NÃO está pronto na conta.
    const cached = m.ready ? 'hit' : releaseStatus({ hash }, input.ctx);

    upsertRow(e, {
      adapter: input.adapterId, account: input.account, serviceId,
      hash, filename, size: Number(m.size) || 0, status: String(m.status || ''),
      ready: m.ready ? 1 : 0,
      uploadedAt: Number(m.uploadDate) || 0,
      bucket: proof.bucket, audio: proof.audio,
      foreignProof: proof.foreignProof, ptProof: proof.ptProof,
      imdbId: work?.imdbId || '', workTitle: work?.title || '',
      workIsBr: work?.isBr ? 1 : 0, workDubbed: work?.dubbed ? 1 : 0, workLied: work?.lied ? 1 : 0,
      season: null, episode: null,
      cached, cachedAt: now,
      firstSeenAt: now, lastSeenAt: now,
      // Se este scan AINDA vê fileEvidence, a linha está auditada (marcador
      // durável; a fila não depende do TTL da evidência).
      auditedAt: evidence ? now : 0,
      deletedAt: 0, deleteReason: '',
    });

    const b = bucketTotals.get(proof.bucket) || { count: 0, bytes: 0 };
    b.count += 1; b.bytes += Number(m.size) || 0;
    bucketTotals.set(proof.bucket, b);
  }

  // Tombstone de sumidos: linha desta conta que não está na lista recebida.
  const all = e.listRows(input.adapterId, input.account);
  const missing = all.filter((r) => r.deletedAt === 0 && !serviceIdsSeen.has(String(r.serviceId)));
  if (missing.length) {
    e.markDeleted(input.adapterId, input.account, missing.map((r) => ({ serviceId: r.serviceId, reason: 'ausente da conta' })));
  }

  // Relatório do estado ATIVO pós-scan.
  for (const r of e.listRows(input.adapterId, input.account)) {
    if (r.deletedAt !== 0) continue;
    report.magnets += 1;
    if (r.ready) report.ready += 1;
    report.totals.count += 1;
    report.totals.bytes += r.size;
    const b = report.byBucket[r.bucket] || { count: 0, bytes: 0 };
    b.count += 1; b.bytes += r.size;
    report.byBucket[r.bucket] = b;
    report.byCached[r.cached] = (report.byCached[r.cached] || 0) + 1;
    if (r.imdbId) report.works.known += 1;
    else report.works.unknown += 1;
  }
  report.unresolvedHashes = unresolved;
  metrics.count('catalog.scan', report.scanned > 0 ? 1 : 0);
  metrics.count('catalog.scan.unresolved', unresolved);
  return report;
}

/**
 * Relatório da LEITURA do banco (último estado), sem rede. `unresolvedHashes`
 * não é persistido entre scans — a leitura estima pelo que ficou sem obra.
 */
export function report(account?: string): CatalogReport {
  const e = engine();
  const out = emptyReport(Date.now());
  const acc = account || 'none';
  for (const r of e.listRows(configOperatorAdapter(), acc)) {
    if (r.deletedAt !== 0) continue;
    out.magnets += 1;
    if (r.ready) out.ready += 1;
    out.totals.count += 1;
    out.totals.bytes += r.size;
    const b = out.byBucket[r.bucket] || { count: 0, bytes: 0 };
    b.count += 1; b.bytes += r.size;
    out.byBucket[r.bucket] = b;
    out.byCached[r.cached] = (out.byCached[r.cached] || 0) + 1;
    if (r.imdbId) out.works.known += 1;
    else out.works.unknown += 1;
  }
  out.unresolvedHashes = out.works.unknown;
  return out;
}

export type DedupRow = {
  serviceId: string;
  hash: string;
  filename: string;
  size: number;
  ready: boolean;
  uploadedAt: number;
  status: string;
  active: boolean;
  protected: boolean;
};

export type DedupGroup = { key: string; keep: DedupRow; kill: DedupRow[] };

function toDedupRow(r: Row, account: string, adapter: string): DedupRow {
  return {
    serviceId: r.serviceId,
    hash: r.hash,
    filename: r.filename,
    size: r.size,
    ready: Boolean(r.ready),
    uploadedAt: r.uploadedAt,
    status: r.status,
    active: isActive(r.status),
    protected: held.isCleanupProtected(r.hash, account, r.adapter || adapter),
  };
}

/** "Devoradores 2026" e "Devoradores.2026" → "devoradores 2026" (chave do T2). */
function filenameNormalized(filename: string): string {
  return String(filename || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[._\-[\]\s]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Sobrevivente: pronto > protegido > mais antigo; se há protegido, ele vence. */
function pickSurvivor(rows: DedupRow[]): DedupRow {
  const sorted = [...rows].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (a.protected !== b.protected) return a.protected ? -1 : 1;
    return (a.uploadedAt || 0) - (b.uploadedAt || 0);
  });
  let winner = sorted[0];
  const anyProtected = sorted.some((r) => r.protected);
  if (anyProtected && !winner.protected) {
    const protectedRow = sorted.find((r) => r.protected);
    if (protectedRow) winner = protectedRow;
  }
  return winner;
}

/**
 * Plano de deduplicação (leitura pura; NENHUMA deleção daqui).
 *  - T1: mesmo hash com 2+ service_ids VIVOS;
 *  - T2: mesmo `filenameNormalized` com 2+ service_ids vivos e tamanhos
 *    dentro da tolerância relativa de 0,5% (mesma release resubida costuma
 *    divergir em alguns KB de metadado — ver caso Devoradores abaixo).
 * Kill nunca toca estado ATIVO e a matemática deixa ≥1 vivo.
 */
export function planDedup(account: string, adapterId?: string): { t1: DedupGroup[]; t2: DedupGroup[] } {
  const e = engine();
  const adapter = adapterId || configOperatorAdapter();
  const active = e.listRows(adapter, account).filter((r) => r.deletedAt === 0);
  const rows = active.map((r) => toDedupRow(r, account, adapter));

  // Converte um cluster já formado em grupo T2 (2+ membros) e o anexa a `out`.
  const emit = (out: DedupGroup[], nome: string, base: number, members: DedupRow[]): void => {
    if (members.length < 2) return;
    const winner = pickSurvivor([...members]);
    const kill = members.filter((m) => m.serviceId !== winner.serviceId).filter((m) => !m.active);
    if (kill.length === 0) return;
    out.push({ key: `${nome}\u0000${base}`, keep: winner, kill });
  };

  const build = (keyOf: (r: DedupRow) => string): DedupGroup[] => {
    const byKey = new Map<string, DedupRow[]>();
    for (const r of rows) {
      const k = keyOf(r);
      if (!k) continue;
      const list = byKey.get(k) || [];
      list.push(r);
      byKey.set(k, list);
    }
    const groups: DedupGroup[] = [];
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      const winner = pickSurvivor([...members]);
      const kill = members.filter((m) => m.serviceId !== winner.serviceId).filter((m) => !m.active);
      if (kill.length === 0) continue;
      groups.push({ key, keep: winner, kill });
    }
    return groups;
  };

  const t1 = build((r) => r.hash);
  // T2 exige tamanho CONHECIDO: size sem tamanho provado ("1 KB" sentinela das
  // fontes BR vira 0 aqui) não prova "mesma release" — dois magnets distintos
  // de tamanho desconhecido colidiriam no grupo e um seria apagado. Dentro do
  // mesmo nome normalizado, os tamanhos são clusterizados por tolerância de
  // 0,5% contra o MENOR size do cluster corrente (comparação NÃO encadeada:
  // `m.size - clusterBase <= clusterBase * 0.005`, com clusterBase = o menor do
  // cluster, que é o primeiro após ordenar por size crescente). Chave do grupo:
  // `${nome}\u0000${clusterBase}`.
  //
  // Caso medido na conta real: dois "Devoradores de Estrelas 2026 … DUAL 5.1",
  // ids 713999501 (hash f824bfdf…) e 713999816 (hash 2a9c9448…), sizes
  // 3.357.116.179 e 3.357.118.139 — DIFERENÇA DE 1.960 BYTES (0,00006%).
  // Nome idêntico após normalização, mesma release resubida com metadado
  // divergindo; a UI da AllDebrid arredonda os dois para "3.13 GB". Sem a
  // tolerância, o T2 por (nome, size exato) nunca pega essa duplicata — a mais
  // comum do mundo real.
  const t2: DedupGroup[] = [];
  {
    const byName = new Map<string, DedupRow[]>();
    for (const r of rows) {
      if (r.size <= 0) continue;
      const nome = filenameNormalized(r.filename);
      if (!nome) continue;
      const list = byName.get(nome) || [];
      list.push(r);
      byName.set(nome, list);
    }
    for (const [nome, members] of byName) {
      const sorted = [...members].sort((a, b) => (a.size || 0) - (b.size || 0));
      let clusterBase: number | null = null;
      let cluster: DedupRow[] = [];
      for (const m of sorted) {
        if (clusterBase != null && m.size - clusterBase > clusterBase * 0.005) {
          emit(t2, nome, clusterBase, cluster);
          clusterBase = m.size;
          cluster = [];
        } else {
          if (clusterBase == null) clusterBase = m.size;
          cluster.push(m);
        }
      }
      if (cluster.length) emit(t2, nome, clusterBase as number, cluster);
    }
  }
  return { t1, t2 };
}

type Deletion = { serviceId: string | number; hash: string; reason: string };

function flattenDeletions(plan: { t1: DedupGroup[]; t2: DedupGroup[] }, max?: number): Deletion[] {
  const out: Deletion[] = [];
  for (const group of plan.t1) for (const k of group.kill) out.push({ serviceId: k.serviceId, hash: k.hash, reason: 'duplicado' });
  for (const group of plan.t2) for (const k of group.kill) out.push({ serviceId: k.serviceId, hash: k.hash, reason: 'duplicado por arquivo' });
  const byId = new Map<string, Deletion>();
  for (const d of out) byId.set(String(d.serviceId), d);
  let list = [...byId.values()];
  if (max != null && Number.isFinite(max)) list = list.slice(0, Math.max(0, Math.trunc(max)));
  return list;
}

/**
 * Executa deletes via `executor` (injetado; quem chama liga ao `deleteMagnets`
 * do adapter) e marca tombstone SÓ do que saiu. Falha do executor deixa a
 * linha VIVA. Registra `catalog.dedup.deleted`/`catalog.dedup.failed`.
 */
export async function applyDeletions(
  account: string,
  adapterId: string,
  deletions: Deletion[],
  executor: (ids: Array<string | number>) => Promise<{ ok: number; falhas: Array<{ message?: string }> }>,
): Promise<{ ok: number; falhas: number }> {
  const e = engine();
  let ok = 0;
  let failed = 0;
  for (const del of deletions) {
    try {
      const res = await executor([del.serviceId]);
      if (res && Array.isArray(res.falhas) && res.falhas.length === 0 && Number(res.ok) >= 1) {
        e.markDeleted(adapterId, account, [{ serviceId: del.serviceId, reason: del.reason }]);
        ok += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  metrics.count('catalog.dedup.deleted', ok);
  metrics.count('catalog.dedup.failed', failed);
  return { ok, falhas: failed };
}

export type CleanupTarget = {
  serviceId: string | number;
  hash: string;
  filename: string;
  size: number;
  reason: string;
  /** hash ∈ knownHashes — o acervo que já era do operador antes do addon. */
  known: boolean;
};

/**
 * Planeja a limpeza de ESTRANGEIRO PROVADO (`foreign_proof != ''`), do mais
 * antigo para o mais novo, teto `max`. Guardas contadas: protegido, ativo,
 * jovem, sem condenação e `known` (acervo do operador — os hashes vindos em
 * `knownHashes`, o snapshot `knownBefore` da conta).
 *
 * A guarda `known` é um OPT-OUT explícito do operador, por isso recebe um
 * switch no próprio chamador (`includeKnown`). Com `includeKnown` falso/ausente,
 * alvos `known` são CONTADOS em `skipped.known` e NÃO entram em `targets`
 * (comportamento default conservado — protege o acervo pré-existente). Com
 * `includeKnown` true, os alvos `known` ENTRAM em `targets` e a flag `known`
 * continua no JSON para o painel marcar "(preexistente)". `skipped.known` só
 * conta quando a guarda está LIGADA (sem includeKnown).
 */
export function planForeignCleanup(
  account: string,
  adapterId: string,
  {
    minAgeMs,
    max,
    knownHashes,
    includeKnown,
  }: { minAgeMs: number; max: number; knownHashes?: Iterable<string> | null; includeKnown?: boolean },
): { targets: CleanupTarget[]; skipped: { protected: number; active: number; young: number; notCondemned: number; known: number } } {
  const e = engine();
  const all = e.listRows(adapterId, account).filter((r) => r.deletedAt === 0);
  const skipped = { protected: 0, active: 0, young: 0, notCondemned: 0, known: 0 };
  // Mesma regra do sweepUndubbed: o que JÁ ERA da conta antes do addon não é
  // escolha nossa. Sem o snapshot (fail-safe fechado) quem chama NEM DEVE
  // planejar/apply — a guarda dura na camada de wrapper.
  const includesKnown = includeKnown === true;
  const excludes = new Set<string>();
  for (const h of knownHashes || []) if (h) excludes.add(String(h).toLowerCase());
  const suspects = all.filter((r) => r.foreignProof !== '');
  for (const r of all) if (r.foreignProof === '') skipped.notCondemned += 1;
  suspects.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
  const targets: CleanupTarget[] = [];
  const now = Date.now();
  const teto = Math.max(0, Math.trunc(max));
  for (const r of suspects) {
    if (teto > 0 && targets.length >= teto) break;
    const isKnown = excludes.has(r.hash);
    if (isKnown && !includesKnown) { skipped.known += 1; continue; }
    if (held.isCleanupProtected(r.hash, account, adapterId)) { skipped.protected += 1; continue; }
    if (isActive(r.status)) { skipped.active += 1; continue; }
    if (minAgeMs > 0 && r.uploadedAt > 0 && now - r.uploadedAt < minAgeMs) { skipped.young += 1; continue; }
    targets.push({ serviceId: r.serviceId, hash: r.hash, filename: r.filename, size: r.size, reason: 'estrangeiro provado', known: isKnown });
  }
  return { targets, skipped };
}

/**
 * Linhas a auditar (áudio fraco): unknown (sem prova), bucket dual OU lixo —
 * e que ainda NÃO foram auditadas. O marcador retomável é `audited_at` do
 * próprio catálogo (durável): `recordFileEvidence` só grava quando há arquivo
 * de vídeo entre os listados, então um torrent de só .srt/.nfo/rar NUNCA
 * aparece em `fileEvidence` — usar só a evidência como referência fazia a
 * fila re-visitar os mesmos itens para sempre (medido: 1674 auditorias para
 * ~819 magnets, sem dreno). Só o scan com evidência viva ou uma auditoria
 * real zeram a fila. Magnets NÃO-prontos ficam fora: a AllDebrid só lista
 * arquivos em `Ready`, e um não-pronto não é alvo de limpeza de qualquer
 * forma (será auditado quando ficar pronto).
 */
export function rowsNeedingAudit(account: string, limit?: number): Array<{ serviceId: string | number; hash: string }> {
  const e = engine();
  const adapter = configOperatorAdapter();
  const out: Array<{ serviceId: string | number; hash: string }> = [];
  const teto = limit == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit));
  for (const r of e.listRows(adapter, account)) {
    if (r.deletedAt !== 0) continue;
    if (!r.ready) continue;
    const weak = (!r.foreignProof && !r.ptProof) || r.bucket === 'dual' || r.bucket === 'lixo';
    if (!weak) continue;
    if (r.auditedAt > 0 || fileEvidence(r.hash)) continue;
    out.push({ serviceId: r.serviceId, hash: r.hash });
    if (out.length >= teto) break;
  }
  return out;
}

/**
 * Espelha no catálogo a auditoria de arquivos que o wrapper (debrid/index)
 * acabou de medir (o `recordFileEvidence` já persistiu a evidência no
 * release-index; aqui é só a linha do catálogo).
 */
export function noteAudit(
  account: string,
  serviceId: string | number,
  hash: string,
  files: Array<{ path?: string; size?: number | null }>,
): void {
  const adapter = configOperatorAdapter();
  const e = engine();
  const existing = e.getRow(adapter, account, serviceId);
  if (!existing) return;
  const filename = existing.filename;
  const paths = (files || []).map((f) => String(f.path || '')).filter(Boolean);
  const bucket = audioBucket(filename);
  const audioIdioma = paths.length ? paths.map((p) => audioFromTitle(p)).find(Boolean) || '' : '';
  const verdict = foreignVerdict(filename, paths);
  let foreignProof = '';
  let ptProof = '';
  if (verdict === 'condena') foreignProof = foreignProofLabel(paths.length ? [filename, ...paths] : [filename]);
  else if (verdict === 'absolve') ptProof = 'arquivo';
  existing.bucket = bucket;
  existing.audio = audioIdioma;
  existing.foreignProof = foreignProof;
  existing.ptProof = ptProof;
  existing.lastSeenAt = Date.now();
  existing.auditedAt = Date.now();
  e.updateRow(existing);
}

/**
 * Marca a linha como auditada SEM mudar a classificação: usado quando o
 * magnet está pronto mas a AllDebrid não lista arquivos (nada a aprender).
 * Impede que a fila re-visite o mesmo ítem para sempre.
 */
export function markAudited(account: string, serviceId: string | number): void {
  const adapter = configOperatorAdapter();
  const e = engine();
  const existing = e.getRow(adapter, account, serviceId);
  if (!existing || existing.auditedAt > 0) return;
  existing.auditedAt = Date.now();
  e.updateRow(existing);
}

/**
 * Como `markAudited`, mas NÃO congela uma linha que está CONDENADA pelo
 * TÍTULO (`foreign_proof != ''`) quando não há arquivos lidos. Uma condenação
 * só pelo título do post ainda pode ser ABSOLVIDA pelos arquivos REAIS numa
 * rodada futura — o post pode mentir o áudio, o .mkv não. Congelá-la como
 * "nada a aprender" a deixaria parada com `keepAudited` no upsert, negando a
 * única chance de absolvição (falso positivo apaga acervo BR bom). Marca
 * apenas quando a linha existe, `deleted_at == 0` e `foreign_proof == ''`
 * (linha `unknown`/`dual`/`lixo` sem condenação). Linhas condenadas continuam
 * na fila de auditoria até os arquivos reais reconfirmarem ou absolverem.
 */
export function markAuditedUnlessCondemned(account: string, serviceId: string | number): void {
  const adapter = configOperatorAdapter();
  const e = engine();
  const existing = e.getRow(adapter, account, serviceId);
  if (!existing || existing.deletedAt !== 0 || existing.foreignProof !== '' || existing.auditedAt > 0) return;
  existing.auditedAt = Date.now();
  e.updateRow(existing);
}

/**
 * Linha única (leitura para observação/teste): estado durável do magnet na
 * conta. Retorna null quando a linha não existe.
 */
export function row(
  account: string,
  serviceId: string | number,
): {
  hash: string; filename: string; size: number; ready: boolean; status: string;
  uploadedAt: number; bucket: string; audio: string; foreignProof: string;
  ptProof: string; imdbId: string; firstSeenAt: number; lastSeenAt: number;
  auditedAt: number; cached: string; cachedAt: number; deletedAt: number; deleteReason: string;
} | null {
  const adapter = configOperatorAdapter();
  const r = engine().getRow(adapter, account, serviceId);
  if (!r) return null;
  return {
    hash: r.hash, filename: r.filename, size: r.size, status: r.status,
    ready: Boolean(r.ready), uploadedAt: r.uploadedAt, bucket: r.bucket,
    audio: r.audio, foreignProof: r.foreignProof, ptProof: r.ptProof,
    imdbId: r.imdbId, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
    auditedAt: r.auditedAt, cached: r.cached, cachedAt: r.cachedAt,
    deletedAt: r.deletedAt, deleteReason: r.deleteReason,
  };
}

export { operatorCtx };