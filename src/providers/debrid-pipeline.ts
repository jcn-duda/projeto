/**
 * Pipeline de debrid — ponto de entrada único com a MESMA superfície pública
 * do monolito pré-split (PLANO_MELHORIAS 5.8). Nenhum consumidor precisa
 * conhecer os irmãos: o núcleo `applyDebrid` (com o filtro pré-checagem) mora
 * em `debrid-pipeline-core.js` e a auditoria de áudio (Fase D do tail) em
 * `dub-audit.js`; as etapas internas compartilhadas ficam em
 * `debrid-pipeline-steps.js`.
 */
export { applyDebrid } from './debrid-pipeline-core.js';
export { collectAuditCandidates, queueDubAudit, runDubAudit, nomeiaEpisodio } from './dub-audit.js';
