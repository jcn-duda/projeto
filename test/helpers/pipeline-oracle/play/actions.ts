import { opts } from '../../../../src/runtime.js';
import type { PlayHint } from '../../../../types/domain.js';
import * as log from '../../../../src/utils/logger.js';
import * as rdLedger from '../../../../src/debrid/rd-ledger.js';
import { current } from '../../../../src/debrid/registry.js';
import { bridgedResolveLink } from './bridge.js';
import { withBodies } from '../debrid-bodies/index.js';

/**
 * Resolve o link no adaptador CORRENTE, pela ponte de play do oráculo
 * (`bridge.ts`, o mesmo POST /debrid/link que o `wrap` fazia). O play de
 * PRODUÇÃO é nativo (gateway): isto é COLA DO ORÁCULO/testes. O Real-Debrid não
 * tem play TS (o /resolve dele é nativo), então devolve `null` em vez de
 * estourar num teste remoto.
 */
async function resolveLink(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter || adapter.id === 'realdebrid') return null;
  return bridgedResolveLink(adapter)(opts().debridApiKey, infoHash, episode);
}

/**
 * Manda o torrent baixar no serviço e volta na hora — NÃO espera ficar pronto.
 * Também é cola do oráculo/testes: o autofetch de produção é o worker nativo.
 * O guarda abaixo é o que mantém serviço sem `enqueue` (hoje, Real-Debrid)
 * como recusa silenciosa em vez de exceção.
 */
async function enqueue(infoHash: string, episode?: PlayHint) {
  const wrapped = current();
  const adapter = wrapped ? withBodies(wrapped) : null;
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
