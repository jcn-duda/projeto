const config = require('../config');
const cache = require('./cache');
const metrics = require('./metrics');
const log = require('./logger');

const API = 'https://api.themoviedb.org/3';

// Requisições concorrentes para o mesmo id compartilham a mesma promise —
// episódios da mesma série disparam várias buscas em paralelo e cada uma
// pagava a chamada ao TMDB.
const inFlight = new Map();

function setMiss(key) {
  // 0 desliga o cache negativo (operador pode querer sempre perguntar de novo).
  if (config.tmdb.missTtl > 0) cache.set(key, { miss: true }, config.tmdb.missTtl);
}

/**
 * Título pt-BR a partir do IMDb id. É o que destrava os sites BR: eles indexam
 * por "Coringa", não "Joker" — sem isso a busca volta vazia.
 * Retorna { pt, original } — o original serve de fallback quando os dois
 * idiomas coincidem ou quando o site usa o nome de release em inglês.
 *
 * Id sem resultado entra em cache NEGATIVO: sem isso, título que o TMDB não
 * conhece pagava os 5s de timeout em toda busca. Miss expira sozinho, então
 * falha transitória não condena o id para sempre.
 */
async function getTitles(imdbId) {
  if (!config.tmdb.apiKey || !imdbId) return null;

  const key = `tmdb:${imdbId}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit.miss) {
      metrics.count('meta.tmdb.miss.served');
      return null;
    }
    return hit;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const url = new URL(`${API}/find/${imdbId}`);
    url.searchParams.set('api_key', config.tmdb.apiKey);
    url.searchParams.set('external_source', 'imdb_id');
    url.searchParams.set('language', 'pt-BR');

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(config.tmdb.timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const item = (data.movie_results || [])[0] || (data.tv_results || [])[0];
      if (!item) {
        setMiss(key);
        return null;
      }

      const titles = {
        pt: item.title || item.name || null,
        original: item.original_title || item.original_name || null,
        year: (item.release_date || item.first_air_date || '').slice(0, 4) || null,
      };
      // Título não muda; vale cachear bem mais que uma busca.
      cache.set(key, titles, config.tmdb.cacheTtl);
      return titles;
    } catch (err) {
      log.warn('[tmdb]', err.message);
      setMiss(key);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

module.exports = { getTitles };
