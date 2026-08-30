// Registry de debrid — ponto de entrada da fronteira que o resto do código
// consome (nada fora daqui conhece um serviço específico). A implementação
// vive nos módulos irmãos, em camadas sem ciclo (padrão dos splits §5.1/§5.3):
//
//   registry.ts        ADAPTERS/BY_ID/SERVICES + current()
//   cache-check.ts     checagem de cache (davail, nonAbortable, unusable)
//   account-status.ts  saúde da conta para o verificador/painel
//   inventory.ts       inventário da conta como fonte (memo dinv)
//   env-ops.ts         warmup/varreduras da conta do OPERADOR (.env)
//   actions.ts         resolveLink/enqueue/knownInstant (play e autofetch)
//   catalog-env.ts     catálogo durável + limpador BR da conta do operador
//
// O objeto default preserva MESMA chave, MESMA ordem e MESMO objeto mutável
// (BY_ID é o Map vivo do registry; nenhum estado é duplicado entre irmãos).
import * as registry from './registry.js';
import * as cacheCheck from './cache-check.js';
import * as accountStatus from './account-status.js';
import * as inventory from './inventory.js';
import * as envOps from './env-ops.js';
import * as actions from './actions.js';
import * as catalogEnv from './catalog-env.js';

export { knownInstant } from './actions.js';

export default {
  SERVICES: registry.SERVICES,
  BY_ID: registry.BY_ID,
  current: registry.current,
  checkCached: cacheCheck.checkCached,
  noteAvailable: cacheCheck.noteAvailable,
  peekDavail: cacheCheck.peekDavail,
  noteUnavailable: cacheCheck.noteUnavailable,
  accountStatus: accountStatus.accountStatus,
  dashboardAccounts: accountStatus.dashboardAccounts,
  resolveLink: actions.resolveLink,
  enqueue: actions.enqueue,
  inventory: inventory.inventory,
  inventoryPeek: inventory.inventoryPeek,
  refreshInventory: inventory.refreshInventory,
  warmupEnv: envOps.warmupEnv,
  sweepDeadEnv: envOps.sweepDeadEnv,
  sweepUndubbedEnv: envOps.sweepUndubbedEnv,
  sweepDeadCurrent: envOps.sweepDeadCurrent,
  knownInstant: actions.knownInstant,
  catalogScanEnv: catalogEnv.catalogScanEnv,
  catalogListEnv: catalogEnv.catalogListEnv,
  manualDeleteEnv: catalogEnv.manualDeleteEnv,
  auditRequeueEnv: catalogEnv.auditRequeueEnv,
  catalogStatusEnv: catalogEnv.catalogStatusEnv,
  dedupPreviewEnv: catalogEnv.dedupPreviewEnv,
  dedupApplyEnv: catalogEnv.dedupApplyEnv,
  auditBackfillEnv: catalogEnv.auditBackfillEnv,
  cleanupPreviewEnv: catalogEnv.cleanupPreviewEnv,
  cleanupApplyEnv: catalogEnv.cleanupApplyEnv,
};
