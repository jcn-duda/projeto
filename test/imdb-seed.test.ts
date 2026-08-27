// Semente do colhedor pela lista de populares do IMDb (RapidAPI) + coorte F3.
//
// O que se cobra aqui é o FILTRO, a economia e a COORTE (baseline BR): sem chave
// o módulo não toca a rede; o teto de enfileiramento limita só os ESCOLHIDOS,
// mas as DUAS listas são sempre baixadas (a coorte precisa do top real de
// filmes E de séries); obra já indexada não volta à fila mas fica na coorte; e
// falha de uma lista preserva o balde anterior do mesmo tipo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import { nextSeeds, popularCohort } from '../src/providers/imdb-seed.js';

const HOJE = new Date().toISOString().slice(0, 10);
const ANO = Number(HOJE.slice(0, 4));

const SEED_LAST = `${prefix('seed')}last`;
const SEED_COHORT = `${prefix('seed')}cohort`;

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
 * helper síncrono restauraria a config no meio do voo. Limpa os dois grãos da
 * semente (`seed:last` e `seed:cohort`) e as flags vivas do colhedor, para cada
 * teste começar de um ciclo limpo; o estado da semente fica zero no `finally`.
 */
async function comConfig<T>(patch: any, fn: () => Promise<T>): Promise<T> {
  const saved = { ...config.seed };
  const savedTop = config.f3.br.topPerType;
  Object.assign(config.seed, patch);
  harvesterLive.reset();
  cache.forget(SEED_LAST);
  cache.forget(SEED_COHORT);
  try {
    return await fn();
  } finally {
    Object.assign(config.seed, saved);
    config.f3.br.topPerType = savedTop;
    harvesterLive.reset();
    cache.forget(SEED_LAST);
    cache.forget(SEED_COHORT);
  }
}

test('sem RAPIDAPI_KEY o módulo é inerte: nenhuma requisição nem coorte nova', async () => {
  const stub = stubLists([filme('tt7000001')], []);
  try {
    const out = await comConfig({ apiKey: '', enabled: true }, () => nextSeeds());
    assert.deepEqual(out, []);
    assert.equal(stub.calls.length, 0, 'sem chave não se toca a rede');
    assert.equal(popularCohort(), null, 'sem chave também não se grava coorte');
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
    assert.deepEqual(
      out.map((o) => o.imdbId),
      ['tt7000010'],
      'só a lançada com público entra',
    );
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

test('obra já no índice não volta para a fila, mas a coorte a inclui', async () => {
  const conhecida = 'tt7000030';
  releaseIndex.record(conhecida, {}, [{ infoHash: 'a'.repeat(40), title: 'Filme Conhecido 1080p', seeders: 10, indexer: 'x' }]);
  const stub = stubLists([filme(conhecida), filme('tt7000031')], []);
  try {
    const escolhidas = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50, minVotes: 1000 }, async () => {
      const out = await nextSeeds();
      const coorte = popularCohort();
      assert.deepEqual(coorte?.movies, [conhecida, 'tt7000031'], 'a coorte carrega o top real (conhecida + nova)');
      return out;
    });
    assert.deepEqual(escolhidas.map((o) => o.imdbId), ['tt7000031'], 'a semente descobre, não renova');
  } finally {
    stub.restore();
  }
});

test('teto de enqueue limita os ESCOLHIDOS, mas as DUAS listas são consultadas', async () => {
  const configTop = config.f3.br.topPerType;
  config.f3.br.topPerType = 100;
  const stub = stubLists([filme('tt7000040'), filme('tt7000041'), filme('tt7000042')], [serie('tt7000043')]);
  try {
    await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 2, minVotes: 1000 }, async () => {
      const escolhidas = await nextSeeds();
      assert.deepEqual(escolhidas.map((o) => o.imdbId), ['tt7000040', 'tt7000041'], 'corta nos escolhidos, no topo dos filmes');
      const coorte = popularCohort();
      assert.deepEqual(coorte?.series, ['tt7000043'], 'a coorte carrega assim mesmo as séries');
      assert.deepEqual(coorte?.movies, ['tt7000040', 'tt7000041', 'tt7000042'], 'a coorte carrega os 3 filmes (não é cortada pelo teto de enqueue)');
    });
  } finally {
    stub.restore();
    config.f3.br.topPerType = configTop;
  }
  assert.ok(
    stub.calls.some((c) => c.url.includes('most-popular-tv')),
    'o teto de enqueue NÃO impede a lista de séries de ser chamada (a coorte precisa do top real de cada tipo)',
  );
});

