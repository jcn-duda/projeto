import { test } from 'node:test';
import assert from 'node:assert';

// Persistência desligada ANTES dos imports: o cache real (data/cache.db) não
// pode ser lido nem gravado por este arquivo — CACHE_PERSIST=false faz o
// módulo de cache seguir só em memória. O IMDb id único por execução evita
// bater numa entrada real que já esteja na memória.
process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { getMeta } from '../src/utils/cinemeta.js';

test('getMeta usa config.cinemeta.timeout no AbortSignal e mantém o retorno normal', async () => {
  const originalFetch = global.fetch;
  const originalTimeoutFn = AbortSignal.timeout;
  const originalTimeoutMs = config.cinemeta.timeout;
  const imdbId = `tt-test-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;

  let capturedTimeout;
  const calls = [];

  try {
    // Valor bem diferente do default pra provar que o timeout vem da config,
    // e não de um literal escondido no código.
    config.cinemeta.timeout = 1234;

    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ meta: { name: 'Coringa', year: '2019', type: 'movie' } }),
      };
    };
    AbortSignal.timeout = (ms) => {
      capturedTimeout = ms;
      return { aborted: false };
    };

    assert.equal(cache.get(key), null, 'IMDb id único não pode nascer cacheado');
    const meta = await getMeta('movie', imdbId);

    // Retorno normal preservado: o meta parseado volta como sempre.
    assert.deepEqual(meta, { name: 'Coringa', year: '2019', type: 'movie' });
    assert.equal(calls.length, 1, 'não pode ter vindo do cache');
    assert.equal(calls[0].url, `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
    assert.equal(calls[0].options.headers['User-Agent'], 'stremio-adom/1.0');
    // A mudança em teste: o AbortSignal.timeout recebe o valor da config.
    assert.equal(capturedTimeout, config.cinemeta.timeout);
    assert.equal(capturedTimeout, 1234);
  } finally {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalTimeoutFn;
    config.cinemeta.timeout = originalTimeoutMs;
    // Limpa só a chave única deste arquivo — o cache real fica intocado.
    cache.forget(key);
  }
});

test('getMeta usa config.cinemeta.timeout também na variante série', async () => {
  const originalFetch = global.fetch;
  const originalTimeoutFn = AbortSignal.timeout;
  const originalTimeoutMs = config.cinemeta.timeout;
  const imdbId = `tt-test-${process.pid}-${Date.now()}`;
  const key = `meta:series:${imdbId}`;

  let capturedTimeout;
  const calls = [];

  try {
    config.cinemeta.timeout = 321;

    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ meta: { name: 'Fallout', releaseInfo: '2024–' } }),
      };
    };
    AbortSignal.timeout = (ms) => {
      capturedTimeout = ms;
      return { aborted: false };
    };

    const meta = await getMeta('series', imdbId);

    assert.deepEqual(meta, { name: 'Fallout', year: '2024', type: 'series' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
    assert.equal(capturedTimeout, 321);
  } finally {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalTimeoutFn;
    config.cinemeta.timeout = originalTimeoutMs;
    cache.forget(key);
  }
});
