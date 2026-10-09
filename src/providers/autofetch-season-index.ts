import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';

// Índice em memória de temporadas cujo pack pronto já invalida buscas antigas
// (Season Pack Fill). Extraído do recheck para a catraca de linhas: o mapa e o
// LRU não mudam de comportamento, só de arquivo. Continua sendo índice de
// PROCESSO (rebuild no boot), sem persistência própria.
export const seasonSearchKeys = new Map<string, Set<string>>();

export function seasonIndexKey(adapterId: string, account: string, imdbId: string, season: number) {
  return `${adapterId}:${account}:${imdbId}:${season}`;
}

export function registerSeasonSearchKey(
  adapterId: string,
  account: string,
  imdbId: string,
  season: number,
  cacheKey: string,
) {
  const live = autofetchLive.effective();
  const maxSeasons = config.debrid.autoFetchSeasonIndexMax;
  if (!live.autoFetchSeasonFill || maxSeasons <= 0) return;
  const maxKeys = config.debrid.autoFetchSeasonIndexKeys;
  const key = seasonIndexKey(adapterId, account, imdbId, season);
  let keys = seasonSearchKeys.get(key);
  if (!keys) {
    keys = new Set();
    seasonSearchKeys.set(key, keys);
  }
  if (!keys.has(cacheKey) && keys.size >= maxKeys) {
    const oldest = keys.values().next().value;
    if (oldest) keys.delete(oldest);
  }
  keys.add(cacheKey);
  // Map preserva inserção; mover para o fim implementa LRU por temporada.
  seasonSearchKeys.delete(key);
  seasonSearchKeys.set(key, keys);
  while (seasonSearchKeys.size > maxSeasons) {
    const oldest = seasonSearchKeys.keys().next().value;
    if (oldest == null) break;
    seasonSearchKeys.delete(oldest);
  }
}
