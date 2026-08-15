const config = require('../config');
const cache = require('./cache');
const log = require('./logger');

const API = 'https://api.themoviedb.org/3';

/**
 * Título pt-BR a partir do IMDb id. É o que destrava os sites BR: eles indexam
 * por "Coringa", não "Joker" — sem isso a busca volta vazia.
 * Retorna { pt, original } — o original serve de fallback quando os dois
 * idiomas coincidem ou quando o site usa o nome de release em inglês.
 */
async function getTitles(imdbId) {
  if (!config.tmdb.apiKey || !imdbId) return null;

  const key = `tmdb:${imdbId}`;
  const hit = cache.get(key);
  if (hit) return hit;

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
    if (!item) return null;

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
    return null;
  }
}

module.exports = { getTitles };
