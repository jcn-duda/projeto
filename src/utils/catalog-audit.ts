// Catálogo durável — FILA DE AUDITORIA DE ARQUIVOS.
//
// A fila retomável é o carimbo `audited_at` no próprio catálogo (durável, não
// depende do TTL do release-index). `noteAudit` espelha na linha o que o
// wrapper (`catalog-env.ts`) acabou de medir via `recordFileEvidence`; os
// `markAudited*` fecham a rodada sem re-visitar item já aprendido.
//
// Fachada pública: `src/utils/catalog.ts`; linhas/engine: `catalog-rows.ts`;
// rótulo da prova: `catalog-classify.ts`.
import * as metrics from './metrics.js';
import { fileEvidence } from './release-index.js';
import { audioBucket, audioFromTitle, foreignVerdict } from './audio-quality.js';
import { foreignProofLabel } from './catalog-classify.js';
import { engine, configOperatorAdapter } from './catalog-rows.js';

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
 * Devolve à fila as linhas PRESAS: já marcadas `audited_at`, mas sem
 * `fileEvidence` no cache. Elas nunca mais seriam relidas — `upsertRow` guarda
 * `auditedAt` com `Math.max`, então o carimbo não regride, e o `scan` só
 * reclassifica de graça quem AINDA tem evidência viva. Quando o TTL do índice
 * (30 dias) vence, a linha fica fora da fila para sempre e uma correção do
 * classificador não a alcança — foi o caso depois de `foreignVerdict`,
 * `BR_MARK` e o generic DUB mudarem no mesmo dia.
 *
 * NÃO mexe nas provas, de propósito: a absolvição medida em arquivo
 * (`ptProof === 'arquivo'`) segue protegendo o acervo BR até que uma leitura
 * NOVA a substitua. Limpar a prova junto abriria uma janela em que a linha vale
 * só pelo título — e título condena o que o arquivo tinha absolvido.
 *
 * Quem ainda tem evidência em cache não é tocado: essa linha já reclassifica
 * sozinha no próximo `scan`, sem gastar rede.
 */
export function requeueAudit(
  account: string,
  adapterId?: string,
  { limit }: { limit?: number } = {},
): { requeued: number; keptWithEvidence: number; alreadyQueued: number } {
  const e = engine();
  const adapter = adapterId || configOperatorAdapter();
  const teto = limit == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit));
  let requeued = 0;
  let keptWithEvidence = 0;
  let alreadyQueued = 0;
  for (const r of e.listRows(adapter, account)) {
    if (r.deletedAt !== 0) continue;
    if (r.auditedAt === 0) { alreadyQueued += 1; continue; }
    if (fileEvidence(r.hash)) { keptWithEvidence += 1; continue; }
    if (requeued >= teto) continue;
    r.auditedAt = 0;
    e.updateRow(r);
    requeued += 1;
  }
  metrics.count('catalog.audit.requeued', requeued);
  return { requeued, keptWithEvidence, alreadyQueued };
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
