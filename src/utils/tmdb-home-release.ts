// Data do primeiro lançamento DOMÉSTICO (digital, físico ou TV) do filme no
// TMDB. Antes dela, release de fonte doméstica (WEB-DL, WEBRip, BluRay, HDTV,
// DVD) não pode ser o filme: é outra obra com o mesmo nome ou gravação de
// cinema rotulada errado. Medido em The Odyssey (Nolan, tt33764258,
// 2026-10-05): em cartaz desde 15/07, digital só em 15/11; todas as WEB-DL da
// lista eram o OUTRO "The Odyssey (2026)" (tt41605854, Tubi, 86 min), e o
// TheRARBG até marcava a release com esse IMDb.
//
// Fail-open: sem chave, sem filme no TMDB, sem data doméstica ou rede falha,
// devolve null e nada é cortado. Só filme e só obra recente (quem chama
// decide): para filme antigo a data doméstica não muda nada e a chamada seria
// custo à toa.
import config from '../config.js';
import * as cache from './cache.js';
import * as log from './logger.js';
import { fetchJsonWithin } from './deadline.js';

const API = 'https://api.themoviedb.org/3';
const CACHE_PREFIX = 'tmdbh:';
// Tipos de lançamento do TMDB: 4 digital, 5 físico, 6 TV.
const HOME_TYPES = new Set([4, 5, 6]);

async function readJson(url: URL, deadlineAt: number): Promise<any | null> {
  const remaining = deadlineAt - Date.now();
  if (!(remaining > 0)) return null;
  try {
    const { res, data } = await fetchJsonWithin(url, { headers: { Accept: 'application/json' } }, remaining);
    return res.ok ? data : null;
  } catch (err) {
    log.warn('[tmdb] data doméstica:', (err as Error)?.message || err);
    return null;
  }
}

/** Menor data doméstica (ms) entre todos os países, ou null se não houver. */
function earliestHomeRelease(data: any): number | null {
  let min = Infinity;
  for (const country of data?.results || []) {
    for (const entry of country?.release_dates || []) {
      if (!HOME_TYPES.has(Number(entry?.type))) continue;
      const at = Date.parse(String(entry?.release_date || ''));
      if (Number.isFinite(at) && at < min) min = at;
    }
  }
  return Number.isFinite(min) ? min : null;
}

const inFlight = new Map<string, Promise<number | null>>();

async function getHomeReleaseAt(imdbId: string, deadlineAt: number): Promise<number | null> {
  if (!config.tmdb.apiKey || !imdbId || !config.search.preHomeReleaseCut) return null;
  const key = `${CACHE_PREFIX}${imdbId}`;
  const hit = cache.get(key);
  if (hit) return hit.at ?? null;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    const findUrl = new URL(`${API}/find/${imdbId}`);
    findUrl.searchParams.set('api_key', config.tmdb.apiKey);
    findUrl.searchParams.set('external_source', 'imdb_id');
    const found = await readJson(findUrl, deadlineAt);
    const movieId = found?.movie_results?.[0]?.id;
    if (!found) { cache.set(key, { at: null }, config.tmdb.transientMissTtl); return null; }
    if (!movieId) { cache.set(key, { at: null }, config.tmdb.cacheTtl); return null; }
    const datesUrl = new URL(`${API}/movie/${movieId}/release_dates`);
    datesUrl.searchParams.set('api_key', config.tmdb.apiKey);
    const dates = await readJson(datesUrl, deadlineAt);
    if (!dates) { cache.set(key, { at: null }, config.tmdb.transientMissTtl); return null; }
    const at = earliestHomeRelease(dates);
    cache.set(key, { at }, config.search.preHomeReleaseTtl);
    return at;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Leitura SÍNCRONA do que a busca já consultou (o build não espera rede). */
function peekHomeReleaseAt(imdbId: string | null | undefined): number | null {
  if (!imdbId || !config.search.preHomeReleaseCut) return null;
  return cache.get(`${CACHE_PREFIX}${imdbId}`)?.at ?? null;
}

export { getHomeReleaseAt, peekHomeReleaseAt, earliestHomeRelease };
