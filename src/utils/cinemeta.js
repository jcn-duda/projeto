const config = require('../config');
const cache = require('./cache');
const log = require('./logger');

/**
 * Resolve título/ano a partir do IMDb id via Cinemeta (API pública do ecossistema Stremio).
 */
async function getMeta(type, imdbId) {
  const key = `meta:${type}:${imdbId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const kind = type === 'series' ? 'series' : 'movie';
  const url = `https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'stremio-adom/1.0' },
      signal: AbortSignal.timeout(config.cinemeta.timeout),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.meta
      ? {
          name: data.meta.name || data.meta.title,
          year: data.meta.year || (data.meta.releaseInfo || '').slice(0, 4),
          type: data.meta.type || kind,
        }
      : null;
    if (meta) cache.set(key, meta, 86400);
    return meta;
  } catch (err) {
    log.warn('[cinemeta]', err.message);
    return null;
  }
}

module.exports = { getMeta };
