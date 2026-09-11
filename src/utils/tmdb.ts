import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

const API = 'https://api.themoviedb.org/3';

// Requisições concorrentes para o mesmo id compartilham a mesma promise —
// episódios da mesma série disparam várias buscas em paralelo e cada uma
// pagava a chamada ao TMDB.
const inFlight = new Map();

function setMiss(key: string, ttlSeconds?: number) {
  // 0 desliga o cache negativo (operador pode querer sempre perguntar de novo);
  // o TTL padrão é o do miss autoritativo, o transitório passa o próprio.
  const ttl = ttlSeconds ?? config.tmdb.missTtl;
  if (ttl > 0) cache.set(key, { miss: true }, ttl);
}

// Falha TRANSITÓRIA não é "título desconhecido": status 429/5xx, timeout de
// rede e `fetch failed` voltam sozinhos em segundos, enquanto um miss
// autoritativo (200 sem resultado, 404) é decisão estável da API. Confundi-los
// congelou o título pt-BR por TMDB_MISS_TTL inteiro após UM blip — a janela em
// que os indexadores BR eram consultados em inglês e devolviam 0.
function isTransientFailure(status: number) {
  return !status || status === 429 || status >= 500;
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
async function getTitles(imdbId: string) {
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
      if (!res.ok) {
        // Carrega o status no erro para o catch distinguir 404 (autoritativo)
        // de 429/5xx (transitório) — o Coringa da busca BR depende disso.
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

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
      // 404 e 200-sem-resultado são "não conhece" — condenam pelo missTtl
      // cheio. Rede, timeout, 429 e 5xx são transitórios: o id volta a ser
      // perguntado em TMDB_TRANSIENT_MISS_TTL, para um blip não derrubar a
      // cobertura pt-BR (que depende deste nome para os indexadores BR).
      const status = Number(err.status);
      setMiss(key, isTransientFailure(status) ? config.tmdb.transientMissTtl : undefined);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

export { getTitles };
