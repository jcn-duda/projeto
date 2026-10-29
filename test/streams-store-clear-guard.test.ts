// Guarda das rotas DESTRUTIVAS da ponte Node → store nativo (F4.4a).
//
// O gateway passou a exigir duas coisas em `POST /streams/clear` (o namespace de
// listas inteiro): a credencial DESTRUTIVA (`STREAM_STORE_ADMIN_TOKEN` →
// `DEBRID_INTERNAL_TOKEN`, nunca o `JACKETT_TEST_TOKEN` de diagnóstico) e
// `{"confirm":true}`. `POST /streams/invalidate` (obra/hash — o reparo do
// caminho quente do `/resolve`) continua só com o token da superfície.
//
// Estes testes provam o LADO NODE do contrato: com que credencial a ponte fala
// em cada rota, o que ela manda no corpo e o que faz quando o gateway recusa.
// Os testes básicos da ponte (trace, backoff de transporte, painel) ficam em
// `streams-store-native.test.ts`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import { applyCacheEffect } from '../src/debrid/rust-resolve-cache.js';
import {
  clearNativeStreams,
  flushNativeStreamStores,
  invalidateNativeStreamsForObra,
  nativeStreamStoreStatus,
  resetNativeStreamStore,
} from '../src/utils/streams-store-native.js';
import { fakeResponse } from './e2e/e2e-harness.js';
import { stubFetch } from './helpers/stub.js';

const URL_BASE = 'http://127.0.0.1:8711';
/** Token de DIAGNÓSTICO (`JACKETT_TEST_TOKEN`): abre a superfície, não apaga. */
const DIAGNOSTIC = 'token-de-diagnostico';
/** Credencial DESTRUTIVA (`STREAM_STORE_ADMIN_TOKEN`): a única que apaga. */
const DESTRUCTIVE = 'token-destrutivo';

type Saved = typeof config.streamStore;

let savedConfig: Saved;
let savedToken: string;

beforeEach(() => {
  savedConfig = { ...config.streamStore };
  savedToken = config.jackett.testToken;
  config.streamStore.url = URL_BASE;
  config.streamStore.token = DESTRUCTIVE;
  config.streamStore.timeoutMs = 500;
  config.streamStore.backoffMs = 30_000;
  config.jackett.testToken = DIAGNOSTIC;
  resetNativeStreamStore();
});

afterEach(() => {
  config.streamStore = savedConfig;
  config.jackett.testToken = savedToken;
  resetNativeStreamStore();
});

function headerOf(call: { options?: any }, name: string): string | undefined {
  const headers = call.options?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

test('clear global manda confirm + credencial destrutiva (nunca a de diagnóstico)', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, removed: 7, entries: 0 }));
  try {
    const result = await clearNativeStreams();
    assert.deepEqual(result, { attempted: true, ok: true, removed: 7 });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${URL_BASE}/streams/clear`);
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), DESTRUCTIVE);
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { confirm: true });
  } finally {
    stub.restore();
  }
});

test('clear por instalação manda confirm e o sufixo do segmento', async () => {
  const stub = stubFetch(() => fakeResponse({ ok: true, removed: 3, entries: 9 }));
  try {
    const suffix = ':{"m":2}:account:abc';
    const result = await clearNativeStreams({ suffix });
    assert.deepEqual(result, { attempted: true, ok: true, removed: 3 });
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), DESTRUCTIVE);
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { confirm: true, suffix });
  } finally {
    stub.restore();
  }
});

test('sem credencial destrutiva o clear nem chama a rota e não entra em backoff', async () => {
  config.streamStore.token = '';
  const stub = stubFetch(() => fakeResponse({ ok: true, removed: 1, entries: 0 }));
  try {
    const result = await clearNativeStreams();
    assert.equal(result.attempted, false, 'sem credencial nem tenta (o gateway responderia 409)');
    assert.equal(result.ok, false);
    assert.match(String(result.error), /sem credencial destrutiva/);
    assert.equal(stub.calls.length, 0);
    // Recusa de configuração não é falha de transporte: a ponte segue viva e a
    // invalidação por obra do `/resolve` continua passando (com o diagnóstico).
    assert.equal(nativeStreamStoreStatus().available, true);
    assert.equal(invalidateNativeStreamsForObra('tt123'), true);
    await flushNativeStreamStores();
    assert.equal(stub.calls.length, 1);
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), DIAGNOSTIC);
  } finally {
    stub.restore();
  }
});

test('recusa 403/409 do gateway não entra no backoff e vira motivo legível', async () => {
  const stub = stubFetch(() =>
    fakeResponse({ ok: false, error: 'confirmation_required' }, { status: 409 }),
  );
  try {
    const result = await clearNativeStreams();
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /409/);
    assert.match(String(result.error), /confirmation_required/);
    assert.equal(nativeStreamStoreStatus().available, true, 'recusa não é queda do gateway');
    // A ponte continua tentando (não ficou bloqueada pelo backoff de 30 s).
    const segunda = await clearNativeStreams();
    assert.equal(segunda.attempted, true);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('invalidate (obra) usa o token da superfície e não manda confirm', async () => {
  config.streamStore.token = '';
  const stub = stubFetch(() => fakeResponse({ ok: true, scope: 'obra', removed: 1 }));
  try {
    assert.equal(invalidateNativeStreamsForObra('tt123'), true);
    await flushNativeStreamStores();
    assert.equal(stub.calls.length, 1, 'o caminho quente não depende do destrutivo');
    assert.equal(new URL(stub.calls[0].url).pathname, '/streams/invalidate');
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), DIAGNOSTIC);
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { imdbId: 'tt123' });
  } finally {
    stub.restore();
  }
});

// Chamador REAL do caminho quente: o efeito `invalidate:'streams'` do `/resolve`
// (451/bloqueio legal) limpa o nativo. Com a guarda nova ele só continua
// funcionando porque a ponte manda `confirm` + a credencial destrutiva — esta é
// a prova de que o play não quebrou.
test('play 451: o efeito de cache limpa o nativo com confirm e credencial destrutiva', async () => {
  const savedCooldown = config.debrid.resolveBlockedInvalidateCooldownMs;
  config.debrid.resolveBlockedInvalidateCooldownMs = 1;
  const stub = stubFetch(() => fakeResponse({ ok: true, removed: 5, entries: 0 }));
  try {
    const cleared = applyCacheEffect({ invalidate: 'streams' }, 'tt451', {
      cache: { clearNamespace: () => 0 },
      metrics: { count: () => {} },
      log: { info: () => {}, warn: () => {} },
    });
    assert.equal(cleared, 0, 'o L1 do Node não conta mais como limpeza');
    await flushNativeStreamStores();
    assert.equal(stub.calls.length, 1);
    assert.equal(new URL(stub.calls[0].url).pathname, '/streams/clear');
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), DESTRUCTIVE);
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { confirm: true });
  } finally {
    config.debrid.resolveBlockedInvalidateCooldownMs = savedCooldown;
    stub.restore();
  }
});
