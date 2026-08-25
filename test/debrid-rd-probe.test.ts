import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realdebrid from '../src/debrid/realdebrid.js';
import { selectProbeCandidates } from '../src/providers/rd-probe.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);

function mockFetch(handler: (url: URL, init?: RequestInit) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const urls: { path: string; method: string }[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push({ path: url.pathname, method: String(init?.method || 'GET').toUpperCase() });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    urls,
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

test('probeInstant: downloaded imediato → instant e DELETE', async () => {
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet' && init?.method === 'POST') {
      return jsonOk({ id: 'TORR1', uri: 'magnet:...' });
    }
    if (url.pathname === '/rest/1.0/torrents/info/TORR1') {
      return jsonOk({
        id: 'TORR1',
        status: 'downloaded',
        filename: 'Filme 2026.mkv',
        bytes: 1000,
        files: [{ id: 1, path: '/Filme.mkv', bytes: 1000, selected: 1 }],
        links: ['https://rd.example/file'],
      });
    }
    if (url.pathname === '/rest/1.0/torrents/delete/TORR1') {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    }
    return jsonOk({}, 404);
  });
  try {
    const result = await realdebrid.probeInstant('chave', H1);
    assert.equal(result.instant, true);
    assert.equal(result.reason, 'ready');
    const methods = mock.urls.map((u) => `${u.method} ${u.path}`);
    assert.ok(methods.includes('POST /rest/1.0/torrents/addMagnet'));
    assert.ok(methods.includes('GET /rest/1.0/torrents/info/TORR1'));
    assert.ok(methods.includes('DELETE /rest/1.0/torrents/delete/TORR1'), 'tem que apagar a sonda');
  } finally {
    mock.restore();
  }
});

test('probeInstant: downloading → miss e DELETE, sem instant', async () => {
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet') {
      return jsonOk({ id: 'TORR2' });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/info/')) {
      return jsonOk({
        id: 'TORR2',
        status: 'downloading',
        filename: 'Baixando.mkv',
        bytes: 0,
        files: [],
        links: [],
      });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/delete/')) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    }
    return jsonOk({}, 404);
  });
  try {
    const result = await realdebrid.probeInstant('chave', H2);
    assert.equal(result.instant, false);
    assert.equal(result.reason, 'pending');
    assert.ok(mock.urls.some((u) => u.method === 'DELETE'), 'miss também apaga');
  } finally {
    mock.restore();
  }
});

test('probeInstant: 451 → blocked', async () => {
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet') {
      return {
        ok: false,
        status: 451,
        async text() { return '{"error":"infringing_file","error_code":35}'; },
        async json() { return { error: 'infringing_file', error_code: 35 }; },
      };
    }
    return jsonOk({}, 404);
  });
  try {
    const result = await realdebrid.probeInstant('chave', H3);
    assert.equal(result.instant, false);
    assert.equal(result.reason, 'blocked');
    assert.ok(!mock.urls.some((u) => u.method === 'DELETE'), '451 sem id: nada a apagar');
  } finally {
    mock.restore();
  }
});

test('activeTorrentCount lê GET /torrents/activeCount', async () => {
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents/activeCount') {
      return jsonOk({ nb: 2, limit: 6 });
    }
    return jsonOk({}, 404);
  });
  try {
    const count = await realdebrid.activeTorrentCount('chave');
    assert.deepEqual(count, { nb: 2, limit: 6 });
    assert.equal(mock.urls[0].path, '/rest/1.0/torrents/activeCount');
  } finally {
    mock.restore();
  }
});

test('selectProbeCandidates prioriza BR dublado e pula já cacheado', () => {
  const streams: any[] = [
    { infoHash: H1, name: 'Global\n👤 99', _seeders: 99, _dubbed: false, _br: false },
    { infoHash: H2, name: 'BR DUB\n👤 1', _seeders: 1, _dubbed: true, _br: true },
    { infoHash: H3, name: 'Já ⚡\n👤 50', _seeders: 50, _dubbed: true, _br: true },
  ];
  const cached = new Set([H3]);
  const picked = selectProbeCandidates(streams, cached, 'acct', 2, 'chave');
  assert.equal(picked[0], H2, 'BR dublado primeiro');
  assert.ok(!picked.includes(H3), 'já em cached não entra');
});
