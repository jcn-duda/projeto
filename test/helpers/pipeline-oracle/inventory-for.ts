// Cópia de oráculo do inventário da conta como fonte (`inventoryFor` e
// `inventory`). Saíram de `src/debrid/inventory.ts`: a produção não lê o
// inventário pelo Node desde que a busca e a checagem são nativas (gateway
// Rust), e o warmup de boot foi removido. O oráculo congelado mantém o
// comportamento do memo `dinv` (leitura única por serviço+conta, em voo
// deduplicado, falha não cacheada, teto de itens) para os testes que o medem.
import { opts } from '../../../src/runtime.js';
import type { DebridAdapter, InventoryItem } from '../../../types/domain.js';
import config from '../../../src/config.js';
import * as inventoryMemo from '../../../src/debrid/inventory-memo.js';
import * as cache from '../../../src/utils/cache.js';
import * as log from '../../../src/utils/logger.js';
import { current } from '../../../src/debrid/registry.js';
import { assertSafeTestDb } from '../db-guard.js';
import { withBodies } from './debrid-bodies/index.js';

// Lê o memo `dinv` (cache/KV): sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/inventory-for');

// Inventário em voo por serviço+conta: buscas concorrentes não pagam a mesma
// leitura da conta.
const inventoryInFlight = new Map<string, Promise<InventoryItem[]>>();

export function inventoryFor(source: DebridAdapter, apiKey: string): Promise<InventoryItem[]> {
  const adapter = withBodies(source);
  if (typeof adapter.inventory !== 'function') return Promise.resolve([]);
  const loadInventory = adapter.inventory;
  const key = inventoryMemo.memoKey(adapter.id, apiKey);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit as InventoryItem[]);

  let task = inventoryInFlight.get(key);
  if (!task) {
    task = Promise.resolve()
      .then(() => loadInventory(apiKey))
      .then((items) => {
        // Teto defensivo: resposta degenerada não pode entrar inteira no cache.
        const list = (Array.isArray(items) ? items : []).slice(0, config.debrid.inventoryMax);
        inventoryMemo.store(adapter.id, apiKey, list);
        log.info(`[${adapter.id}] inventário da conta: ${list.length} item(ns) pronto(s)`);
        return list;
      });
    inventoryInFlight.set(key, task);
    // Falha NÃO fica cacheada: a próxima chamada tenta de novo.
    const cleanup = () => {
      if (inventoryInFlight.get(key) === task) inventoryInFlight.delete(key);
    };
    task.then(cleanup, cleanup);
  }
  return task;
}

/** Itens prontos na conta do serviço corrente (mesma régua do antigo `debrid.inventory()`). */
export async function inventory(): Promise<InventoryItem[]> {
  const adapter = current();
  if (!adapter) return [];
  return inventoryFor(adapter, opts().debridApiKey);
}
