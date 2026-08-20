// Rodada 2: checagem ligada; os dublês usam test/helpers/stub.ts.
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
import { stubFetch } from './helpers/stub.js';

test('getMeta usa config.cinemeta.timeout no AbortSignal e mantém o retorno normal', async () => {
  const originalTimeoutFn = AbortSignal.timeout;
  const originalTimeoutMs = config.cinemeta.timeout;
  const imdbId = `tt-test-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  const stub = stubFetch(() => ({
    ok: true,
    json: async () => ({ meta: { name: 'Coringa', year: '2019', type: 'movie' } }),
  }));

  let capturedTimeout;

  try {
    // Valor bem diferente do default pra provar que o timeout vem da config,
    // e não de um literal escondido no código.
    config.cinemeta.timeout = 1234;

    AbortSignal.timeout = (ms) => {
      capturedTimeout = ms;
      // O signal fake só precisa existir: o dublê de fetch ignora
      // `options.signal`. O cast via unknown existe porque `{ aborted: false }`
      // não é comparável a AbortSignal em nenhuma direção (TS2352).
      return { aborted: false } as unknown as AbortSignal;
    };

    assert.equal(cache.get(key), null, 'IMDb id único não pode nascer cacheado');
    const meta = await getMeta('movie', imdbId);

    // Retorno normal preservado: o meta parseado volta como sempre.
    assert.deepEqual(meta, { name: 'Coringa', year: '2019', type: 'movie' });
    assert.equal(stub.calls.length, 1, 'não pode ter vindo do cache');
    assert.equal(stub.calls[0].url, `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
    assert.equal(stub.calls[0].options.headers['User-Agent'], 'stremio-adom/1.0');
    // A mudança em teste: o AbortSignal.timeout recebe o valor da config.
    assert.equal(capturedTimeout, config.cinemeta.timeout);
    assert.equal(capturedTimeout, 1234);
  } finally {
    stub.restore();
    AbortSignal.timeout = originalTimeoutFn;
    config.cinemeta.timeout = originalTimeoutMs;
    // Limpa só a chave única deste arquivo — o cache real fica intocado.
    cache.forget(key);
  }
});

test('getMeta usa config.cinemeta.timeout também na variante série', async () => {
  const originalTimeoutFn = AbortSignal.timeout;
  const originalTimeoutMs = config.cinemeta.timeout;
  const imdbId = `tt-test-${process.pid}-${Date.now()}`;
  const key = `meta:series:${imdbId}`;
  const stub = stubFetch(() => ({
    ok: true,
    json: async () => ({ meta: { name: 'Fallout', releaseInfo: '2024–' } }),
  }));

  let capturedTimeout;

  try {
    config.cinemeta.timeout = 321;

    AbortSignal.timeout = (ms) => {
      capturedTimeout = ms;
      return { aborted: false } as unknown as AbortSignal;
    };

    const meta = await getMeta('series', imdbId);

    assert.deepEqual(meta, { name: 'Fallout', year: '2024', type: 'series' });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
    assert.equal(capturedTimeout, 321);
  } finally {
    stub.restore();
    AbortSignal.timeout = originalTimeoutFn;
    config.cinemeta.timeout = originalTimeoutMs;
    cache.forget(key);
  }
});