test('popularCohort inclui conhecidas+novas, sanitiza e respeita topPerType por tipo', async () => {
  const conhecida = 'tt7000090';
  releaseIndex.record(conhecida, {}, [{ infoHash: 'b'.repeat(40), title: 'Conhecido 1080p', seeders: 10, indexer: 'x' }]);
  const stub = stubLists(
    [filme(conhecida), filme('tt7000091'), filme('tt7000092'), filme('tt7000093', { id: 'nao-imdb' })],
    [serie('tt7000094'), serie('tt7000095'), serie('tt7000096')],
  );
  try {
    const result = await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50, minVotes: 1000 }, async () => {
      config.f3.br.topPerType = 2;
      const out = await nextSeeds();
      return { out, coorte: popularCohort() };
    });
    const escolhidos = result.out.map((o: any) => o.imdbId);
    assert.ok(escolhidos.includes('tt7000091') && escolhidos.includes('tt7000092'), 'as novas entram no enqueue');
    assert.ok(!escolhidos.includes('tt7000090'), 'a conhecida não é re-enfileirada');
    assert.ok(!escolhidos.includes('nao-imdb'), 'o id inválido nem chega a candidato');
    const co = result.coorte;
    assert.ok(co && typeof co.at === 'number', 'a coorte traz a marca temporal da leitura');
    assert.deepEqual(co.movies, ['tt7000090', 'tt7000091'], 'topPerType=2 corta os filmes (a conhecida entra na coorte)');
    assert.deepEqual(co.series, ['tt7000094', 'tt7000095'], 'séries também top 2');
  } finally {
    stub.restore();
  }
});

test('coorte aplica o limite real de 100 obras independentemente em cada tipo', async () => {
  const movies = Array.from({ length: 105 }, (_, i) => filme(`tt71${String(i).padStart(5, '0')}`));
  const series = Array.from({ length: 105 }, (_, i) => serie(`tt72${String(i).padStart(5, '0')}`));
  const stub = stubLists(movies, series);
  try {
    await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 1 }, async () => {
      config.f3.br.topPerType = 100;
      await nextSeeds();
      const cohort = popularCohort();
      assert.equal(cohort?.movies.length, 100);
      assert.equal(cohort?.series.length, 100);
      assert.equal(cohort?.movies[0], movies[0].id);
      assert.equal(cohort?.movies[99], movies[99].id);
      assert.equal(cohort?.series[99], series[99].id);
    });
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
        'a chave NUNCA vai na URL',
      );
      assert.ok(stub.calls.every((c) => c.key === 'chave-secreta'), 'e vai só no header X-RapidAPI-Key');
    });
  } finally {
    stub.restore();
  }
});

test('falha de uma lista preserva o balde anterior da coorte (invariante 6)', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  try {
    await comConfig({ apiKey: 'k', enabled: true, maxPerCycle: 50, minVotes: 0 }, async () => {
      // Ciclo 1: OK — grava filmes [tt7000061] e séries [tt7000060].
      AbortSignal.timeout = () => new AbortController().signal;
      globalThis.fetch = (async (url: any) => {
        const u = String(url);
        const body = u.includes('most-popular-tv') ? [serie('tt7000060')] : [filme('tt7000061')];
        return { ok: true, status: 200, json: async () => body };
      }) as unknown as typeof globalThis.fetch;
      await nextSeeds();

      // Ciclo 2: a lista de filmes cai; a de séries sobe. O balde de filmes da
      // coorte anterior NÃO regride (baseline nunca volta por uma rede que treme).
      cache.forget(SEED_LAST);
      globalThis.fetch = (async (url: any) => {
        const u = String(url);
        if (u.includes('most-popular-movies')) throw new Error('rede caiu nos filmes');
        return { ok: true, status: 200, json: async () => [serie('tt7000062')] };
      }) as unknown as typeof globalThis.fetch;
      const escolhidas = await nextSeeds();
      assert.deepEqual(escolhidas.map((o) => o.imdbId), ['tt7000062'], 'a lista boa continua valendo');
      const coorte = popularCohort();
      assert.ok(coorte, 'a coorte sobrevive à falha de uma lista');
      assert.deepEqual(coorte.movies, ['tt7000061'], 'balde de filmes preservado da coorte anterior');
      assert.deepEqual(coorte.series, ['tt7000062'], 'séries atualizadas do ciclo novo');
    });
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
