import { opts } from '../runtime.js';
import config from '../config.js';
import * as log from '../utils/logger.js';
import { BY_ID, current } from './registry.js';
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
    config.debrid.apiKey && config.debrid.allowEnvKey
  ) {
    inventoryFor(adapter, config.debrid.apiKey).catch((err: unknown) => {
      log.warn(`[${adapter.id}] não consegui aquecer o inventário como fonte:`, log.errorMessage(err));
    });
  }

  if (typeof adapter.warmInventory !== 'function') return Promise.resolve(null);
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.dropReady) return Promise.resolve(null);
  return adapter.warmInventory(config.debrid.apiKey).catch((err: unknown) => {
    log.warn(`[${adapter.id}] não consegui aquecer o inventário:`, log.errorMessage(err));
    return null;
  });
}

/**
 * Varredura dos magnets mortos da conta do operador. Roda no boot e em
 * intervalo: o lixo que a limpeza por busca não alcança é justamente o que
 * nunca mais aparece numa consulta.
 */
async function sweepDeadEnv() {
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.sweepDead !== 'function') return null;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.sweepDead) return null;
  try {
    return await adapter.sweepDead(config.debrid.apiKey);
  } catch (err) {
    log.warn(`[${adapter.id}] varredura de mortos falhou:`, err.message);
    return null;
  }
}

/**
 * Varredura dos magnets antigos sem áudio PT da conta do operador. Mesma
 * guarda do `sweepDeadEnv`: só a chave do `.env`, com `allowEnvKey` e o
 * toggle ligado — é varredura do operador, não de uma instalação.
 */
async function sweepUndubbedEnv() {
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.sweepUndubbed !== 'function') return null;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.sweepUndubbed) return null;
  try {
    return await adapter.sweepUndubbed(config.debrid.apiKey);
  } catch (err) {
    log.warn(`[${adapter.id}] varredura de não-dublados falhou:`, err.message);
    return null;
  }
}

/**
 * Varredura da conta da INSTALAÇÃO corrente (a chave que veio no segmento de
 * config), e não a do `.env`.
 *
 * `sweepDeadEnv` é do operador: exige `allowEnvKey` e usa `config.debrid.apiKey`.
 * Quem abre o painel com uma install URL de outro serviço não é atendido por
 * ele — o botão respondia "varredura indisponível" mesmo com o adaptador certo
 * do outro lado, porque estava olhando para a conta errada.
 */
async function sweepDeadCurrent() {
  const adapter = current();
  if (!adapter || typeof adapter.sweepDead !== 'function') return null;
  const { debridApiKey } = opts();
  if (!debridApiKey || !config.debrid.sweepDead) return null;
  try {
    return await adapter.sweepDead(debridApiKey);
  } catch (err: unknown) {
    log.warn(`[${adapter.id}] varredura de mortos falhou:`, log.errorMessage(err));
    return null;
  }
}

export { warmupEnv, sweepDeadEnv, sweepUndubbedEnv, sweepDeadCurrent };
