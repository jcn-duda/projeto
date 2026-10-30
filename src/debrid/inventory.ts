import { opts } from '../runtime.js';
import type { DebridAdapter, InventoryItem } from '../../types/domain.js';
import config from '../config.js';
import * as inventoryMemo from './inventory-memo.js';
import * as cache from '../utils/cache.js';
import { BY_ID, current } from './registry.js';

// `inventoryFor` e `inventory` saíram: nenhum caminho de produção lê o
// inventário pelo Node (a busca e a checagem são nativas no gateway). O memo
// `dinv` só é lido aqui (peek) e invalidado pelo painel (refresh).

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

export { inventoryPeek, refreshInventory };
