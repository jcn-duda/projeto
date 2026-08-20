import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

// Requisições concorrentes para o mesmo id compartilham a mesma promise —
// o Stremio dispara buscas duplicadas (episódios da mesma série) e sem isso
// cada uma pagava a chamada ao Cinemeta.
const inFlight = new Map();

function setMiss(key) {
  // 0 desliga o cache negativo (operador pode querer sempre perguntar de novo).
  if (config.cinemeta.missTtl > 0) cache.set(key, { miss: true }, config.cinemeta.missTtl);
}

/**
 * Resolve título/ano a partir do IMDb id via Cinemeta (API pública do ecossistema Stremio).
 *
 * Id sem meta (404 ou corpo sem `meta`) entra em cache NEGATIVO: sem isso,
 * título desconhecido pagava os 2,5s de timeout em toda busca. Falha
 * transitória se resolve sozinha quando o miss expira.
 */
async function getMeta(type, imdbId) {
  const key = `meta:${type}:${imdbId}`;
  const cached = cache.get(key);
  if (cached) {
    if (cached.miss) {
      metrics.count('meta.cinemeta.miss.served');
      return null;
    }
    return cached;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const kind = type === 'series' ? 'series' : 'movie';
    const url = `https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'stremio-adom/1.0' },
        signal: AbortSignal.timeout(config.cinemeta.timeout),
      });
      if (!res.ok) {
        setMiss(key);
        return null;
      }
      const data = await res.json();
      const meta = data?.meta
        ? {
            name: data.meta.name || data.meta.title,
            year: data.meta.year || (data.meta.releaseInfo || '').slice(0, 4),
            type: data.meta.type || kind,
          }
        : null;
      if (meta) cache.set(key, meta, 86400);
      else setMiss(key);
      return meta;
    } catch (err) {
      log.warn('[cinemeta]', err.message);
      setMiss(key);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

export { getMeta };
