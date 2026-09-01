// P5 Fatia A — recompute offline: matéria-prima local + peeks quiet.
//
// O contrato aqui é o da HONESTIDADE: o recompute só explica o que existe
// localmente, rotula tudo como estado ATUAL (`now`, nunca causa histórica) e
// nunca reescreve a entrada nem toca rede. `no-material` e `no-names` são
// resultados legítimos — ausência de evidência nunca autoriza afirmação.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as runtime from '../src/runtime.js';
import * as config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import { recomputeOffline, collectLocalMaterial } from '../src/utils/trace-recompute.js';
import { withMockFetch } from './e2e/e2e-harness.js';

const OPTS = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-diag' };

// setup-env pina JACKETT_INDEXERS vazio; para semear o raw precisamos de um
// indexer real no config E nos opts efetivos (o recompute lê opts().jackettIndexers).
// Restaurado no fim de cada teste que o usa.
const IDX = () => {
  const saved = config.default.jackett.indexers;
  config.default.jackett.indexers = ['torrentleech'];
  return () => { config.default.jackett.indexers = saved; };
};
const RUN = (fn: () => unknown) => runtime.run(
  { opts: { ...OPTS, jackettIndexers: ['torrentleech'] }, encoded: 'diag' },
  fn,
);

test('sem nomes o recompute responde no-names (nunca inventa filtro de título)', () => {
  const out = RUN(() => recomputeOffline('tt123', { season: null, episode: null }, [], null)) as ReturnType<typeof recomputeOffline>;
  assert.equal(out.built, false);
  assert.equal(out.note, 'no-names');
  assert.deepEqual(out.items, []);
});

test('sem matéria-prima local o recompute responde no-material', () => {
  cache.clear();
  const out = RUN(() => recomputeOffline('tt999', { season: null, episode: null }, ['Filme'], 2020)) as ReturnType<typeof recomputeOffline>;
  assert.equal(out.built, false);
  assert.equal(out.note, 'no-material');
  assert.deepEqual(out.basis, []);
});

test('matéria-prima do raw quente vira itens com now tocável', async () => {
  const restore = IDX();
  try {
    await withMockFetch([], async () => {
      // Semeia DENTRO do mock (ele faz cache.clear() na entrada): a chave é a
      // que a busca usaria (rawKeysFor).
      const key = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme 2020', 'movie')[0];
      cache.set(key, [{ title: 'Filme.2020.1080p.DUAL', infoHash: 'f'.repeat(40), seeders: 4, indexer: 'x', size: 1024 }], 900);
      const out = RUN(() => recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020)) as ReturnType<typeof recomputeOffline>;
      assert.equal(out.built, true);
      assert.ok(out.basis.includes('raw'), `basis deveria incluir raw: ${out.basis}`);
      assert.equal(out.items.length, 1);
      assert.equal(out.items[0].now.state, 'tocável');
    });
  } finally {
    restore();
  }
});

test('label do recompute usa a MESMA defesa do trace (magnet/hash + teto 60)', async () => {
  const restore = IDX();
  try {
    await withMockFetch([], async () => {
      const hash = 'a'.repeat(40);
      const sujo = `Filme 2020 ${hash} magnet:?xt=urn:btih:${hash}&dn=Filme [${hash}] ${'X'.repeat(200)}`;
      const key = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme 2020', 'movie')[0];
      cache.set(key, [{ title: sujo, infoHash: 'f'.repeat(40), seeders: 4, indexer: 'x' }], 900);
      const out = RUN(() => recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020)) as ReturnType<typeof recomputeOffline>;
      assert.equal(out.built, true);
      const label = out.items[0].label;
      assert.ok(label.length <= 60, `label passou do teto: ${label.length}`);
      assert.doesNotMatch(label, /magnet:/i);
      assert.doesNotMatch(label, /[a-f0-9]{40}/i);
      assert.match(label, /<hash>/);
      assert.match(label, /<magnet>/);
    });
  } finally {
    restore();
  }
});

