import { opts } from '../runtime.js';
import type { PlayHint } from '../../types/domain.js';
import * as log from '../utils/logger.js';
import * as rdLedger from './rd-ledger.js';
import { current } from './registry.js';

/**
 * Resolve o link no adaptador CORRENTE. O play/enqueue de PRODUÇÃO é nativo
 * (gateway): estes wrappers existem como COLA DO ORÁCULO/testes, que ainda
 * exercitam os adaptadores não-RD pelo mesmo ponto de entrada. Por isso o
 * guarda: adaptador sem `resolveLink` (o Real-Debrid hoje) devolve `null` em
 * vez de estourar `TypeError` num teste remoto.
 */
async function resolveLink(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter || typeof adapter.resolveLink !== 'function') return null;
  return adapter.resolveLink(opts().debridApiKey, infoHash, episode);
}

/**
 * Manda o torrent baixar no serviço e volta na hora — NÃO espera ficar pronto.
 * Também é cola do oráculo/testes: o autofetch de produção é o worker nativo.
 * O guarda abaixo é o que mantém serviço sem `enqueue` (hoje, Real-Debrid)
 * como recusa silenciosa em vez de exceção.
 */
async function enqueue(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter || typeof adapter.enqueue !== 'function') return false;
  try {
    return await adapter.enqueue(opts().debridApiKey, infoHash, episode || {});
  } catch (err) {
    // O adaptador RD não tem mais `enqueue` (o autofetch é nativo), então este
    // ramo só atende os serviços que o oráculo ainda exercita.
    log.warn(`[${adapter.id}] falha ao enfileirar ${infoHash}:`, err.message);
    return false;
  }
}

/**
 * Consulta se o hash é um play instantâneo já comprovado para o adaptador
 * corrente (hoje, Real-Debrid via ledger quando ledger e oráculo estão ativos).
 * Outros adaptadores devolvem false.
 */
function knownInstant(hash: string): boolean {
  const adapter = current();
  if (!adapter || adapter.id !== 'realdebrid') return false;
  // O clone do current() já embute a credencial da requisição no cacheCheck
  // (rdLedger.enabled && rdOracle.available(debridApiKey)); reaproveitá-lo aqui
  // evita re-resolver a chave fora do ALS.
  if (!adapter.cacheCheck) return false;
  return rdLedger.isHit(hash);
}

export { resolveLink, enqueue, knownInstant };
