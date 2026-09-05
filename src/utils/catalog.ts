// Catálogo durável da conta AllDebrid + limpador BR com prova — FACHADA.
//
// Dividido sob a catraca de 400 linhas (.line-budget.json) em camadas:
//   catalog-rows.ts     linhas, engines SQLite/memória, open/close, upsert
//   catalog-classify.ts classificação e o rótulo da prova (cena/audio/arquivo)
//   catalog-scan.ts     varredura da conta, relatórios e leitura de linha
//   catalog-dedup.ts    deduplicação T1/T2 e execução de deletes
//   catalog-cleanup.ts  limpeza de estrangeiro provado e rodeio manual
//   catalog-audit.ts    fila de auditoria de arquivos (áudio fraco)
//
// A superfície exportada aqui é a MESMA da era monoarquivo: `catalog-env.ts`
// e os testes continuam importando `* as catalog` sem mudança.
export { open, close, resetForTests } from './catalog-rows.js';
export type { Row, Engine, MarkInput } from './catalog-rows.js';
export { scan, report, row } from './catalog-scan.js';
export type { CatalogReport, ScanInput } from './catalog-scan.js';
export { planDedup, applyDeletions } from './catalog-dedup.js';
export type { DedupRow, DedupGroup, Deletion } from './catalog-dedup.js';
export { planForeignCleanup, listForReview, planManualDeletion } from './catalog-cleanup.js';
export type { CleanupTarget, ReviewRow } from './catalog-cleanup.js';
export { rowsNeedingAudit, requeueAudit, noteAudit, markAudited, markAuditedUnlessCondemned } from './catalog-audit.js';
export { operatorCtx } from './br-coverage.js';