test('estado atual reflete bad do magnetdb (quiet) — e é now, não causa', async () => {
  const restore = IDX();
  try {
    cache.clear();
    const key = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme 2020', 'movie')[0];
    const rel = { title: 'Filme.2020.1080p.DUAL', infoHash: 'f'.repeat(40), seeders: 4, indexer: 'x' };
    cache.set(key, [rel], 900);
    magnetdb.markBad('premiumize', 'chave-diag', 'f'.repeat(40));
    try {
      const out = RUN(() => recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020)) as ReturnType<typeof recomputeOffline>;
      assert.equal(out.built, true);
      assert.equal(out.items[0].now.state, 'bad', 'a foto de hoje mostra o bad');
    } finally {
      magnetdb.forgetBad('premiumize', 'chave-diag', 'f'.repeat(40));
    }
  } finally {
    restore();
  }
});

test('o recompute é ZERO rede (fetch stub conta 0 chamadas)', async () => {
  const restore = IDX();
  try {
    await withMockFetch([], async (mockFetch) => {
      const key = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme 2020', 'movie')[0];
      cache.set(key, [{ title: 'Filme', infoHash: 'f'.repeat(40), seeders: 1, indexer: 'x' }], 900);
      RUN(() => recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020));
      assert.equal(mockFetch.calls.length, 0, 'recompute nunca sai à rede');
    });
  } finally {
    restore();
  }
});

test('o recompute NÃO reescreve a entrada streams', () => {
  const restore = IDX();
  try {
    cache.clear();
    const key = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme 2020', 'movie')[0];
    cache.set(key, [{ title: 'Filme', infoHash: 'f'.repeat(40), seeders: 1, indexer: 'x' }], 900);
    const entrada = { streams: [{ name: 'A' }], partial: false, debridKnown: true, searchMeta: { names: ['Filme'], year: 2020 } };
    const cacheKey = 'streams:v9:diag:tt123:{}:account:none';
    cache.set(cacheKey, entrada, 900);
    RUN(() => recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020));
    const depois = cache.get(cacheKey) as unknown;
    assert.deepEqual(depois, entrada, 'entrada intacta — recompute é leitura pura');
    cache.forget(cacheKey);
  } finally {
    restore();
  }
});

test('collectLocalMaterial deduplica por hash entre origens', () => {
  const restore = IDX();
  try {
    cache.clear();
    const k1 = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme 2020', 'movie')[0];
    const k2 = jackett.rawKeysFor(config.default.jackett.indexers, 'Filme', 'movie')[0];
    const rel = { title: 'Filme.2020', infoHash: 'f'.repeat(40), seeders: 2, indexer: 'x' };
    cache.set(k1, [rel], 900);
    cache.set(k2, [{ ...rel, seeders: 9 }], 900);
    const { items } = RUN(() => collectLocalMaterial('tt123', { season: null, episode: null, names: ['Filme'], year: 2020 })) as { items: unknown[] };
    assert.equal(items.length, 1, 'mesmo hash de duas queries entra uma vez');
  } finally {
    restore();
  }
});

test('N3: o recompute lê a LISTA EFETIVA do usuário (opts), não a do operador', async () => {
  // Instalação com lista customizada != lista do operador: o balde bruto tem
  // que bater com o que A INSTALAÇÃO consultou — regressão para config.jackett
  // .indexers (operador) deixaria este teste vazio.
  const restore = IDX(); // config do operador = ['torrentleech']
  try {
    cache.clear();
    // Semeia SÓ na chave do indexer CUSTOM do usuário.
    const key = jackett.rawKeysFor(['custom-br'], 'Filme 2020', 'movie')[0];
    cache.set(key, [{ title: 'Filme.2020', infoHash: 'f'.repeat(40), seeders: 3, indexer: 'x' }], 900);
    const out = runtime.run(
      { opts: { ...OPTS, jackettIndexers: ['custom-br'] }, encoded: 'diag' },
      () => recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020),
    ) as ReturnType<typeof recomputeOffline>;
    assert.equal(out.built, true, 'material encontrado na lista CUSTOM do usuário');
    assert.ok(out.basis.includes('raw'));
  } finally {
    restore();
  }
});
