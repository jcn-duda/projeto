// Ponte de LEITURA do painel: `fetchNativeStreamsStats()` (C4, commit 2).
//
// Prova (a) a URL/header da admin 8711, (b) a validação campo a campo do
// shape, (c) o fail-open (404/500/timeout/corpo estranho → null) e (d) a
// regressão-chave do corte: a falha de stats NÃO alimenta o backoff de
// `streams-store-native.ts` — a invalidação por obra continua disponível
// depois de quantas falhas a leitura sofrer.
//
// Sem rede: o dublê de fetch responde a rota; o `beforeEach` aponta a URL para
// a admin de verdade (o `setup-env` pina uma porta fechada para o resto da
// suíte) e zera o estado da ponte de escrita.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import { fetchNativeStreamsStats } from '../src/utils/streams-stats-native.js';
import {
  flushNativeStreamStores,
  invalidateNativeStreamsForObra,
  nativeStreamStoreStatus,
  resetNativeStreamStore,
} from '../src/utils/streams-store-native.js';
import { stubFetch } from './helpers/stub.js';

const URL_BASE = 'http://127.0.0.1:8711';
/** Token de DIAGNÓSTICO (`JACKETT_TEST_TOKEN`): abre a superfície de leitura. */
const TOKEN = 'token-stats';
const SHAPE_COMPLETO = {
  ok: true,
  entries: 12,
  quota: 5000,
  hit: 40,
  staleServed: 3,
  miss: 9,
  writes: 77,
  hitRate: 0.816,
  degraded: false,
  staleGraceSeconds: 900,
};

let savedConfig: typeof config.streamStore;
let savedToken: string;

beforeEach(() => {
  savedConfig = { ...config.streamStore };
  savedToken = config.jackett.testToken;
  config.streamStore.url = URL_BASE;
  // Sem token próprio: a ponte cai para o token de diagnóstico, como na VPS.
  config.streamStore.token = '';
  config.streamStore.timeoutMs = 500;
  config.jackett.testToken = TOKEN;
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

test('GET /streams/stats na admin 8711 com o token da superfície', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ...SHAPE_COMPLETO }) }));
  try {
    const stats = await fetchNativeStreamsStats();
    assert.ok(stats, 'shape válido não vira null');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${URL_BASE}/streams/stats`);
    // Sem token próprio, o de diagnóstico abre a leitura (mesma precedência
    // das outras rotas de superfície da admin).
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), TOKEN);

    // O token próprio vence quando configurado.
    config.streamStore.token = 'tok-proprio';
    await fetchNativeStreamsStats();
    assert.equal(headerOf(stub.calls[1], 'x-indexer-test-token'), 'tok-proprio');
  } finally {
    stub.restore();
  }
});

test('shape completo → objeto com os números medidos (e só eles)', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ...SHAPE_COMPLETO }) }));
  try {
    assert.deepEqual(await fetchNativeStreamsStats(), {
      entries: 12,
      quota: 5000,
      hit: 40,
      staleServed: 3,
      miss: 9,
      writes: 77,
      hitRate: 0.816,
      degraded: false,
      staleGraceSeconds: 900,
    });
  } finally {
    stub.restore();
  }
});

test('gateway velho (shape parcial): campo ausente fica ausente, nunca 0', async () => {
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, entries: 3, quota: 5000 }),
  }));
  try {
    const stats = await fetchNativeStreamsStats();
    assert.ok(stats);
    assert.equal(stats.entries, 3);
    assert.equal(stats.quota, 5000);
    assert.equal('hit' in stats, false, 'sem o campo, não há campo');
    assert.equal('staleServed' in stats, false);
    assert.equal('hitRate' in stats, false);
  } finally {
    stub.restore();
  }
});

test('hitRate null do gateway é RESPOSTA (sem consulta) e viaja como null', async () => {
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, entries: 1, hitRate: null }),
  }));
  try {
    const stats = await fetchNativeStreamsStats();
    assert.ok(stats);
    assert.equal(stats.hitRate, null);
  } finally {
    stub.restore();
  }
});

test('404/500/timeout/corpo estranho → null, com bridge_errors contado', async () => {
  const antes = metrics.snapshot().counters['stream.stats.bridge_errors'] || 0;

  // 404: gateway velho sem a rota estendida.
  const notFound = stubFetch(() => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }));
  try {
    assert.equal(await fetchNativeStreamsStats(), null);
  } finally { notFound.restore(); }

  // 500: gateway doente.
  const serverError = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    assert.equal(await fetchNativeStreamsStats(), null);
  } finally { serverError.restore(); }

  // Timeout: o fetch aborta (o mesmo caminho do prazo estourado).
  const timeout = stubFetch(() => {
    throw new Error('The operation was aborted');
  });
  try {
    assert.equal(await fetchNativeStreamsStats(), null);
  } finally { timeout.restore(); }

  // Corpo estranho: não-objeto, array e ok:false — cada um por vez.
  const corpos = ['não sou json de stats', [{ ok: true }], { ok: false, error: 'x' }];
  const estranho = stubFetch(() => ({ ok: true, status: 200, json: async () => corpos.shift() }));
  try {
    assert.equal(await fetchNativeStreamsStats(), null);
    assert.equal(await fetchNativeStreamsStats(), null);
    assert.equal(await fetchNativeStreamsStats(), null);
  } finally { estranho.restore(); }

  const depois = metrics.snapshot().counters['stream.stats.bridge_errors'] || 0;
  assert.ok(depois - antes >= 6, `cada falha da ponte conta bridge_errors (delta ${depois - antes})`);
});

// REGRESSÃO-CHAVE: a leitura de stats é stateless — a falha dela não pode
// congelar a invalidação por obra (o backoff é do módulo de ESCRITA e nasce
// apenas das falhas DELE).
test('falha de stats não alimenta o backoff da invalidação por obra', async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith('/streams/stats')) throw new Error('conexão recusada');
    // A rota de invalidação responde de verdade.
    return { ok: true, status: 200, json: async () => ({ ok: true, removed: 1 }) };
  });
  try {
    // Mais falhas do que o gatilho do backoff da ponte de escrita (2 seguidas):
    // se a ponte compartilhasse estado, o invalidate abaixo nem tentaria.
    await fetchNativeStreamsStats();
    await fetchNativeStreamsStats();
    await fetchNativeStreamsStats();
    assert.equal(nativeStreamStoreStatus().available, true, 'stats falhos não colocam a ponte em backoff');
    assert.equal(nativeStreamStoreStatus().failures, 0, 'a falha de stats não é falha da ponte de escrita');

    // E a invalidação por obra continua FUNCIONANDO de fato.
    assert.equal(invalidateNativeStreamsForObra('tt123'), true, 'o pedido foi enfileirado');
    await flushNativeStreamStores();
    const invalidate = stub.calls.filter((call) => call.url.endsWith('/streams/invalidate'));
    assert.equal(invalidate.length, 1, 'a invalidação alcançou o store nativo');
    assert.equal(nativeStreamStoreStatus().available, true);
  } finally {
    stub.restore();
  }
});
