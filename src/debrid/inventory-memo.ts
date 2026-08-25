import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';
import type { InventoryItem } from '../../types/domain.js';

/**
 * Memo do inventário PRONTO da conta (namespace `dinv:`), compartilhado entre
 * o registry (`index.ts`) e os adaptadores que precisam ler ou atualizar o
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

/** Grava o carregamento completo (o registry chama após ler a conta). */
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
