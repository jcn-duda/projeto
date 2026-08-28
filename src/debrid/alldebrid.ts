/**
 * Fachada do adaptador AllDebrid.
 *
 * Dividida por fronteiras reais do arquivo original (PLANO_MELHORIAS §5.8,
 * item 7 do backlog da Fase 2 — teto de 400 linhas por arquivo), preservando
 * a superfície pública EXATA: o registry (`src/debrid/registry.ts`) continua
 * fazendo `{ ...alldebrid }` e nenhuma rota/teste muda.
 *
 *   - `alldebrid-api.ts`        base HTTP (`call`), tipos, visões de conta;
 *   - `alldebrid-inventory.ts`  DONO do estado `knownBefore`/`submitted`;
 *   - `alldebrid-cleanup.ts`    limpeza: skipCleanup, deleteMagnets, varreduras;
 *   - `alldebrid-check.ts`      checagem de cache (upload) + dropReady/dropUncached;
 *   - `alldebrid-play.ts`       resolveLink, enqueue, torrentStatus, removeTorrent.
 *
 * O grafo é sem ciclo: todos os irmãos importam só da base e do inventário;
 * a identidade (`id`) mora na base porque a limpeza fala com `protected.ts`.
 */
export {
  id,
  magnetList,
  magnetFiles,
  accountStatus,
  inventory,
} from './alldebrid-api.js';
export type { AllDebridMagnetRow } from './alldebrid-api.js';
export { warmInventory, preexistingHashes } from './alldebrid-inventory.js';
export { deleteMagnets, sweepDead, sweepUndubbed } from './alldebrid-cleanup.js';
export { checkCached } from './alldebrid-check.js';
export { resolveLink, enqueue, torrentStatus, removeTorrent } from './alldebrid-play.js';

export const label = 'AllDebrid';
export const short = 'AD';
// Não pelo /magnet/instant (removido), e sim pelo `ready` do /magnet/upload.
export const cacheCheck = true;
// A consulta cria transferência; ela disputa o prazo sem ser abortada e segue
// em background para ler os ids e remover os magnets que não estavam prontos.
export const abortSafeCacheCheck = false;
export const keyUrl = 'https://alldebrid.com/apikeys';
