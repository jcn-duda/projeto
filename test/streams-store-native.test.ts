// Ponte Node → store NATIVO `streams.db` (F4.4a).
//
// O SWR do corte é do gateway Rust: estes testes provam que o Node (a) invalida
// por obra no store nativo quando o play falha, (b) limpa tudo/só a instalação
// no `clear-cache`, (c) lê o ledger nativo no `/stream-trace.json` e (d) não
// deixa de fazer o caminho antigo quando a ponte está desligada ou fora do ar.
//
// A suíte pina `STREAM_STORE_RUST=off` no `setup-env` (hermetismo): quem liga a
// ponte é o `beforeEach` local, com a URL apontada para o dublê de fetch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { invalidateStreamsForObra } from '../src/utils/br-gap.js';
import {
  clearNativeStreams,
  fetchNativeStreamTrace,
  flushNativeStreamStores,
  invalidateNativeStreamsForObra,
  nativeStreamStoreStatus,
  resetNativeStreamStore,
} from '../src/utils/streams-store-native.js';
import { createTestServer, decodeConfig, encodeConfig, fakeResponse } from './e2e/e2e-harness.js';
import { stubFetch } from './helpers/stub.js';

const URL_BASE = 'http://127.0.0.1:8711';
const TOKEN = 'token-da-ponte';

type Saved = {
  rust: boolean;
  url: string;
  token: string;
  timeoutMs: number;
  backoffMs: number;
};

let savedConfig: Saved;
let savedToken: string;

beforeEach(() => {
  savedConfig = { ...config.streamStore };
  savedToken = config.jackett.testToken;
  config.streamStore.rust = true;
  config.streamStore.url = URL_BASE;
  config.streamStore.token = '';
  config.streamStore.timeoutMs = 500;
  config.streamStore.backoffMs = 30_000;
  config.jackett.testToken = TOKEN;
  resetNativeStreamStore();
  cache.clear();
});

afterEach(() => {
  cache.clear();
  config.streamStore = savedConfig;
  config.jackett.testToken = savedToken;
  resetNativeStreamStore();
});

function headerOf(call: { options?: any }, name: string): string | undefined {
  const headers = call.options?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

test('invalida a obra: POST /streams/invalidate com imdbId, token e flush', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, scope: 'obra', removed: 2 }));
  try {
    invalidateNativeStreamsForObra('TT123');
    await flushNativeStreamStores();
    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, `${URL_BASE}/streams/invalidate`);
    assert.equal(call.options?.method, 'POST');
    assert.equal(headerOf(call, 'x-indexer-test-token'), TOKEN);
    assert.deepEqual(JSON.parse(String(call.options?.body)), { imdbId: 'tt123' });
  } finally {
    stub.restore();
  }
});

