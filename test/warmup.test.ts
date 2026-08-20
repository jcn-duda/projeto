import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import warmup from '../src/warmup.js';
import jackett from '../src/providers/jackett.js';
import * as activity from '../src/providers/activity.js';

const originalFetch = global.fetch;

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

test('warmup não abre rede quando desativado ou sem cache bruto/indexers', async () => {
  const saved = {
    enabled: config.warmup.enabled,
    maxItems: config.rawCache.maxItems,
    indexers: config.jackett.indexers,
  };
  let calls = 0;
  global.fetch = (async () => { calls += 1; return response({}); }) as typeof fetch;
  try {
    config.warmup.enabled = false;
    await warmup.start();
    config.warmup.enabled = true;
    config.rawCache.maxItems = 0;
    await warmup.start();
    config.rawCache.maxItems = saved.maxItems;
    config.jackett.indexers = [];
    await warmup.start();
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
    config.warmup.enabled = saved.enabled;
    config.rawCache.maxItems = saved.maxItems;
    config.jackett.indexers = saved.indexers;
  }
});

test('warmup consulta Jackett sem resolver protetores nem registrar status', async () => {
  const saved = {
    enabled: config.warmup.enabled, titles: config.warmup.titles, concurrency: config.warmup.concurrency,
    delay: config.warmup.indexerDelayMs, indexers: config.jackett.indexers, apiKey: config.jackett.apiKey,
  };
  const realSearch = jackett.search;
  const calls: any[] = [];
  global.fetch = (async (url) => {
    const text = String(url);
    if (text.includes('cinemeta')) return response({ meta: { name: 'Título', year: 2020 } });
    if (text.includes('themoviedb')) return response({ movie_results: [] });
    return response({ Results: [] });
  }) as typeof fetch;
  try {
    config.warmup.enabled = true;
    config.warmup.titles = ['tt1234567:movie'];
    config.warmup.concurrency = 1;
    config.warmup.indexerDelayMs = 0;
    config.jackett.indexers = ['test-indexer'];
    config.jackett.apiKey = 'test-key';
    jackett.search = (async (...args: any[]) => { calls.push(args); return []; }) as typeof jackett.search;
    await warmup.start();
    assert.ok(calls.length > 0);
    assert.equal(calls[0][3].skipResolve, true);
    assert.equal(calls[0][3].recordStatus, false);
  } finally {
    jackett.search = realSearch;
    global.fetch = originalFetch;
    config.warmup.enabled = saved.enabled;
    config.warmup.titles = saved.titles;
    config.warmup.concurrency = saved.concurrency;
    config.warmup.indexerDelayMs = saved.delay;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
  }
});

test('tráfego do usuário impede novas tarefas de warmup', async () => {
  activity.noteUserRequest();
  assert.equal(activity.hasUserTraffic(), true);
});
