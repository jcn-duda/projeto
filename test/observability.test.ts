import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from '../src/utils/logger.js';
import * as metrics from '../src/utils/metrics.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { getMeta } from '../src/utils/cinemeta.js';
import { getTitles } from '../src/utils/tmdb.js';
import { applyDebrid } from '../src/providers/index.js';

// Os contadores de degradação passam pelo cache de metadados; persistência
// desligada para não tocar o data/cache.db real.
process.env.CACHE_PERSIST = 'false';

/** Forma do timer no snapshot: p50/p95 da janela podem faltar em silencio. */
type TimerSample = { count: number; avgMs: number; p50Ms: number | null; p95Ms: number | null; maxMs: number };

/** Captura o que o logger escreveria de verdade. */
function capture(fn: any) {
  const lines: { log: string[]; warn: string[]; error: string[] } = { log: [], warn: [], error: [] };
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.warn = (...args) => lines.warn.push(args.join(' '));
  console.error = (...args) => lines.error.push(args.join(' '));
  try {
    fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

test('o nível corta o que está abaixo dele e mantém o resto', () => {
  const original = log.level();
  try {
    log.setLevel('warn');
    const lines = capture(() => {
      log.error('[x] erro');
      log.warn('[x] aviso');
      log.info('[x] info');
      log.debug('[x] debug');
    });

    assert.deepEqual(lines.error, ['[x] erro']);
    assert.deepEqual(lines.warn, ['[x] aviso']);
    assert.deepEqual(lines.log, [], 'info e debug ficam de fora em warn');
  } finally {
    log.setLevel(original);
  }
});

test('debug só sai no nível debug; silent não deixa passar nada', () => {
  const original = log.level();
  try {
    log.setLevel('debug');
    assert.deepEqual(capture(() => log.debug('[x] por requisição')).log, ['[x] por requisição']);

    log.setLevel('silent');
    const mudo = capture(() => {
      log.error('[x] erro');
      log.warn('[x] aviso');
      log.info('[x] info');
    });
    assert.deepEqual([mudo.error, mudo.warn, mudo.log], [[], [], []]);
  } finally {
    log.setLevel(original);
  }
});

test('nível inválido avisa uma vez e cai no info em vez de silenciar tudo', () => {
  const original = log.level();
  try {
    const lines = capture(() => log.setLevel('verboso-demais'));

    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], /ADDON_LOG_LEVEL desconhecido/);
    // O risco de errar para o lado errado é o operador achar que configurou o
    // log e ficar sem nenhum.
    assert.equal(log.level(), 'info');
  } finally {
    log.setLevel(original);
  }
});

test('contadores somam e aparecem ordenados no snapshot', () => {
  metrics.reset();
  metrics.count('cache.hit');
  metrics.count('cache.hit');
  metrics.count('cache.miss', 3);

  const snap = metrics.snapshot();
  assert.deepEqual(snap.counters, { 'cache.hit': 2, 'cache.miss': 3 });
  assert.equal(typeof snap.uptimeS, 'number');
});

test('percentis vêm da janela, e a janela não cresce com o uso', () => {
  metrics.reset();
  // Mais amostras que o reservatório (256): as primeiras saem da janela, mas
  // count/max continuam sendo da vida inteira do processo.
  for (let i = 1; i <= 400; i += 1) metrics.observe('indexer.teste', i);

  const timer = metrics.snapshot().timers['indexer.teste'];
  assert.equal(timer.count, 400);
  assert.equal(timer.maxMs, 400);
  // A janela guarda 145..400; a mediana dela fica bem acima da mediana total.
  assert.ok(timer.p50Ms > 200, `p50 da janela deveria refletir o final da série, veio ${timer.p50Ms}`);
  assert.ok(timer.p95Ms >= timer.p50Ms);
});

test('medição inválida é ignorada em vez de virar NaN no snapshot', () => {
  metrics.reset();
  metrics.observe('x', Number.NaN);
  metrics.observe('x', undefined);
  metrics.observe('x', 10);

  assert.deepEqual((metrics.snapshot().timers as Record<string, TimerSample>).x, {
    count: 1,
    avgMs: 10,
    p50Ms: 10,
    p95Ms: 10,
    maxMs: 10,
  });
});

test('timed devolve a duração e registra a amostra', () => {
  metrics.reset();
  const done = metrics.timed('trecho');
  const ms = done();

  assert.equal(typeof ms, 'number');
  assert.equal((metrics.snapshot().timers as Record<string, TimerSample>).trecho.count, 1);
});

// Contadores de degradação: são o único jeito de ver no /metrics.json que a
// instância está pagando custo de rede evitável ou rodando às cegas no debrid.

test('miss servido do cache conta meta.cinemeta.miss.served', async () => {
  metrics.reset();
  const imdbId = `tt-obs-cinemeta-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
  try {
    await getMeta('movie', imdbId); // grava o sentinela
    await getMeta('movie', imdbId); // servido do miss
    await getMeta('movie', imdbId); // de novo
    assert.equal(metrics.snapshot().counters['meta.cinemeta.miss.served'], 2);
  } finally {
    global.fetch = originalFetch;
    cache.forget(key);
  }
});

test('miss servido do cache conta meta.tmdb.miss.served', async () => {
  metrics.reset();
  const originalKey = config.tmdb.apiKey;
  config.tmdb.apiKey = 'test-key';
  const imdbId = `tt-obs-tmdb-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ movie_results: [], tv_results: [] }),
  })) as unknown as typeof globalThis.fetch;
  try {
    await getTitles(imdbId);
    await getTitles(imdbId);
    assert.equal(metrics.snapshot().counters['meta.tmdb.miss.served'], 1);
  } finally {
    global.fetch = originalFetch;
    cache.forget(key);
    config.tmdb.apiKey = originalKey;
  }
});

test('checagem de cache sem resposta confiável conta debrid.check.unknown', async () => {
  metrics.reset();
  // cacheCheck: false é o caso Real-Debrid/Debrid-Link: known vira false e o
  // fluxo inteiro segue às cegas — o contador é o que denuncia isso.
  const fake = {
    id: 'fakeobs',
    label: 'FakeObs',
    short: 'FO',
    cacheCheck: false,
    checkCached: async () => new Set(),
    resolveLink: async () => null,
  };
  debrid.BY_ID.set(fake.id, fake as any);
  const originalSecret = config.debrid.resolveSecret;
  config.debrid.resolveSecret = '';
  try {
    const userOpts = runtime.decode(runtime.encode({ ds: fake.id, dk: 'obs-key' }));
    await runtime.run({ opts: userOpts, encoded: '' }, async () => {
      const streams = [{ infoHash: 'c'.repeat(40), title: 'Filme X', name: 'n', _seeders: 3 }];
      const out = await applyDebrid(streams, {
        season: null,
        episode: null,
        searchKey: 'obs-test',
        deadlineAt: null,
      } as any);
      assert.equal(out.length, 1);
      assert.ok(out[0]?.url?.includes('/resolve/'), 'sem resposta, tudo vai pelo debrid');
    });
    assert.equal(metrics.snapshot().counters['debrid.check.unknown'], 1);
  } finally {
    debrid.BY_ID.delete(fake.id);
    config.debrid.resolveSecret = originalSecret;
  }
});
