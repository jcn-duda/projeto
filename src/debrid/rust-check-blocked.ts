/**
 * Escape do `adrm` no caminho NATIVO da checagem AllDebrid.
 *
 * O Rust tira do `/magnet/upload` todo hash com marca `adrm` viva e o devolve
 * no campo `blocked` do outcome (sempre presente, vazio inclusive). O ⚡ real
 * só pode voltar com PROVA de que o magnet está PRONTO na conta: o memo `dinv`
 * (só itens prontos) é a única fonte aceita — sem memo quente, memo frio ou
 * hash ausente, nada muda (falha ao provar NUNCA destrava).
 *
 * Paridade com o corpo TS da checagem, que só existe no oráculo
 * (`test/helpers/pipeline-oracle/debrid-bodies/alldebrid.ts`: destrava antes do
 * upload e injeta no `cached`). A adoção vive aqui (e não no `rust-remote.ts`) para
 * manter o adaptador como transporte e respeitar o teto de linhas por arquivo.
 */
import * as metrics from '../utils/metrics.js';
import { accountScope } from '../utils/request-key.js';
import { unblockIfInventoryReady } from './alldebrid-reupload.js';
import { id as alldebridId } from './alldebrid-api.js';

/**
 * Hashes que o Rust tirou do upload (`blocked` do outcome nativo), lower-case e
 * sem repetição. Corpo antigo sem o campo e serviço não-AllDebrid: lista vazia.
 */
function blockedHashes(json: unknown): string[] {
  const body = json && typeof json === 'object' ? json as { blocked?: unknown } : {};
  if (!Array.isArray(body.blocked)) return [];
  const out: string[] = [];
  for (const item of body.blocked) {
    const hash = String(item || '').toLowerCase();
    if (hash && !out.includes(hash)) out.push(hash);
  }
  return out;
}

/**
 * Adota no `cached` o hash bloqueado que o inventário da conta prova PRONTO e
 * expurga a marca (`unblockIfInventoryReady`). Devolve quantos foram adotados.
 * Adaptador não-AllDebrid não tem marcador nem memo: custo zero.
 */
function adoptBlockedReady(
  adapterId: string,
  apiKey: string,
  json: unknown,
  cached: Set<string>,
): number {
  if (adapterId !== alldebridId) return 0;
  const blocked = blockedHashes(json);
  if (blocked.length === 0) return 0;
  const account = accountScope(apiKey);
  let unblocked = 0;
  for (const hash of blocked) {
    // O expurgo do `adrm` e o log são do módulo; aqui só entra o ⚡ provado.
    if (!unblockIfInventoryReady(apiKey, account, hash)) continue;
    cached.add(hash);
    unblocked += 1;
  }
  if (unblocked > 0) metrics.count('rust.debrid.check.unblockedByInventory', unblocked);
  return unblocked;
}

export { adoptBlockedReady };
