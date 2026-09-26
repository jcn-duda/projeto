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

    assert.deepEqual(meta, { name: 'Fallout', year: '2024', type: 'series', episodes: {} });
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

test('getMeta carrega as datas REAIS (released/firstAired) sem inventar campo ausente', async () => {
  const imdbId = `tt-dates-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  const stub = stubFetch(() => ({
    ok: true,
    json: async () => ({
      meta: {
        name: 'Lançamento', year: '2026', type: 'movie',
        released: '2025-12-20T00:00:00.000Z',
        firstAired: '2025-12-20T00:00:00.000Z',
      },
    }),
  }));
  try {
    // A janela instantânea do banco usa estas datas para o teto de lançamento
    // recente; sem elas o consumidor só veria o ANO e um lançamento de dezembro
    // visto em janeiro escaparia do teto curto.
    const meta: any = await getMeta('movie', imdbId);
    assert.equal(meta.released, '2025-12-20T00:00:00.000Z');
    assert.equal(meta.firstAired, '2025-12-20T00:00:00.000Z');
  } finally {
    stub.restore();
    cache.forget(key);
  }

  // Campo ausente NÃO vira `undefined`/`null` no objeto — preserva o contrato
  // antigo (e o deepEqual das suítes existentes).
  const imdbId2 = `tt-dates2-${process.pid}-${Date.now()}`;
  const stub2 = stubFetch(() => ({
    ok: true,
    json: async () => ({ meta: { name: 'SemData', year: '2019', type: 'movie' } }),
  }));
  try {
    const meta: any = await getMeta('movie', imdbId2);
    assert.equal('released' in meta, false);
    assert.equal('firstAired' in meta, false);
  } finally {
    stub2.restore();
    cache.forget(`meta:movie:${imdbId2}`);
  }
});

test('getMeta série extrai a data por EPISÓDIO; sem vídeos o campo nem existe', async () => {
  const imdbId = `tt-eps-${process.pid}-${Date.now()}`;
  const stub = stubFetch(() => ({
    ok: true,
    json: async () => ({
      meta: {
        name: 'Série', year: '2020', type: 'series',
        videos: [
          { season: 1, episode: 1, number: 1, released: '2026-01-05T00:00:00.000Z' },
          { season: 1, episode: 2, number: 2, firstAired: '2026-01-12T00:00:00.000Z' },
          { season: 1, episode: 3, number: 3 },
          { season: 0, episode: 1, number: 1, released: '2019-01-01T00:00:00.000Z' },
        ],
      },
    }),
  }));
  try {
    // O teto de episódio recente precisa da data do EPISÓDIO: a estreia da
    // série (2020) é velha e não representa um E02 de 2026.
    const meta: any = await getMeta('series', imdbId);
    assert.deepEqual(meta.episodeAired, {
      '1:1': '2026-01-05T00:00:00.000Z',
      '1:2': '2026-01-12T00:00:00.000Z',
    });
  } finally {
    stub.restore();
    cache.forget(`meta:series:${imdbId}`);
  }

  const noVideos = `tt-eps0-${process.pid}-${Date.now()}`;
  const stub2 = stubFetch(() => ({
    ok: true,
    json: async () => ({ meta: { name: 'SemVídeos', releaseInfo: '2024–' } }),
  }));
  try {
    const meta: any = await getMeta('series', noVideos);
    assert.equal('episodeAired' in meta, false, 'sem vídeos o campo fica ausente (contrato antigo)');
  } finally {
    stub2.restore();
    cache.forget(`meta:series:${noVideos}`);
  }
});

test('meta antiga (sem a marca de formato) é reconsultada uma vez no deploy', async () => {
  const imdbId = `tt-oldmeta-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  // Metadado gravado pela versão anterior: sem a marca interna de formato (e
  // sem `released`) — se fosse servido, a janela instantânea ficaria cega por
  // até 24h após o deploy.
  cache.set(key, { name: 'Velho', year: '2019', type: 'movie' }, 3600);
  let fetches = 0;
  const stub = stubFetch(() => {
    fetches += 1;
    return {
      ok: true,
      json: async () => ({ meta: { name: 'Novo', year: '2026', type: 'movie', released: '2025-12-20T00:00:00.000Z' } }),
    };
  });
  try {
    const meta: any = await getMeta('movie', imdbId);
    assert.equal(fetches, 1, 'não serviu a entrada antiga sem datas');
    assert.equal(meta.released, '2025-12-20T00:00:00.000Z');
    // A releitura grava a marca: a segunda chamada não volta à rede e o objeto
    // entregue continua sem a marca (shape público preservado).
    const again: any = await getMeta('movie', imdbId);
    assert.equal(fetches, 1, 'a marca evita reconsultar a cada abertura');
    assert.equal('__metaV' in again, false, 'marca interna não vaza no retorno');
    assert.equal(again.name, 'Novo');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});

test('falha transitória do Cinemeta expira rápido e a busca seguinte consulta novamente', async () => {
  const originalMissTtl = config.cinemeta.missTtl;
  const originalTransient = config.cinemeta.transientMissTtl;
  const imdbId = `tt-transient-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  let fetches = 0;
  const stub = stubFetch(() => {
    fetches += 1;
    throw new Error('fetch failed');
  });

  try {
    config.cinemeta.missTtl = 300;
    config.cinemeta.transientMissTtl = 1;
    assert.equal(await getMeta('movie', imdbId), null);
    assert.equal(fetches, 1);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(await getMeta('movie', imdbId), null);
    assert.equal(fetches, 2, 'miss transitório expirado consulta novamente a API');
  } finally {
    stub.restore();
    cache.forget(key);
    config.cinemeta.missTtl = originalMissTtl;
    config.cinemeta.transientMissTtl = originalTransient;
  }
});

test('404 do Cinemeta permanece no miss autoritativo após o TTL transitório', async () => {
  const originalMissTtl = config.cinemeta.missTtl;
  const originalTransient = config.cinemeta.transientMissTtl;
  const imdbId = `tt-authoritative-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  let fetches = 0;
  const stub = stubFetch(() => {
    fetches += 1;
    return { ok: false, status: 404, json: async () => ({}) };
  });

  try {
    config.cinemeta.missTtl = 300;
    config.cinemeta.transientMissTtl = 1;
    assert.equal(await getMeta('movie', imdbId), null);
    assert.equal(fetches, 1);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(await getMeta('movie', imdbId), null);
    assert.equal(fetches, 1, '404 continua cacheado pelo missTtl autoritativo');
  } finally {
    stub.restore();
    cache.forget(key);
    config.cinemeta.missTtl = originalMissTtl;
    config.cinemeta.transientMissTtl = originalTransient;
  }
});
