import config from '../config.js';

/**
 * Debrid que diz o que está pronto + "só em cache": o piso de seeders sai antes
 * da checagem e o ⚡ decide (o que não está pronto some pelo cachedOnly). Boat
 * Trip (2026-10-05): "O Cruzeiro das Loucas" com 0 seeds nunca era perguntado à
 * Premiumize. Baixar (Chupim) segue com o próprio piso.
 */
export function seedFloorFor(minSeeders: number, { cacheCheck, apiKey, cachedOnly }: { cacheCheck?: boolean; apiKey?: string | null; cachedOnly?: boolean }) {
  return config.search.cachedOnlyIgnoresSeeds && cacheCheck && apiKey && cachedOnly ? 0 : minSeeders;
}
