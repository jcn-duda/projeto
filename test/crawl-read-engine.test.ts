// O card do painel lê o `crawl.db` pela foto do sidecar, sem abrir o arquivo.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  crawlReadEngine, refreshCrawlSnapshots, setCrawlReadEngineForTest,
} from '../src/providers/crawl-read-engine.js';
import { PROBE_STATE_KEY } from '../src/providers/crawl-site-probe.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setCrawlReadEngineForTest(null);
});

const SNAPSHOT = {
  site: 'nerdfilmes',
  counters: { total: 3, byStatus: { done: 2, error: 1 } },
  latestRun: { id: 7, site: 'nerdfilmes', phase: 'initial', cursor: '', startedAt: 1, finishedAt: null, counters: {} },
  magnetsFound: 13,
  lists: {
    done: [
      { url: 'https://x/a', imdb: 'tt1', releases: 5, checkedAt: 9, error: null, tries: 0, progress: null },
      { url: 'https://x/b', imdb: null, releases: 8, checkedAt: 8, error: null, tries: 0, progress: null },
    ],
    noWork: [],
    partial: [],
    error: [{ url: 'https://x/e', imdb: null, releases: 0, checkedAt: 4, error: 'timeout', tries: 2, progress: null }],
  },
  errorGroups: [{ reason: 'timeout', count: 1 }],
  state: { probeVerdict: '{"go":true}', cursorMovie: 'm1', cursorTvShow: '' },
};

test('a foto do sidecar alimenta os verbos de leitura do card', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
  }) as typeof fetch;
  await refreshCrawlSnapshots(['nerdfilmes']);
  const engine = crawlReadEngine();
  assert.ok(engine);
  assert.match(urls[0], /\/crawl\/site-snapshot\?site=nerdfilmes&limit=50$/);
  const counters = engine.counters('nerdfilmes');
  assert.equal(counters.total, 3);
  assert.equal(counters.byStatus.done, 2);
  assert.equal(counters.byStatus.pending, 0, 'status ausente da foto vale zero');
  assert.equal(engine.sumReleases('nerdfilmes'), 13);
  assert.equal(engine.latestRun('nerdfilmes')?.id, 7);
  assert.deepEqual(engine.listByStatus('nerdfilmes', 'done', 1).map((row) => row.url), ['https://x/a']);
  assert.equal(engine.listByStatus('nerdfilmes', 'error', 5)[0].error, 'timeout');
  assert.equal(engine.listByStatus('nerdfilmes', 'done', 5)[0].error, '', 'erro nulo vira vazio, como no store');
  assert.deepEqual(engine.errorGroups('nerdfilmes', 5), [{ reason: 'timeout', count: 1 }]);
  assert.equal(engine.getState('nerdfilmes', PROBE_STATE_KEY), '{"go":true}');
  assert.equal(engine.getState('nerdfilmes', 'cursor:movie'), 'm1');
  assert.equal(engine.getState('nerdfilmes', 'cursor:tv_show'), null);
});

test('sidecar fora do ar mantém a última foto e não lança', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 })) as typeof fetch;
  await refreshCrawlSnapshots(['nerdfilmes']);
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  await refreshCrawlSnapshots(['nerdfilmes']);
  assert.equal(crawlReadEngine()?.counters('nerdfilmes').total, 3);
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  await refreshCrawlSnapshots(['nerdfilmes']);
  assert.equal(crawlReadEngine()?.counters('nerdfilmes').total, 3, 'HTTP 500 não apaga a foto');
  globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  await refreshCrawlSnapshots(['nerdfilmes']);
  assert.equal(crawlReadEngine()?.counters('nerdfilmes').total, 3, 'corpo fora do contrato não apaga a foto');
});

test('site sem foto responde vazio, sem inventar dado', () => {
  const engine = crawlReadEngine();
  assert.ok(engine);
  assert.equal(engine.counters('nunca').total, 0);
  assert.equal(engine.latestRun('nunca'), null);
  assert.deepEqual(engine.listByStatus('nunca', 'done', 5), []);
  assert.equal(engine.getState('nunca', PROBE_STATE_KEY), null);
});
