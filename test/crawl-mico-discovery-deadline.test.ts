// Fronteira do corte (Fase 6): o orçamento PRÓPRIO da descoberta do Mico, o
// marker `full-sweep:*` e o cursor por kind eram do motor TS. Agora a
// descoberta inteira roda no sidecar (`adom-crawl::mico_discovery` + lane
// `motor::mico_lane`): o Node não pede página, não enfileira e não grava
// marker. Os casos de passo fixo, vazio intermitente, fim por vazias, teto e
// corte incremental estão em `mico_discovery_tests.rs`; aqui só se prova que o
// TS não duplica esse estado — o `crawl_state` do Mico tem UM dono.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { CURSOR_STATE_KEY } = await import('../src/providers/crawl-cursor.js');

const savedCrawl = { ...config.crawl };
const MARKER = 'full-sweep:movie';

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['mico'], delayMs: 0, maxPerHour: 1000,
    idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10,
    incrementalIntervalMin: 60, seriesEnabled: false,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

test('tick do TS não descobre o Mico: sem página, sem fila, sem marker', async () => {
  let discovers = 0;
  let fetches = 0;
  crawler._setSitesForTest((id) => (id === 'mico' ? {
    id, label: id,
    discover: async () => {
      discovers += 1;
      return { urls: [{ url: `${config.mico.url}/crawl/movie/tt0000001/`, lastmod: '2026-01-01', kind: 'movie' as const }], complete: true, failures: [] };
    },
    fetchWork: async (url: string) => { fetches += 1; return { url, status: 'no-torrent' as const, releases: [] }; },
  } : null));
  crawler._forceDiscoveryForTest('mico');
  await crawler.tick();
  await crawler.tick();

  assert.equal(discovers, 0, 'a descoberta do Mico é do sidecar');
  assert.equal(fetches, 0, 'a leitura da página do Mico é do sidecar');
  assert.equal(store.engine().getState('mico', MARKER), null, 'o TS não grava o marker full-sweep');
  assert.equal(store.engine().getState('mico', CURSOR_STATE_KEY.movie), null, 'o TS não move o cursor do Mico');
  assert.equal(store.engine().counters('mico').total, 0, 'o TS não enfileira URL do Mico');
});

test('o estado do Mico gravado pelo sidecar sobrevive ao tick do TS', async () => {
  store.engine().setState('mico', MARKER, '2026-10-23T00:00:00Z');
  store.engine().setState('mico', CURSOR_STATE_KEY.movie, '2026-10-01T00:00:00Z');
  crawler._setSitesForTest((id) => (id === 'mico' ? {
    id, label: id,
    discover: async () => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string) => ({ url, status: 'no-torrent' as const, releases: [] }),
  } : null));
  await crawler.tick();
  assert.equal(store.engine().getState('mico', MARKER), '2026-10-23T00:00:00Z', 'marker intacto');
  assert.equal(store.engine().getState('mico', CURSOR_STATE_KEY.movie), '2026-10-01T00:00:00Z', 'cursor intacto');
});
