import { opts } from '../runtime.js';
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import { accountScope } from '../utils/request-key.js';
import { BY_ID, current } from './registry.js';

// O inventário da conta saiu do Node: a busca e a checagem são nativas no
// gateway e a contagem do painel vem da rota `GET /debrid/inventory` da admin
// 8711 (`src/providers/debrid-inventory-native.ts`). `inventoryFor`,
// `inventory` e o `inventoryPeek` apagaram — o memo `dinv` não tem escritor
// nem leitor de produção (a cópia viva dele é o oráculo
// `test/helpers/pipeline-oracle/inventory-memo.ts`). Sobrou aqui só o
// `refreshInventory`, backend do botão "invalidar inventário" do painel —
// cadeia que só morre junto do botão (fora do escopo desta fatia).

/** Chave do memo dinv (mesmo formato do oráculo): serviço + escopo da conta. */
function memoKey(adapterId: string, apiKey: string): string {
  return `${prefix('dinv')}${adapterId}:${accountScope(apiKey)}`;
}

/** Invalida só memos de inventários que esta requisição pode alcançar. */
function refreshInventory() {
  const keys = new Set<string>();
  const active = current();
  const activeKey = opts().debridApiKey;
  if (active && activeKey) keys.add(memoKey(active.id, activeKey));

  const operator = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (operator && config.debrid.apiKey && config.debrid.envOperatorAccount) {
    keys.add(memoKey(operator.id, config.debrid.apiKey));
  }
  cache.forgetMany([...keys]);
  return { refreshed: keys.size };
}

export { refreshInventory };
