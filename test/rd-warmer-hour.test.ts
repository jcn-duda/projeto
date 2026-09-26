import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import { rdGate } from '../src/debrid/rd-gate.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import { prefix } from '../src/utils/cache-keys.js';

const HOUR_KEY = `${prefix('rdq')}hour`;
const [H1, H2] = ['1', '2'].map((c) => c.repeat(40));

const savedConfig = {
  service: config.debrid.service,
  apiKey: config.debrid.apiKey,
  allowEnvKey: config.debrid.allowEnvKey,
  rdWarm: { ...config.debrid.rdWarm },
  rdLedger: { ...config.debrid.rdLedger },
  rdGate: { ...config.debrid.rdGate },
};

function restoreConfig() {
  config.debrid.service = savedConfig.service;
  config.debrid.apiKey = savedConfig.apiKey;
  config.debrid.allowEnvKey = savedConfig.allowEnvKey;
  config.debrid.rdWarm = { ...savedConfig.rdWarm };
  config.debrid.rdLedger = { ...savedConfig.rdLedger };
  config.debrid.rdGate = { ...savedConfig.rdGate };
}

function mockFetch(handler: (url: URL, init?: RequestInit) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    return handler(new URL(String(input)), init);
  }) as unknown as typeof globalThis.fetch;
  return {
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

function jsonOk(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function mockProbeOk() {
  let addCalls = 0;
  return mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet' && init?.method === 'POST') {
      addCalls += 1;
      return jsonOk({ id: `T${addCalls}` });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/info/')) {
      return jsonOk({ id: 'T1', status: 'downloaded', files: [] });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/delete/')) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    }
    return jsonOk({}, 404);
  });
}

test.beforeEach(() => {
  restoreConfig();
  cache.clearNamespace('rdc');
  cache.clearNamespace('rdq');
  metrics.reset();
  rdLedger.reset();
  rdGate.reset();
  rdWarmer.reset();

  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = 'test-api-key';
  config.debrid.allowEnvKey = true;
  config.debrid.rdWarm.enabled = true;
  config.debrid.rdWarm.idleWindowMs = 0;
  config.debrid.rdWarm.batch = 10;
  config.debrid.rdWarm.maxPerHour = 300;
  config.debrid.rdLedger.enabled = true;
  config.debrid.rdGate.minGapMs = 0;
  config.debrid.rdGate.cooldownMs = 0;
});

test.afterEach(() => {
  restoreConfig();
  rdGate.reset();
});

test('rd-warmer: balde horário conta, persiste e sobrevive a clear do Map', async () => {
  const mock = mockProbeOk();
  try {
    rdWarmer.enqueue([H1, H2], 10);
    const res = await rdWarmer.drain(2);
    assert.equal(res.processed, 2);
    assert.equal(rdWarmer.status().processedLastHour, 2);

    const stored = cache.get(HOUR_KEY);
    assert.ok(stored && typeof stored === 'object');
    assert.equal(Number((stored as any).count), 2);
    assert.equal(Number((stored as any).hour), Math.floor(Date.now() / 3_600_000));

    // Simula restart: reset limpa Map+chave; recolocamos só o balde (L2 intacto).
    rdWarmer.reset();
    cache.set(HOUR_KEY, stored, 3600);
    assert.equal(rdWarmer.status().processedLastHour, 2, 'Map vazio reidrata do cache');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: reset limpa persistência do balde horário', async () => {
  const mock = mockProbeOk();
  try {
    rdWarmer.enqueue([H1], 10);
    await rdWarmer.drain(1);
    assert.equal(rdWarmer.status().processedLastHour, 1);
    assert.ok(cache.get(HOUR_KEY), 'balde gravado no cache');

    rdWarmer.reset();
    assert.equal(cache.get(HOUR_KEY), null, 'reset esquece a chave horária');
    assert.equal(rdWarmer.status().processedLastHour, 0, 'Map e cache zerados');
  } finally {
    mock.restore();
  }
});
