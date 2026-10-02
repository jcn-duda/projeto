// Catálogo durável — VARREDURA DA CONTA E RELATÓRIOS.
//
// O `scan` é o único escritor de larga escala: recebe a lista de magnets da
// conta (via `catalog-env.ts`, wrapper do adapter do operador), upserta cada
// linha com classificação/provas, associa o índice reverso hash → obra e
// tomba quem sumiu. `report` e `row` são leitura pura do último estado.
//
// Fachada pública: `src/utils/catalog.ts`; camada de linhas/engine:
// `catalog-rows.ts`; classificação: `catalog-classify.ts`.
import * as metrics from './metrics.js';
import { fileEvidence, snapshotAllWorks } from './release-index.js';
import { releaseStatus } from './br-coverage.js';
import type { OperatorCtx } from './br-coverage.js';
import type { AllDebridMagnetRow } from '../debrid/alldebrid.js';
import { engine, configOperatorAdapter, upsertRow } from './catalog-rows.js';
import { classifyByTitle, classifyWithEvidence } from './catalog-classify.js';
import type { Proof } from './catalog-classify.js';

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
