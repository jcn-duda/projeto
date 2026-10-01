// O colhedor pula o card que o raspador já cobre (`crawl-coverage.ts`): só com
// o site EM DIA (carga concluída, fora de simulação, fila pequena).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const live = await import('../src/utils/crawler-live.js');
const { crawlCoveredIndexers, initialLoadDone, _resetCoverageMemoForTest } = await import('../src/providers/crawl-coverage.js');
const { encodeListingCursor, listingCursorKey, startListingCursor, CURSOR_STATE_KEY } = await import('../src/providers/crawl-cursor.js');

const saved = { ...config.crawl };

beforeEach(() => {
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  _resetCoverageMemoForTest();
  Object.assign(config.crawl, {
    enabled: true, dryRun: false, sites: ['comandotorrents', 'hdrtorrent-cardigann'], siteOverrides: {},
    coverHarvest: true, coverMaxPending: 2, dbPath: saved.dbPath,
  });
});

after(() => {
  live._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, saved);
});

const pending = (site: string, n: number) => store.engine().upsertUrls(
  site, Array.from({ length: n }, (_, i) => ({ url: `https://x/${site}/${i}/`, kind: 'movie' as const, lastmod: '' })), Date.now(),
);

test('sitemap com cursor e fila pequena: coberto; fila grande ou sem cursor: não', () => {
  store.engine().setState('comandotorrents', CURSOR_STATE_KEY.movie, '2026-09-30T00:00:00Z');
  pending('comandotorrents', 2);
  assert.ok(crawlCoveredIndexers().has('comandotorrents'));
  _resetCoverageMemoForTest();
  pending('comandotorrents', 5); // 5 pendentes > 2
  assert.equal(crawlCoveredIndexers().has('comandotorrents'), false, 'backlog ainda não está no acervo');
});

test('página em erro não conta como atraso (HTTP 500 permanente do site)', () => {
  store.engine().setState('comandotorrents', CURSOR_STATE_KEY.movie, '2026-09-30T00:00:00Z');
  pending('comandotorrents', 5);
  for (let i = 0; i < 5; i += 1) {
    store.engine().markResult('comandotorrents', `https://x/comandotorrents/${i}/`, { status: 'error', error: 'http_500' } as never, Date.now());
  }
  assert.ok(crawlCoveredIndexers().has('comandotorrents'));
});

test('listagem: só cobre depois de virar incremental (sweep)', () => {
  const site = 'hdrtorrent-cardigann';
  const key = listingCursorKey('movie', '/pagina/');
  const cursor = startListingCursor(site, 'movie', '/pagina/', 1);
  store.engine().setState(site, key, encodeListingCursor({ ...cursor, page: 80 }));
  assert.equal(crawlCoveredIndexers().has(site), false, 'carga inicial em andamento');
  _resetCoverageMemoForTest();
  store.engine().setState(site, key, encodeListingCursor({ ...cursor, page: 1, sweep: true, anchor: '/x' }));
  assert.ok(crawlCoveredIndexers().has(site));
});

test('simulação, motor desligado ou kill-switch: nada coberto', () => {
  store.engine().setState('comandotorrents', CURSOR_STATE_KEY.movie, '2026-09-30T00:00:00Z');
  for (const patch of [{ dryRun: true }, { enabled: false }, { coverHarvest: false }]) {
    Object.assign(config.crawl, { dryRun: false, enabled: true, coverHarvest: true }, patch);
    live._resetForTest();
    _resetCoverageMemoForTest();
    assert.equal(crawlCoveredIndexers().size, 0, JSON.stringify(patch));
  }
});

test('fase da rodada: listagem em sweep conta como carga concluída (painel saía "Carga inicial" para sempre)', () => {
  const site = 'hdrtorrent-cardigann';
  const key = listingCursorKey('movie', '/pagina/');
  const cursor = startListingCursor(site, 'movie', '/pagina/', 1);
  store.engine().setState(site, key, encodeListingCursor({ ...cursor, page: 2100 }));
  assert.equal(initialLoadDone(store.engine(), site), false);
  store.engine().setState(site, key, encodeListingCursor({ ...cursor, page: 1, sweep: true, anchor: '/2die4' }));
  assert.equal(initialLoadDone(store.engine(), site), true);
});
