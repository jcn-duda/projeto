// Catálogo durável — PLANOS DE LIMPEZA E RODEIO MANUAL.
//
// Três planos de leitura pura: a limpeza de ESTRANGEIRO PROVADO (guardas
// contadas: protegido, ativo, jovem, sem condenação, `known`), a lista para o
// operador ESCOLHER na mão (maiores primeiro) e a deleção MANUAL dos ids que
// ele marcou. Quem aplica é o wrapper (`catalog-env.ts`) via `applyDeletions`.
//
// Fachada pública: `src/utils/catalog.ts`; linhas/engine: `catalog-rows.ts`;
// DedupRow/toDedupRow: `catalog-dedup.ts`.
import * as held from '../debrid/protected.js';
import { engine, isActive, configOperatorAdapter } from './catalog-rows.js';
import { toDedupRow } from './catalog-dedup.js';
import type { DedupRow } from './catalog-dedup.js';

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
export type ReviewRow = DedupRow & {
  bucket: string;
  foreignProof: string;
  ptProof: string;
  cached: string;
  imdbId: string;
};

/**
 * Linhas para o operador ESCOLHER na mão, maiores primeiro (é espaço que ele
 * quer de volta). Leitura pura.
 *
 * Existe porque as regras automáticas são deliberadamente conservadoras: o
 * `foreignVerdict` só condena com prova positiva de estrangeiro, e a trava de
 * idade segura o resto. Numa conta que gira em menos de 48h isso deixa a
 * limpeza quase parada, e o operador — que enxerga o título e sabe o que é
 * dele — precisa de uma saída manual. `bucket` filtra o balde ('lixo', 'dual',
 * 'pt', 'dub'); vazio traz todos.
 */
export function listForReview(
  account: string,
  adapterId?: string,
  { bucket, limit }: { bucket?: string; limit?: number } = {},
): ReviewRow[] {
  const e = engine();
  const adapter = adapterId || configOperatorAdapter();
  const teto = limit == null ? 100 : Math.max(0, Math.trunc(limit));
  const out: ReviewRow[] = [];
  for (const r of e.listRows(adapter, account)) {
    if (r.deletedAt !== 0) continue;
    if (bucket && r.bucket !== bucket) continue;
    out.push({
      ...toDedupRow(r, account, adapter),
      bucket: r.bucket,
      foreignProof: r.foreignProof,
      ptProof: r.ptProof,
      cached: r.cached,
      imdbId: r.imdbId,
    });
  }
  out.sort((a, b) => (b.size || 0) - (a.size || 0));
  return out.slice(0, teto);
}

/**
 * Plano da deleção MANUAL: o operador mandou estes `serviceIds` e nada mais.
 *
 * Sem regra de classificação e sem trava de idade — a escolha explícita É a
 * autorização, e é justamente por isso que existe. A única guarda que fica é
 * `active`: download em curso não aparece como tal no título, e apagá-lo joga
 * fora trabalho que o operador não tinha como ver na tela. Protegido passa,
 * mas volta marcado no relatório para ele saber o que fez.
 */
export function planManualDeletion(
  account: string,
  adapterId: string,
  serviceIds: Array<string | number>,
): { targets: CleanupTarget[]; skipped: { missing: number; active: number } } {
  const e = engine();
  const skipped = { missing: 0, active: 0 };
  const targets: CleanupTarget[] = [];
  const vistos = new Set<string>();
  for (const raw of serviceIds || []) {
    const serviceId = String(raw ?? '');
    if (!serviceId || vistos.has(serviceId)) continue;
    vistos.add(serviceId);
    const r = e.getRow(adapterId, account, serviceId);
    if (!r || r.deletedAt !== 0) { skipped.missing += 1; continue; }
    if (isActive(r.status)) { skipped.active += 1; continue; }
    targets.push({
      serviceId: r.serviceId,
      hash: r.hash,
      filename: r.filename,
      size: r.size,
      reason: 'manual',
      // A deleção manual não consulta o snapshot de preexistentes: a escolha
      // explícita do operador já é a autorização que o `known` representaria.
      known: false,
    });
  }
  return { targets, skipped };
}
