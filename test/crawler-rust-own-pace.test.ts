// Contrato da fachada do raspador depois que o loop TS saiu: os NOVE sites da
// tabela são do sidecar Rust (o Mico pela lane de ritmo próprio,
// `adom-crawl::motor::mico_lane`) e o Node não move fila nenhuma. O `start()`
// só devolve à fila o `simulated` do dry-run antigo do motor TS; a retomada de
// `inflight` é do sidecar no boot (`motor::requeue_inflight_on_boot`, que
// percorre `all_site_ids`, Mico incluído).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const registry = await import('../src/providers/crawl-sites/registry.js');

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, { enabled: true, dryRun: false, sites: ['mico'] });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

const movie = (url: string, lastmod = '2026-01-01') => ({ url, lastmod, kind: 'movie' as const });

describe('fachada do raspador: os nove sites são do sidecar Rust', () => {
  test('registro: todo site da tabela é rust e o Mico tem ritmo próprio', () => {
    for (const id of registry.tableIds()) {
      assert.equal(registry.isRustSite(id), true, `${id} é do sidecar`);
      assert.equal(registry.siteInfo(id).adapter, true, `${id} tem adaptador (no sidecar)`);
    }
    assert.equal(registry.isOwnPace('mico'), true, 'ritmo próprio continua declarado (lane do Rust)');
    assert.deepEqual(registry.adapterIds(), registry.tableIds(), 'o painel pode ligar qualquer site da tabela');
  });

  test('start() não mexe na inflight: a retomada é do sidecar', () => {
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt2000000/')], 1);
    assert.equal(store.engine().takeNext('mico', 2)?.status, 'inflight', 'claim em voo do sidecar');
    crawler.start();
    assert.equal(store.engine().getUrl('mico', '/crawl/movie/tt2000000/')?.status, 'inflight',
      'o Node não devolve à fila uma página que o sidecar pode estar processando');
  });

  test('start() devolve à fila o simulated do dry-run antigo com o dry-run desligado', () => {
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt3000000/')], 1);
    const row = store.engine().takeNext('mico', 2);
    assert.ok(row);
    store.engine().markResult('mico', row.url, { status: 'simulated', imdb: 'tt3000000', releases: 1 }, 3);
    assert.equal(store.engine().getUrl('mico', row.url)?.status, 'simulated');
    crawler.start();
    assert.equal(store.engine().getUrl('mico', row.url)?.status, 'pending',
      'simulated volta a pending para o sidecar gravar de verdade');
  });

  test('start() com dry-run ligado não toca o simulated', () => {
    Object.assign(config.crawl, { dryRun: true });
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt4000000/')], 1);
    const row = store.engine().takeNext('mico', 2);
    assert.ok(row);
    store.engine().markResult('mico', row.url, { status: 'simulated', imdb: 'tt3000000', releases: 1 }, 3);
    crawler.start();
    assert.equal(store.engine().getUrl('mico', row.url)?.status, 'simulated');
  });
});
