// Colhedor × raspador do Mico: o skip é POR KIND (review FIX 1). Uma série NÃO
// pode ser dada por coberta só porque o cursor de FILME andou — com a descoberta
// de série DESLIGADA (CRAWL_SERIES_ENABLED=false) ou em falha total (nenhum
// `cursor:tv_show` gravado), o colhedor VOLTA a colher série. O filtro de
// indexers Jackett (`crawlCoveredIndexers`, baseado em filme) segue intocado;
// aqui só o skip do Mico (`crawlCoversKind`, em `crawl-coverage.ts`).
//
// Cenários (cursor de filme × cursor de série gravados no store em memória):
//   (i)   só `cursor:movie`   → pula FILME, NÃO pula série;
//   (ii)  ambos               → pula filme E série;
//   (iii) só `cursor:tv_show` → pula SÉRIE, NÃO pula filme.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const { stubFetch } = await import('./helpers/stub.js');
const store = await import('../src/utils/crawl-store.js');
const live = await import('../src/utils/crawler-live.js');
const cache = await import('../src/utils/cache.js');
const { _resetCoverageMemoForTest } = await import('../src/providers/crawl-coverage.js');
const { CURSOR_STATE_KEY } = await import('../src/providers/crawl-cursor.js');
const harvestWorker = await import('../src/providers/harvest-worker.js');
const micoCrawl = await import('../src/providers/crawl-sites/mico.js');

const savedCrawl = { ...config.crawl };
const savedMico = { ...config.mico };
const savedJackett = config.jackett.indexers;
const savedTmdb = config.tmdb.apiKey;
const savedBludv = config.bludv.enabled;

/** Semeia os cursores de carga inicial do Mico e invalida o memo de cobertura. */
function seedCursors(movie: boolean, series: boolean): void {
  if (movie) store.engine().setState('mico', CURSOR_STATE_KEY.movie, '2026-10-01T00:00:00Z');
  if (series) store.engine().setState('mico', CURSOR_STATE_KEY.tv_show, '2026-10-01T00:00:00Z');
  _resetCoverageMemoForTest();
}

beforeEach(() => {
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  _resetCoverageMemoForTest();
  Object.assign(config.crawl, {
    enabled: true, dryRun: false, sites: ['mico'], siteOverrides: {},
    coverHarvest: true, coverMaxPending: 50, dbPath: savedCrawl.dbPath,
  });
  Object.assign(config.mico, { enabled: true, harvest: true, crawlMinGapMs: 0 });
  micoCrawl._resetThrottleForTest();
  config.jackett.indexers = [];
  config.tmdb.apiKey = '';
  config.bludv.enabled = false;
});

after(() => {
  live._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
  Object.assign(config.mico, savedMico);
  config.jackett.indexers = savedJackett;
  config.tmdb.apiKey = savedTmdb;
  config.bludv.enabled = savedBludv;
  micoCrawl._resetThrottleForTest();
});

/** Dublê: stream do Mico devolve vazio (a obra existe, só não tem torrent). */
function micoStreamStub() {
  return stubFetch((url) => {
    if (url.includes('/stream/')) return { ok: true, status: 200, json: async () => ({ streams: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Colhe um filme e uma série; devolve quantas chamadas de stream cada um fez.
 * Meta semeada em cache (`__metaV` = schema corrente) para o `getMeta` servir
 * sem rede — o `harvestOne` chega ao bloco do Mico com o nome resolvido. */
async function harvestPair(movieId: string, seriesId: string, stub: { calls: Array<{ url: string }> }) {
  cache.set(`meta:movie:${movieId}`, { name: 'Obra', year: '2019', type: 'movie', __metaV: 2 }, 3600);
  cache.set(`meta:series:${seriesId}`, { name: 'Série', year: '2014', type: 'series', episodes: { '1': 1 }, __metaV: 2 }, 3600);
  await harvestWorker.harvestOne({ imdbId: movieId, type: 'movie', reason: `m-${movieId}-${Date.now()}` } as any);
  await harvestWorker.harvestOne({ imdbId: seriesId, type: 'series', season: 1, episode: 1, reason: `s-${seriesId}-${Date.now()}` } as any);
  return {
    movie: stub.calls.filter((c) => c.url.includes('/stream/movie/')).length,
    series: stub.calls.filter((c) => c.url.includes('/stream/series/')).length,
  };
}

describe('colhedor: skip do Mico é POR KIND (série não é gateada pela cobertura de filme)', () => {
  test('(i) só cursor:movie → pula FILME, NÃO pula série', async () => {
    seedCursors(true, false);
    const stub = micoStreamStub();
    try {
      const calls = await harvestPair('tt9600101', 'tt9600102', stub);
      assert.equal(calls.movie, 0, 'filme coberto (cursor:movie) não consulta o Mico');
      assert.equal(calls.series, 1, 'série SEM cursor:tv_show volta a ser colhida');
    } finally {
      stub.restore();
    }
  });

  test('(ii) ambos os cursores → pula filme E série', async () => {
    seedCursors(true, true);
    const stub = micoStreamStub();
    try {
      const calls = await harvestPair('tt9600201', 'tt9600202', stub);
      assert.equal(calls.movie, 0, 'filme coberto (cursor:movie)');
      assert.equal(calls.series, 0, 'série coberta (cursor:tv_show)');
    } finally {
      stub.restore();
    }
  });

  test('(iii) só cursor:tv_show → pula SÉRIE, NÃO pula filme', async () => {
    seedCursors(false, true);
    const stub = micoStreamStub();
    try {
      const calls = await harvestPair('tt9600301', 'tt9600302', stub);
      assert.equal(calls.movie, 1, 'filme SEM cursor:movie é colhido');
      assert.equal(calls.series, 0, 'série coberta (cursor:tv_show) não consulta o Mico');
    } finally {
      stub.restore();
    }
  });
});
