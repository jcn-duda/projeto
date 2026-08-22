// Semente do colhedor pela lista de populares do IMDb (RapidAPI).
//
// O que se cobra aqui é o FILTRO e a economia, não a API: sem chave o módulo
// não pode tocar a rede; estreia futura e obra sem público não podem virar
// consulta do teto horário; obra já indexada não volta para a fila; e o
// cooldown precisa segurar o ciclo seguinte mesmo quando a rede falha — o tick
// roda a cada 60s e sem a marca a API seria consultada 60 vezes por hora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { nextSeeds } from '../src/providers/imdb-seed.js';

const HOJE = new Date().toISOString().slice(0, 10);
const ANO = Number(HOJE.slice(0, 4));

const filme = (id: string, extra: any = {}) => ({
  id,
  type: 'movie',
  primaryTitle: `Filme ${id}`,
  releaseDate: `${ANO - 2}-01-01`,
  startYear: ANO - 2,
  numVotes: 50_000,
  ...extra,
});

const serie = (id: string, extra: any = {}) => ({
  id,
  type: 'tvSeries',
  primaryTitle: `Serie ${id}`,
  releaseDate: `${ANO - 3}-01-01`,
  startYear: ANO - 3,
  numVotes: 80_000,
  ...extra,
});

/** Dublê de fetch por lista, registrando as URLs e os headers enviados. */
function stubLists(movies: any[], tv: any[]) {
  const calls: { url: string; key: string }[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, key: String(init?.headers?.['x-rapidapi-key'] || '') });
    const body = u.includes('most-popular-tv') ? tv : movies;
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

/**
 * ASYNC de propósito: `nextSeeds` roda síncrono só até o primeiro await, e um
 * helper síncrono restauraria a config no meio do voo — o módulo leria a config
 * real depois do fetch (foi assim que o teto e a chave saíram errados).
 */
async function comConfig<T>(patch: any, fn: () => Promise<T>): Promise<T> {
  const saved = { ...config.seed };
  Object.assign(config.seed, patch);
  cache.forget(`${prefix('seed')}last`);
  try {
    return await fn();
  } finally {
    Object.assign(config.seed, saved);
    cache.forget(`${prefix('seed')}last`);
  }
}

test('sem RAPIDAPI_KEY o módulo é inerte: nenhuma requisição', async () => {
  const stub = stubLists([filme('tt7000001')], []);
  try {
    const out = await comConfig({ apiKey: '', enabled: true }, () => nextSeeds());
    assert.deepEqual(out, []);
    assert.equal(stub.calls.length, 0, 'sem chave não se toca a rede');
  } finally {
    stub.restore();
  }
});

test('SEED_ENABLED=false desliga mesmo com chave', async () => {
  const stub = stubLists([filme('tt7000002')], []);
  try {
    const out = await comConfig({ apiKey: 'k', enabled: false }, () => nextSeeds());
    assert.deepEqual(out, []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('estreia futura e obra sem público ficam de fora', async () => {
  const stub = stubLists(
    [
      filme('tt7000010'),
      filme('tt7000011', { releaseDate: `${ANO + 1}-06-01`, startYear: ANO + 1 }),
      filme('tt7000012', { numVotes: 12 }),
      filme('tt7000013', { id: 'nao-e-imdb' }),
    ],
    [],
  );
  try {
    const out = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50, minVotes: 1000 }, () => nextSeeds());
    const ids = out.map((o) => o.imdbId);
    assert.deepEqual(ids, ['tt7000010'], 'só a lançada com público entra');
  } finally {
    stub.restore();
  }
});

test('tipos do IMDb viram movie/series (tvMovie e tvMiniSeries incluídos)', async () => {
  const stub = stubLists(
    [filme('tt7000020', { type: 'tvMovie' }), filme('tt7000021', { type: 'videoGame' })],
    [serie('tt7000022', { type: 'tvMiniSeries' })],
  );
  try {
    const out = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50 }, () => nextSeeds());
    assert.deepEqual(
      out.map((o) => `${o.imdbId}:${o.type}`),
      ['tt7000020:movie', 'tt7000022:series'],
      'videoGame não entra; tvMovie é filme e tvMiniSeries é série',
    );
  } finally {
    stub.restore();
  }
});

test('obra já no índice não volta para a fila', async () => {
  const conhecida = 'tt7000030';
  releaseIndex.record(conhecida, {}, [
    { infoHash: 'a'.repeat(40), title: 'Filme Conhecido 1080p', seeders: 10, indexer: 'x' },
  ]);
  const stub = stubLists([filme(conhecida), filme('tt7000031')], []);
  try {
    const out = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50 }, () => nextSeeds());
    assert.deepEqual(out.map((o) => o.imdbId), ['tt7000031'], 'a semente descobre, não renova');
  } finally {
    stub.restore();
  }
});

test('teto por ciclo respeita a ordem de popularidade', async () => {
  const stub = stubLists([filme('tt7000040'), filme('tt7000041'), filme('tt7000042')], [serie('tt7000043')]);
  try {
    const out = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 2 }, () => nextSeeds());
    assert.deepEqual(out.map((o) => o.imdbId), ['tt7000040', 'tt7000041'], 'corta no teto, do topo da lista');
    assert.ok(
      !stub.calls.some((c) => c.url.includes('most-popular-tv')),
      'teto alcançado nos filmes nem pede a lista de séries',
    );
  } finally {
    stub.restore();
  }
});

test('cooldown segura o ciclo seguinte e a chave vai no header, não na URL', async () => {
  const stub = stubLists([filme('tt7000050')], []);
  try {
    await comConfig({ apiKey: 'chave-secreta', enabled: true, maxPerCycle: 50, intervalH: 24 }, async () => {
      const primeiro = await nextSeeds();
      assert.equal(primeiro.length, 1);
      const chamadas = stub.calls.length;
      const segundo = await nextSeeds();
      assert.deepEqual(segundo, [], 'o segundo ciclo é segurado pelo cooldown');
      assert.equal(stub.calls.length, chamadas, 'e não gasta requisição nenhuma');
      assert.ok(
        stub.calls.every((c) => !c.url.includes('chave-secreta')),
        'a chave NUNCA vai na URL — só no header',
      );
      assert.ok(stub.calls.every((c) => c.key === 'chave-secreta'), 'e vai no header');
    });
  } finally {
    stub.restore();
  }
});

test('lista que falha não impede a outra nem derruba o ciclo', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('most-popular-movies')) throw new Error('rede caiu');
    return { ok: true, status: 200, json: async () => [serie('tt7000060')] };
  }) as unknown as typeof globalThis.fetch;
  try {
    const out = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50 }, () => nextSeeds());
    assert.deepEqual(out.map((o) => o.imdbId), ['tt7000060'], 'a lista boa continua valendo');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
