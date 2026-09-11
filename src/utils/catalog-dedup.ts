// Catálogo durável — DEDUPLICAÇÃO (T1/T2) E EXECUÇÃO DE DELETES.
//
// O plano é LEITURA PURA (`planDedup`): quem decide aplicar é o wrapper
// (`catalog-env.ts`), que monta a lista de deleções — incluindo o skipMark do
// anti-reenchimento — e a passa ao `applyDeletions` com o executor do adapter.
//
// Fachada pública: `src/utils/catalog.ts`; camada de linhas/engine:
// `catalog-rows.ts`.
import * as metrics from './metrics.js';
import * as held from '../debrid/protected.js';
import { engine, isActive, configOperatorAdapter } from './catalog-rows.js';
import type { Row } from './catalog-rows.js';

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

export function toDedupRow(r: Row, account: string, adapter: string): DedupRow {
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
          // O `m` que disparou o corte abre o NOVO cluster — se aqui víssemos
          // `cluster = []`, o item se perderia e o último cluster (que vem só
          // do `else`) nunca incluiria a release que cruzou a tolerância.
          clusterBase = m.size;
          cluster = [m];
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

export type Deletion = { serviceId: string | number; hash: string; reason: string; filename?: string; skipMark?: boolean };

/**
 * Executa deletes via `executor` (injetado; quem chama liga ao `deleteMagnets`
 * do adapter) e marca tombstone SÓ do que saiu. Falha do executor deixa a
 * linha VIVA. Registra `catalog.dedup.deleted`/`catalog.dedup.failed`.
 *
 * `hooks.onDeleted` (opcional, 8.14): chamado por deleção BEM-SUCEDIDA com o
 * hash e o nome da release — é onde o chamador liga o anti-reenchimento
 * (`markReuploadBlocked`) para o adaptador que tem o marcador (AllDebrid).
 * Com `removedIds` no retorno do executor, a sucesso exige o id NELE: falha
 * de delete nunca dispara o hook.
 */
export async function applyDeletions(
  account: string,
  adapterId: string,
  deletions: Deletion[],
  executor: (ids: Array<string | number>) => Promise<{ ok: number; falhas: Array<{ message?: string }>; removedIds?: Array<string | number> }>,
  hooks?: { onDeleted?: (hash: string, filename?: string) => void },
): Promise<{ ok: number; falhas: number }> {
  const e = engine();
  let ok = 0;
  let failed = 0;
  for (const del of deletions) {
    try {
      const res = await executor([del.serviceId]);
      const saiu = Boolean(
        res && Array.isArray(res.falhas) && res.falhas.length === 0 && Number(res.ok) >= 1 &&
        (!res.removedIds || res.removedIds.map(String).includes(String(del.serviceId))),
      );
      if (saiu) {
        e.markDeleted(adapterId, account, [{ serviceId: del.serviceId, reason: del.reason }]);
        if (!del.skipMark) hooks?.onDeleted?.(del.hash, del.filename);
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
