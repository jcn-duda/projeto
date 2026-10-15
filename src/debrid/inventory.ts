import { opts } from '../runtime.js';
import type { DebridAdapter, InventoryItem } from '../../types/domain.js';
import config from '../config.js';
import * as inventoryMemo from './inventory-memo.js';
import * as cache from '../utils/cache.js';
import * as log from '../utils/logger.js';
import { BY_ID, current } from './registry.js';

// Inventário em voo por serviço+conta: buscas concorrentes não pagam a mesma
// leitura da conta.
const inventoryInFlight = new Map();

function inventoryFor(adapter: DebridAdapter, apiKey: string) {
  if (typeof adapter.inventory !== 'function') return Promise.resolve([]);
  const loadInventory = adapter.inventory;
  const key = inventoryMemo.memoKey(adapter.id, apiKey);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  let task = inventoryInFlight.get(key);
  if (!task) {
    task = Promise.resolve()
      .then(() => loadInventory(apiKey))
      .then((items) => {
        // Teto defensivo: a conta real medida tem 1208 prontos; resposta
        // degenerada não pode entrar inteira no cache.
        const list = (Array.isArray(items) ? items : []).slice(0, config.debrid.inventoryMax);
        inventoryMemo.store(adapter.id, apiKey, list);
        log.info(`[${adapter.id}] inventário da conta: ${list.length} item(ns) pronto(s)`);
        return list;
      });
    inventoryInFlight.set(key, task);
    // A corrida da resposta pode ter desistido desta promise: sem isto, a
    // rejeição tardia virava unhandled. Falha NÃO fica cacheada — a próxima
    // busca tenta de novo (mesmo contrato do knownBefore e do nonAbortable).
    const cleanup = () => {
      if (inventoryInFlight.get(key) === task) inventoryInFlight.delete(key);
    };
    task.then(cleanup, cleanup);
  }
  return task;
}

/**
 * Leitura síncrona do memo dinv da conta: cache.get, sem rede, sem in-flight.
 * null = memo frio.
 */
function inventoryPeek(adapter?: DebridAdapter | null, apiKey?: string): InventoryItem[] | null {
  const ad = adapter || current();
  const key = apiKey || opts().debridApiKey;
  if (!ad || !key) return null;
  return inventoryMemo.peek(ad.id, key);
}

/**
 * Itens prontos na conta do serviço corrente (`{ title, infoHash, size }`).
 * É o que sustenta a conta-como-fonte: o que o usuário já baixou entra na
 * busca com ⚡ sem depender de indexer. Memoizado por serviço+conta —
 * inventário é privado — com TTL próprio. Adaptador sem `inventory` devolve
 * [] (a feature vira no-op para ele).
 */
async function inventory() {
  const adapter = current();
  if (!adapter || typeof adapter.inventory !== 'function') return [];
  return inventoryFor(adapter, opts().debridApiKey);
}

/** Invalida só memos de inventários que esta requisição pode alcançar. */
function refreshInventory() {
  const keys = new Set<string>();
  const active = current();
  const activeKey = opts().debridApiKey;
  if (active && activeKey) keys.add(inventoryMemo.memoKey(active.id, activeKey));

  const operator = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (operator && config.debrid.apiKey && config.debrid.envOperatorAccount) {
    keys.add(inventoryMemo.memoKey(operator.id, config.debrid.apiKey));
  }
  cache.forgetMany([...keys]);
  return { refreshed: keys.size };
}

export { inventoryFor, inventoryPeek, inventory, refreshInventory };