test('imdbId fora do contrato ou hash curto não chamam a ponte', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true }));
  try {
    invalidateNativeStreamsForObra('');
    invalidateNativeStreamsForObra('tt12a');
    invalidateNativeStreamsForObra('tt123:1:2');
    await flushNativeStreamStores();
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('clear global manda corpo vazio e devolve a contagem do nativo', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, removed: 7, entries: 0 }));
  try {
    const result = await clearNativeStreams();
    assert.deepEqual(result, { attempted: true, ok: true, removed: 7 });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${URL_BASE}/streams/clear`);
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), {});
  } finally {
    stub.restore();
  }
});

test('clear com escopo de instalação manda o sufixo do segmento', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, removed: 3, entries: 9 }));
  try {
    const suffix = ':{"m":2}:account:abc';
    const result = await clearNativeStreams({ suffix });
    assert.deepEqual(result, { attempted: true, ok: true, removed: 3 });
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { suffix });
  } finally {
    stub.restore();
  }
});

test('ponte desligada não chama nada e o caminho antigo continua', async () => {
  config.streamStore.rust = false;
  const stub = stubFetch(() => fakeResponse({ ok: true }));
  try {
    const key = `${prefix('streams')}movie:tt123:{"m":2}:account:abc`;
    cache.set(key, { streams: [] }, 60);
    const cleared = invalidateStreamsForObra('tt123');
    assert.equal(cleared, 1, 'o L1 do Node continua sendo invalidado');
    assert.equal(cache.get(key), null);
    const result = await clearNativeStreams();
    assert.equal(result.attempted, false);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /STREAM_STORE_RUST=off/);
    assert.equal(await fetchNativeStreamTrace('movie', 'tt123'), null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('falha entra em backoff e não trava quem chamou', async () => {
  const stub = stubFetch(() => {
    throw new Error('conexão recusada');
  });
  try {
    const primeira = await clearNativeStreams();
    assert.equal(primeira.attempted, true);
    assert.equal(primeira.ok, false);
    assert.match(String(primeira.error), /conexão recusada/);

    const segunda = await clearNativeStreams();
    assert.equal(segunda.ok, false);
    assert.equal(nativeStreamStoreStatus().available, false);
    const chamadasAteAqui = stub.calls.length;

    // Em backoff, nem tenta (nem no clear nem na invalidação fire-and-forget).
    const terceira = await clearNativeStreams();
    assert.equal(terceira.attempted, false);
    invalidateNativeStreamsForObra('tt999');
    await flushNativeStreamStores();
    assert.equal(stub.calls.length, chamadasAteAqui, 'não martela a ponte em backoff');
  } finally {
    stub.restore();
  }
});

test('trace: lê o ledger nativo pela chave exata e devolve found', async () => {
  const stub = stubFetch(() =>
    fakeResponse({
      ok: true,
      found: true,
      source: 'rust',
      cache: { remainingS: 42, partial: false, debridKnown: true, stale: false },
      trace: { stages: { raw: 9, final: 2 }, items: [], startedAt: 1, finishedAt: 2 },
      streams: [{ name: '1080p', infoHash: 'a'.repeat(40) }],
    }),
  );
  try {
    const key = `${prefix('streams')}movie:tt9:{"m":2}:account:abc`;
    const trace = await fetchNativeStreamTrace('movie', 'tt9', key);
    assert.ok(trace);
    assert.equal(trace.found, true);
    assert.equal(trace.cache?.remainingS, 42);
    assert.equal(stub.calls.length, 1);
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/streams/trace');
    assert.equal(url.searchParams.get('type'), 'movie');
    assert.equal(url.searchParams.get('id'), 'tt9');
    assert.equal(url.searchParams.get('key'), key);
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), TOKEN);
  } finally {
    stub.restore();
  }
});

test('trace ausente (found:false) devolve o objeto sem inventar entrada', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, found: false, source: 'rust' }));
  try {
    const trace = await fetchNativeStreamTrace('series', 'tt9:1:2');
    assert.ok(trace);
    assert.equal(trace.found, false);
  } finally {
    stub.restore();
  }
});

test('painel: clear-cache global limpa o nativo e relata o que aconteceu', async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith('/streams/clear')) return fakeResponse({ ok: true, removed: 4, entries: 0 });
    return fakeResponse({ ok: true });
  });
  const server = await createTestServer();
  try {
    cache.set('raw:ponte-probe', { ok: 1 }, 60);
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.entriesAfter, 0);
    assert.deepEqual(res.json.native, { attempted: true, ok: true, removed: 4 });
    assert.equal(stub.calls.length, 1);
    assert.equal(new URL(stub.calls[0].url).pathname, '/streams/clear');
  } finally {
    await server.close();
    stub.restore();
  }
});

test('painel: clear-cache por instalação manda o sufixo dela ao nativo', async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith('/streams/clear')) return fakeResponse({ ok: true, removed: 1, entries: 0 });
    return fakeResponse({ ok: true });
  });
  const segment = encodeConfig({ m: 2, ds: 'sweepfake', dk: 'conta-a' });
  const opts = decodeConfig(segment);
  assert.ok(opts);
  const server = await createTestServer();
  try {
    const res = await server.request('POST', `/${segment}/dashboard-action.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true, scope: { installation: true } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.scope.kind, 'installation');
    const body = JSON.parse(String(stub.calls[0].options?.body)) as { suffix?: string };
    assert.ok(body.suffix, 'o escopo de instalação precisa mandar sufixo');
    assert.ok(body.suffix!.startsWith(':'), body.suffix);
    assert.ok(body.suffix!.includes(':account:'), body.suffix);
  } finally {
    await server.close();
    stub.restore();
  }
});

test('painel: namespace diferente de streams não toca o store nativo', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true }));
  const server = await createTestServer();
  try {
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true, scope: { namespace: 'raw' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.native.attempted, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    await server.close();
    stub.restore();
  }
});

test('/stream-trace.json cai no ledger NATIVO quando o L1 do Node está vazio', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/streams/trace')) {
      return fakeResponse({
        ok: true,
        found: true,
        source: 'rust',
        cache: { remainingS: 120, partial: false, debridKnown: true, stale: false },
        trace: { stages: { raw: 12, afterSort: 5, final: 3 }, items: [], startedAt: 10, finishedAt: 20 },
        searchMeta: { names: ['Filme Teste'], year: 2024 },
        streams: [],
      });
    }
    return fakeResponse({ ok: true });
  });
  const server = await createTestServer();
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt777', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.found, true);
    assert.equal(res.json.source, 'rust');
    assert.equal(res.json.origin, 'cached');
    assert.equal(res.json.cache.remainingS, 120);
    assert.equal(res.json.cache.debridKnown, true);
    assert.equal(res.json.trace.stages.final, 3);
    assert.equal(res.json.recompute, null);
    assert.equal(stub.calls.length, 1);
  } finally {
    await server.close();
    stub.restore();
  }
});

test('/stream-trace.json sem entrada em nenhum dos dois lados responde 404 found:false', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, found: false, source: 'rust' }));
  const server = await createTestServer();
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt778', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.found, false);
    assert.equal(stub.calls.length, 1, 'tentou a ponte antes de desistir');
  } finally {
    await server.close();
    stub.restore();
  }
});
