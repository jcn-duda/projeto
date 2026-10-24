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

test('getMeta: prazo vem de config.cinemeta.timeout e é DURO (fetch pendurado termina)', async () => {
  // O prazo da Cinemeta é o de config.cinemeta.timeout, e é duro: a promessa
  // mora no inFlight do getMeta, e um fetch pendurado (medido no Docker,
  // 2026-09-30) travava a obra até o restart. Prova pelo comportamento: com o
  // dublê que nunca responde, o getMeta termina perto do prazo da config.
  const originalTimeoutMs = config.cinemeta.timeout;
  for (const type of ['movie', 'series']) {
    const imdbId = `tt-test-${type}-${process.pid}-${Date.now()}`;
    const key = `meta:${type}:${imdbId}`;
    const stub = stubFetch(() => new Promise(() => {}));
    try {
      config.cinemeta.timeout = 60;
      const t0 = Date.now();
      const meta = await getMeta(type, imdbId);
      const took = Date.now() - t0;
      assert.equal(meta, null);
      assert.ok(took >= 50 && took < 1000, `terminou no prazo da config (${took}ms)`);
      assert.equal(stub.calls[0].url, `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
      assert.equal(stub.calls[0].options.headers['User-Agent'], 'stremio-adom/1.0');
    } finally {
      stub.restore();
      config.cinemeta.timeout = originalTimeoutMs;
      cache.forget(key);
    }
  }
});

test('getMeta mantém o retorno normal (filme e série)', async () => {
  for (const [type, body, want] of [
    ['movie', { meta: { name: 'Coringa', year: '2019', type: 'movie' } }, { name: 'Coringa', year: '2019', type: 'movie' }],
    ['series', { meta: { name: 'Fallout', releaseInfo: '2024–' } }, { name: 'Fallout', year: '2024', type: 'series', episodes: {} }],
  ] as const) {
    const imdbId = `tt-ok-${type}-${process.pid}-${Date.now()}`;
    const stub = stubFetch(() => ({ ok: true, json: async () => body }));
    try {
      assert.deepEqual(await getMeta(type, imdbId), want);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
      cache.forget(`meta:${type}:${imdbId}`);
    }
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
