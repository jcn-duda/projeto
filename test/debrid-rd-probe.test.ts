import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realdebrid from '../src/debrid/realdebrid.js';
import { selectProbeCandidates, promoteCachedBolts, hashFromResolveUrl, promoteCachedBoltsAcrossStreams } from '../src/providers/rd-probe.js';
import { rdGate } from '../src/debrid/rd-gate.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import config from '../src/config.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);

// As sondas unitárias não compartilham admissão; o contrato de fila é exercido
// em debrid-rd-gate.test.ts. Reset evita carregar o gap do cenário anterior.
test.beforeEach(() => rdGate.reset());
test.afterEach(() => rdGate.reset());

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

test('selectProbeCandidates oversample: hold nos top BR nao zera a sonda', async () => {
  const held = await import('../src/debrid/protected.js');
  const extras = Array.from({ length: 6 }, (_, i) => {
    const h = `${i.toString(16).padStart(2, '0')}`.repeat(20);
    return { infoHash: h, name: `BR DUB ${i}\n👤 ${10 - i}`, _seeders: 10 - i, _dubbed: true, _br: true };
  });
  // Segura os 2 melhores — a sonda tem que pegar os seguintes.
  held.hold(extras[0].infoHash, 60, 'acct');
  held.hold(extras[1].infoHash, 60, 'acct');
  try {
    const picked = selectProbeCandidates(extras as any, new Set(), 'acct', 2, 'chave');
    assert.equal(picked.length, 2);
    assert.ok(!picked.includes(extras[0].infoHash));
    assert.ok(!picked.includes(extras[1].infoHash));
    assert.equal(picked[0], extras[2].infoHash);
  } finally {
    held.release(extras[0].infoHash, 'acct');
    held.release(extras[1].infoHash, 'acct');
  }
});

test('sonda pending/error não grava miss no ledger, apenas em memória', async () => {
  cache.clearNamespace('rdc');
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet') {
      return jsonOk({ id: 'TORR_PEND' });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/info/')) {
      return jsonOk({ id: 'TORR_PEND', status: 'downloading', filename: 'Baixando.mkv', bytes: 0, files: [] });
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
    // Ledger NÃO deve ser marcado com miss por sonda pendente
    assert.equal(rdLedger.peek(H2), 'unknown', 'pending da sonda não é miss autoritativo no ledger');
  } finally {
    mock.restore();
  }
});

test('hashFromResolveUrl extrai o infoHash da rota /resolve', () => {
  assert.equal(hashFromResolveUrl('http://127.0.0.1:7000/cfg/resolve/abcdef0123456789abcdef0123456789abcdef01?w=1'), 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(hashFromResolveUrl('/prefix/resolve/ABCDEF0123456789ABCDEF0123456789ABCDEF01'), 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(hashFromResolveUrl('http://invalido/sem-hash'), null);
});

test('promoteCachedBolts reescreve apenas o stream do hash informado', () => {
  const key = 'streams:v7:movie:ttProbePromote';
  cache.set(key, {
    streams: [
      { name: '[RD download] 1080p', url: `http://localhost:7000/resolve/${H1}?sig=1` },
      { name: '[RD download] 720p', url: `http://localhost:7000/resolve/${H2}?sig=2` },
    ],
    partial: false,
    debridKnown: true,
  }, 600);

  try {
    const promoted = promoteCachedBolts(key, [H1]);
    assert.equal(promoted, 1);
    const entry = cache.get(key) as any;
    assert.equal(entry.streams[0].name, '[RD⚡] 1080p');
    assert.equal(entry.streams[1].name, '[RD download] 720p');
  } finally {
    cache.forget(key);
  }
});

test('promoteCachedBolts sem match não conta cache.hit.streams nem reescreve', () => {
  const key = 'streams:v7:movie:ttNoMatch';
  cache.set(key, {
    streams: [{ name: '[RD download] 1080p', url: `http://localhost:7000/resolve/${H1}?sig=1` }],
    partial: false,
    debridKnown: true,
  }, 600);
  metrics.reset();
  try {
    // H2 não está na lista: a varredura volta 0 sem tocar em nada.
    const promoted = promoteCachedBolts(key, [H2]);
    assert.equal(promoted, 0);
    const counters = metrics.snapshot().counters;
    assert.equal(counters['cache.hit.streams'], undefined, 'a leitura via peek não conta hit do balde streams');
    assert.equal(counters['cache.hit'], undefined, 'nem o contador global de hit');
    assert.equal(counters['cache.miss.streams'], undefined, 'nem miss — não existe leitura de rede/ausente aqui');
    const entry = cache.peek(key) as any;
    assert.equal(entry.streams[0].name, '[RD download] 1080p', 'sem match não reescreve nenhum stream');
  } finally {
    metrics.reset();
    cache.forget(key);
  }
});

test('promoteCachedBolts preserva (não reseta) o TTL restante na promoção', async () => {
  const key = 'streams:v7:movie:ttPreservaTtl';
  // TTL curto de propósito: muito menor que o config.cacheTtl — se a promoção
  // resetasse para o default, o `after` estouraria e o teste pegaria.
  cache.set(key, {
    streams: [{ name: '[RD download] 1080p', url: `http://localhost:7000/resolve/${H1}?sig=1` }],
    partial: false,
    debridKnown: true,
  }, 10);
  await new Promise((r) => setTimeout(r, 1100));
  try {
    const before = cache.peekRemaining(key);
    assert.ok(before != null && before > 0, `restante antes da promoção: ${before}`);
    const promoted = promoteCachedBolts(key, [H1]);
    assert.equal(promoted, 1);
    const entry = cache.peek(key) as any;
    assert.equal(entry.streams[0].name, '[RD⚡] 1080p');
    const after = cache.peekRemaining(key);
    assert.ok(after != null && after > 0, `restante após promover: ${after}`);
    assert.ok(
      after < config.cacheTtl,
      `TTL herdado do restante (${after}s), não resetado para o default (${config.cacheTtl}s)`,
    );
    assert.ok(after < 10, `não renovou para o TTL original: ${after} < 10 (perdeu ~1s do sleep)`);
  } finally {
    cache.forget(key);
  }
});

test('promoteCachedBoltsAcrossStreams itera todas as chaves de stream ativas', () => {
  const k1 = 'streams:v7:movie:ttAcross1';
  const k2 = 'streams:v7:movie:ttAcross2';
  cache.set(k1, {
    streams: [{ name: '[RD download] 1080p', url: `http://localhost:7000/resolve/${H3}?sig=1` }],
    partial: false,
    debridKnown: true,
  }, 600);
  cache.set(k2, {
    streams: [{ name: '[RD download] 720p', url: `http://localhost:7000/resolve/${H3}?sig=2` }],
    partial: false,
    debridKnown: true,
  }, 600);

  try {
    const total = promoteCachedBoltsAcrossStreams([H3]);
    assert.equal(total, 2);
    const e1 = cache.get(k1) as any;
    const e2 = cache.get(k2) as any;
    assert.equal(e1.streams[0].name, '[RD⚡] 1080p');
    assert.equal(e2.streams[0].name, '[RD⚡] 720p');
  } finally {
    cache.forget(k1);
    cache.forget(k2);
  }
});
