import { opts } from '../runtime.js';
import type { PlayHint } from '../../types/domain.js';
import * as log from '../utils/logger.js';
import { isRateLimitError } from './common.js';
import * as rdLedger from './rd-ledger.js';
import { current } from './registry.js';

async function resolveLink(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter) return null;
  return adapter.resolveLink(opts().debridApiKey, infoHash, episode);
}

/**
 * Manda o torrent baixar no serviço e volta na hora — NÃO espera ficar pronto.
 * É o que sustenta o download automático da fonte BR dublada: o play só
 * funciona depois, quando o serviço terminar.
 */
async function enqueue(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter || typeof adapter.enqueue !== 'function') return false;
  try {
    return await adapter.enqueue(opts().debridApiKey, infoHash, episode || {});
  } catch (err) {
    // O runner precisa distinguir cooldown RD de recusa do torrent para repor
    // a cabeça da fila. Os demais adapters preservam o fail-soft histórico.
    if (adapter.id === 'realdebrid' && isRateLimitError(err)) throw err;
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
