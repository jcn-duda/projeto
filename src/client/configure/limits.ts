/* Adom Power-Movie - /configure: normalização e serialização dos limites
 * individuais por indexador (chave `jl`). Aceita tanto o CSV curto da URL
 * quanto formas de estado usadas por versões intermediárias do front-end; o
 * filtro por catálogo impede que um link carregue IDs ou limites inexistentes. */

import { state } from './state.js';

export function knownJackettIndexer(id: string): boolean {
  for (let i = 0; i < state.jackettIndexers.length; i++) {
    if (state.jackettIndexers[i].id === id) return true;
  }
  return false;
}

export function parseIndexerLimit(value: any): number | null {
  let number: number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    number = Number(value.trim());
  } else {
    return null;
  }
  if (!isFinite(number) || Math.floor(number) !== number) return null;
  return Math.min(20, Math.max(0, number));
}

function addIndexerLimit(result: Record<string, number>, id: any, value: any): void {
  const normalizedId = id == null ? '' : String(id).trim().toLowerCase();
  const limit = parseIndexerLimit(value);
  if (!normalizedId || !knownJackettIndexer(normalizedId) || limit === null) return;
  result[normalizedId] = limit;
}

function addIndexerLimitPair(result: Record<string, number>, pair: any): void {
  if (typeof pair !== 'string') return;
  const separator = pair.indexOf(':');
  if (separator < 1) return;
  addIndexerLimit(result, pair.slice(0, separator), pair.slice(separator + 1));
}

export function normalizeIndexerLimits(value: any): Record<string, number> {
  const result: Record<string, number> = {};
  if (typeof value === 'string') {
    value.split(',').forEach((pair: string) => { addIndexerLimitPair(result, pair); });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item: any) => {
      if (typeof item === 'string') addIndexerLimitPair(result, item);
      else if (Array.isArray(item) && item.length >= 2) addIndexerLimit(result, item[0], item[1]);
      else if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'id')) {
        addIndexerLimit(result, item.id, item.limit != null ? item.limit : item.value);
      }
    });
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (Object.prototype.hasOwnProperty.call(value, 'id')) {
    addIndexerLimit(result, value.id, value.limit != null ? value.limit : value.value);
    return result;
  }
  for (const i in value) {
    if (Object.prototype.hasOwnProperty.call(value, i)) addIndexerLimit(result, i, value[i]);
  }
  return result;
}

/** Uma linha por select preenchido; opção vazia (padrão geral) fica fora. */
export function collectIndexerLimits(): string {
  const result: string[] = [];
  Array.prototype.forEach.call(state.el.jackettIndexers.querySelectorAll('.indexer-limit'), (select: any) => {
    const value = select.value;
    if (value === '') return;
    const limit = parseIndexerLimit(value);
    const id = select.getAttribute('data-indexer-id');
    if (limit !== null && knownJackettIndexer(id)) result.push(id + ':' + limit);
  });
  return result.join(',');
}
