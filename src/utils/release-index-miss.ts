// Prova de episódio errado (`idx` miss): "este hash NÃO serve ESTE episódio".
// Irmão do release-index extraído pela catraca de linhas (teto de 400) — a
// prova é fina (marca SÓ a chave do episódio, nunca a da temporada nem a da
// obra: o mesmo pack pode servir todos os outros episódios que promete) e não
// compartilha estado com o resto do índice, só o gate `enabled`.
import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import { prefix } from './cache-keys.js';

type ObraLocation = { season?: number | null; episode?: number | null };

/** Mesmo gate do módulo pai; duplicado aqui para o irmão não criar ciclo. */
function enabled() {
  return config.releaseIndex.enabled && config.releaseIndex.ttl > 0;
}

function missKey(imdbId: string, { season, episode }: ObraLocation, hash: string) {
  return `${prefix('idx')}miss:${imdbId}:S${season}E${episode}:${hash.toLowerCase()}`;
}

function markMissing(imdbId: string, location: ObraLocation, hash: string) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !hash) return 0;
  // Sem temporada E episódio não há o que marcar: a prova é por episódio.
  if (location.season == null || location.episode == null) return 0;
  const key = missKey(imdbId, location, hash);
  // Conta só a escrita NOVA, espelhando o markLied: re-marcar o que já está
  // provado renova o TTL mas não é evidência nova.
  const isNew = cache.get(key) == null;
  cache.set(key, { at: Date.now() }, config.releaseIndex.ttl);
  if (isNew) metrics.count('search.idx.miss');
  return isNew ? 1 : 0;
}

function isMissing(imdbId: string, location: ObraLocation, hash: string) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !hash) return false;
  if (location.season == null || location.episode == null) return false;
  return cache.get(missKey(imdbId, location, hash)) != null;
}

/** Leitura de diagnóstico (P5): mesma prova de falta por episódio, com
 * `cache.peek` — sem promover LRU nem contar hit/miss. */
function isMissingQuiet(imdbId: string, location: ObraLocation, hash: string) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !hash) return false;
  if (location.season == null || location.episode == null) return false;
  return cache.peek(missKey(imdbId, location, hash)) != null;
}

export { markMissing, isMissing, isMissingQuiet };