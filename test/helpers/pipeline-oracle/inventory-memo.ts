// Cópia de oráculo do memo do inventário PRONTO da conta (`dinv:`). Saiu de
// `src/debrid/inventory-memo.ts`: nenhum caminho de produção escreve ou lê o
// memo (a busca e a checagem são nativas no gateway e a contagem do painel vem
// da rota `GET /debrid/inventory` da admin 8711) — os únicos consumidores
// vivos eram testes e o oráculo. A cópia congelada mantém o comportamento do
// memo (leitura síncrona sem rede, mutação só com memo QUENTE, renovação de
// TTL na mutação) para os testes que o medem.
//
// O `peekQuiet` (leitura de diagnóstico via `cache.peek`) não veio: o funil do
// `/stream-trace.json` que o consumia não existe mais e nenhum teste o mede.
import config from '../../../src/config.js';
import { accountScope } from '../../../src/utils/request-key.js';
import { prefix } from '../../../src/utils/cache-keys.js';
import * as cache from '../../../src/utils/cache.js';
import type { InventoryItem } from '../../../types/domain.js';
import { assertSafeTestDb } from '../db-guard.js';

// Escreve no L1 (`cache.set`): sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/inventory-memo');

/**
 * Memo do inventário PRONTO da conta (namespace `dinv:`), compartilhado pelo
 * oráculo (`inventory-for.ts`) e pelos módulos irmãos que leem ou atualizam o
 * retrato da conta sem rede.
 *
 * As mutações (`note`/`forget`) só valem com o memo QUENTE: memo frio continua
 * lazy (a primeira leitura é o carregamento completo), e um play não pode
 * criar um "inventário" de um item só que depois autorizaria o corte do
 * cachedOnly. Reescrever o memo renova o TTL — mutação é evento raro (play,
 * autofetch, delete), então renovar ali mantém o retrato vivo enquanto a
 * conta está em uso.
 */

export function memoKey(adapterId: string, apiKey: string) {
  return `${prefix('dinv')}${adapterId}:${accountScope(apiKey)}`;
}

/** Leitura síncrona do memo: sem rede, sem in-flight. null = memo frio. */
export function peek(adapterId: string, apiKey: string): InventoryItem[] | null {
  const hit = cache.get(memoKey(adapterId, apiKey));
  return Array.isArray(hit) ? hit : null;
}

/** Grava o carregamento completo (o oráculo chama após ler a conta). */
export function store(adapterId: string, apiKey: string, items: InventoryItem[]) {
  cache.set(memoKey(adapterId, apiKey), items, config.debrid.inventoryTtl);
}

/** Upsert local no memo quente; memo frio ou sem prova (hash/título) é no-op. */
export function note(adapterId: string, apiKey: string, item: InventoryItem): boolean {
  const key = memoKey(adapterId, apiKey);
  const hit = cache.get(key);
  if (!Array.isArray(hit)) return false;
  const hash = String(item.infoHash || '').toLowerCase();
  const title = String(item.title || '').trim();
  if (!hash || !title) return false;
  const next = (hit as InventoryItem[]).filter((i) => String(i.infoHash || '').toLowerCase() !== hash);
  next.push({
    title,
    infoHash: hash,
    size: Number(item.size) || 0,
    ...(item.id != null ? { id: String(item.id) } : {}),
  });
  cache.set(key, next, config.debrid.inventoryTtl);
  return true;
}

/** Remove do memo quente (torrent apagado da conta); memo frio é no-op. */
export function forget(adapterId: string, apiKey: string, infoHash: string): boolean {
  const key = memoKey(adapterId, apiKey);
  const hit = cache.get(key);
  if (!Array.isArray(hit)) return false;
  const hash = String(infoHash || '').toLowerCase();
  const next = (hit as InventoryItem[]).filter((i) => String(i.infoHash || '').toLowerCase() !== hash);
  if (next.length === hit.length) return false;
  cache.set(key, next, config.debrid.inventoryTtl);
  return true;
}
