import config from '../config.js';
import * as log from '../utils/logger.js';
import { BY_ID } from './registry.js';
import { inventoryFor } from './inventory.js';

/**
 * Aquece o inventário da conta configurada no operador antes da primeira busca.
 * Chaves seladas de instalações continuam no carregamento preguiçoso, pois só
 * existem durante a requisição.
 */
function warmupEnv() {
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (!adapter) return Promise.resolve(null);

  // Aquece também o inventário-como-fonte da conta do operador: a primeira
  // leitura custa ~700ms (medido numa conta com 1208 magnets) e não pode
  // cair dentro da primeira busca.
  if (
    config.debrid.inventorySource &&
    typeof adapter.inventory === 'function' &&
    config.debrid.apiKey && config.debrid.envOperatorAccount
  ) {
    inventoryFor(adapter, config.debrid.apiKey).catch((err: unknown) => {
      log.warn(`[${adapter.id}] não consegui aquecer o inventário como fonte:`, log.errorMessage(err));
    });
  }

  if (typeof adapter.warmInventory !== 'function') return Promise.resolve(null);
  // Mesmo OU da aquisição no checkCached (dropReady || dropUncached): o
  // guard do dropDownload precisa do snapshot quente no primeiro request,
  // senão ele roda suprimido até o TTL do warmup passar.
  if (!config.debrid.apiKey || !config.debrid.envOperatorAccount || !(config.debrid.dropReady || config.debrid.dropUncached)) {
    return Promise.resolve(null);
  }
  return adapter.warmInventory(config.debrid.apiKey).catch((err: unknown) => {
    log.warn(`[${adapter.id}] não consegui aquecer o inventário:`, log.errorMessage(err));
    return null;
  });
}

export { warmupEnv };
