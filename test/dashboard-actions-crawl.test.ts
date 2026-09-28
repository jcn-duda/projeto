// Ações do crawler no painel (Fase 4): dispatch real por /dashboard-action.json
// (allowlist → confirm → gate), com adaptador dublê injetado e store em
// memória. Nada toca rede, o Vaca real, o acervo ou a VPS.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as crawler from '../src/providers/crawler.js';
import * as store from '../src/utils/crawl-store.js';
import * as live from '../src/utils/crawler-live.js';
import { createTestServer } from './e2e/e2e-harness.js';
import type { CrawlDiscovery, CrawlSite } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const TOKEN = 'tok-crawl';
let server: any;
const saved: Record<string, any> = {};
const savedCrawl = { ...config.crawl };

const movie = (url: string) => ({ url, lastmod: '2026-01-01', kind: 'movie' as const });

function item(seed: string): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return {
    title: 'Fake (2000) 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1, size: 1000,
  };
}

function fakeSite(): CrawlSite {
  return {
    id: 'fake',
    label: 'Fake Site',
    discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string) => ({
      url, status: 'done' as const, imdb: 'tt1000000', title: 'Fake', year: 2000,
      type: 'movie' as const, releases: [item(url)],
    }),
  };
}

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  server = await createTestServer(createApp().app);
});

beforeEach(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: false, dryRun: true, sites: ['fake'], delayMs: 0, maxPerHour: 1000,
    idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10, incrementalIntervalMin: 60,
  });
  crawler._setSitesForTest(() => fakeSite());
});

after(async () => {
  await server.close();
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  config.jackett.testToken = saved.testToken;
  Object.assign(config.crawl, savedCrawl);
});

const post = (body: Record<string, unknown>) =>
  server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body,
  });

test('crawl-pause alterna a pausa manual', async () => {
  const paused = await post({ action: 'crawl-pause', paused: true });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.paused, true);
  const resumed = await post({ action: 'crawl-pause', paused: false });
  assert.equal(resumed.json.paused, false);
});

test('crawl-config-get/set/reset com validação do schema', async () => {
  const get = await post({ action: 'crawl-config-get' });
  assert.equal(get.status, 200);
  assert.ok(Array.isArray(get.json.config.schema));

  const bad = await post({ action: 'crawl-config-set', patch: { nope: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'validation_error');

  const set = await post({ action: 'crawl-config-set', patch: { enabled: true, delayMs: 700 } });
  assert.equal(set.status, 200);
  assert.equal(set.json.effective.enabled, true);
  assert.equal(set.json.effective.delayMs, 700);

  const reset = await post({ action: 'crawl-config-reset', confirm: true });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.effective.enabled, false, 'volta ao default do .env');
});

test('crawl-simulate roda em dry-run e devolve o que seria gravado', async () => {
  store.engine().upsertUrls('fake', [movie('/a'), movie('/b')], 1);
  const res = await post({ action: 'crawl-simulate', max: 20 });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.pages, 2);
  assert.equal(res.json.results[0].kind, 'simulated'); // simula��o n�o � done
  // Não consumiu a fila: as duas URLs continuam pendentes.
  assert.equal(store.engine().counters('fake').byStatus.pending, 2);
});

test('crawl-reprocess-errors reenfileira os erros do site', async () => {
  store.engine().upsertUrls('fake', [movie('/a')], 1);
  store.engine().markResult('fake', '/a', { status: 'error', error: 'HTTP 500' }, 1, { maxTries: 9 });
  const res = await post({ action: 'crawl-reprocess-errors' });
  assert.equal(res.status, 200);
  assert.equal(res.json.requeued, 1);
  assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending');
});

test('crawl-reprocess-no-work devolve à fila só o sem obra do site, sem confirm', async () => {
  store.engine().upsertUrls('fake', [movie('/a'), movie('/b'), movie('/c')], 1);
  store.engine().markResult('fake', '/a', { status: 'no-work', imdb: null, releases: 0 }, 1);
  store.engine().markResult('fake', '/b', { status: 'done', imdb: 'tt1', releases: 2 }, 1);
  store.engine().markResult('fake', '/c', { status: 'no-torrent', imdb: null, releases: 0 }, 1);
  const res = await post({ action: 'crawl-reprocess-no-work', site: 'fake' });
  assert.equal(res.status, 200, 'não é destrutiva: nada é apagado');
  assert.equal(res.json.requeued, 1);
  assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending');
  assert.equal(store.engine().getUrl('fake', '/b')?.status, 'done', 'obra identificada fica');
  assert.equal(store.engine().getUrl('fake', '/c')?.status, 'no-torrent', 'sem torrent não é sem obra');
});

test('reprocessar site fora do motor é 400 com motivo (não "0 URL(s)" em 200)', async () => {
  for (const action of ['crawl-reprocess-no-work', 'crawl-reprocess-errors']) {
    const res = await post({ action, site: 'outro' });
    assert.equal(res.status, 400, action);
    assert.equal(res.json.ok, false);
    assert.deepEqual(res.json.errors, ['site-desconhecido']);
  }
});

test('crawl-reset exige confirm e apaga só o site informado', async () => {
  store.engine().upsertUrls('fake', [movie('/a')], 1);
  store.engine().upsertUrls('outro', [movie('/x')], 1);

  const noConfirm = await post({ action: 'crawl-reset', site: 'fake' });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.error, 'confirmation_required');

  const unknown = await post({ action: 'crawl-reset', site: 'outro', confirm: true });
  assert.equal(unknown.status, 400, 'site fora da config viva é recusado');

  const ok = await post({ action: 'crawl-reset', site: 'fake', confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.urls, 1);
  assert.equal(store.engine().counters('fake').total, 0);
  assert.equal(store.engine().counters('outro').total, 1);
});
