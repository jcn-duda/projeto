import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import { rdGate } from '../src/debrid/rd-gate.js';
import * as activity from '../src/providers/activity.js';
import rdWarmer from '../src/providers/rd-warmer.js';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);
const H5 = '5'.repeat(40);

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
  const calls: { url: URL; method: string }[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: String(init?.method || 'GET').toUpperCase() });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
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

test.beforeEach(() => {
  restoreConfig();
  cache.clearNamespace('rdc');
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

test('rd-warmer: fila sobrevive ao "restart" (recarrega da chave)', () => {
  rdWarmer.enqueue([H1], 10);
  rdWarmer.enqueue([H2], 50);
  rdWarmer.enqueue([H3], 30);

  let st = rdWarmer.status();
  assert.equal(st.queueDepth, 3);

  // Simula restart do processo limpando a memória interna do warmer
  rdWarmer.reset();

  // Ao consultar status ou enfileirar algo, a fila é recarregada do cache
  st = rdWarmer.status();
  assert.equal(st.queueDepth, 3, 'fila foi restaurada da chave do cache');

  // Enfileira mais um hash para verificar que a ordenação e a persistência continuam
  rdWarmer.enqueue([H4], 40);
  assert.equal(rdWarmer.status().queueDepth, 4);
});

test('rd-warmer: tráfego recente pula o tick', async () => {
  config.debrid.rdWarm.idleWindowMs = 60_000;
  activity.noteUserRequest();

  const mock = mockFetch(() => jsonOk({ id: 'T1' }));
  try {
    rdWarmer.enqueue([H1], 100);
    await rdWarmer.tick();

    assert.equal(mock.calls.length, 0, 'não executou chamadas de rede com tráfego recente');
    assert.equal(rdWarmer.status().queueDepth, 1, 'item permaneceu na fila');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: 429 devolve hash à fila', async () => {
  rdWarmer.enqueue([H1], 100);
  rdWarmer.enqueue([H2], 50);

  const mock = mockFetch(() => jsonOk({ error: 'too_many_requests' }, 429));
  try {
    await rdWarmer.tick();

    const st = rdWarmer.status();
    assert.equal(st.queueDepth, 2, 'hash devolvido à frente da fila no 429');
    const counters = metrics.snapshot().counters as Record<string, number>;
    assert.equal(counters['debrid.rd.warm.requeued'], 1);
  } finally {
    mock.restore();
  }
});

test('rd-warmer: hash já conhecido pelo ledger nunca vira chamada', async () => {
  rdLedger.noteHit([H1]);
  rdLedger.noteBlocked(H2);
  rdLedger.noteMiss(H3);

  const probedHashes: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet' && init?.method === 'POST') {
      const decodedBody = decodeURIComponent(String(init.body || ''));
      const m = decodedBody.match(/([a-fA-F0-9]{40})/);
      if (m) probedHashes.push(m[1].toLowerCase());
      return jsonOk({ id: 'T1' });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/info/')) {
      return jsonOk({ id: 'T1', status: 'downloaded', files: [] });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/delete/')) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    }
    return jsonOk({}, 404);
  });

  try {
    // H1 (hit), H2 (blocked) nem chegam a ser inseridos no enqueue se já conhecidos; H3 (miss) é pulado no tick
    rdWarmer.enqueue([H1, H2, H3, H4], 10);

    await rdWarmer.tick();

    assert.deepEqual(probedHashes, [H4], 'apenas hash desconhecido virou chamada');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: enqueue deduplica', () => {
  rdWarmer.enqueue([H1], 10);
  rdWarmer.enqueue([H1], 50); // atualiza score
  rdWarmer.enqueue([H2, H2], 20); // deduplica no mesmo array

  const st = rdWarmer.status();
  assert.equal(st.queueDepth, 2, 'apenas 2 hashes únicos na fila');
});

test('rd-warmer: drain processa e devolve contagem', async () => {
  rdWarmer.enqueue([H1, H2, H3, H4, H5], 10);

  let addCalls = 0;
  const mock = mockFetch((url, init) => {
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

  try {
    const res = await rdWarmer.drain(3);

    assert.equal(res.processed, 3, 'processou exatamente 3 itens');
    assert.equal(res.queueRemaining, 2, 'restam 2 itens na fila');
    assert.equal(addCalls, 3, 'foram feitas 3 chamadas');
    assert.equal(rdWarmer.status().queueDepth, 2);
  } finally {
    mock.restore();
  }
});
