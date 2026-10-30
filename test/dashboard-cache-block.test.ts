// Bloco `cache` do /dashboard-status.json com a foto NATIVA do `streams.db`
// (C4, commit 3).
//
// Com o stub da admin 8711 respondendo `GET /streams/stats`, o bloco ganha
// `native: {source:'gateway', …}`; com o gateway fora/sem a rota, `native` é
// OMITIDO (ausente ≠ zero) e o L1 local fica intacto. L1 e foto nativa saem no
// MESMO payload — o painel distingue os dois por `source` e pelos rótulos.
//
// Sem rede externa: o app de teste é servido por `createTestServer` e a ponte
// de leitura é capturada pelo dublê de fetch apontando para a 8711 de verdade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { stubFetch } from './helpers/stub.js';

const URL_BASE = 'http://127.0.0.1:8711';
const TOKEN = 'tok-cache-block';

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.streamStore = { ...config.streamStore };
  config.jackett.testToken = TOKEN;
  // Sem token próprio: a leitura cai para o token de diagnóstico, como na VPS.
  config.streamStore.url = URL_BASE;
  config.streamStore.token = '';
  config.streamStore.timeoutMs = 500;
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
  config.streamStore = saved.streamStore;
});

function get(query: string) {
  return server.request('GET', `/dashboard-status.json${query}`, {
    headers: { 'X-Indexer-Test-Token': TOKEN },
  });
}

test('gateway vivo: bloco cache com L1 local intacto E `native` do streams.db', async () => {
  const stub = stubFetch((url, options) => {
    assert.match(url, /\/streams\/stats$/, 'a leitura é a rota de stats da admin');
    assert.equal(
      (options?.headers as Record<string, string>)?.['x-indexer-test-token'],
      TOKEN,
      'o header da superfície sai com o token de diagnóstico',
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({
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
      }),
    };
  });
  try {
    const res = await get('?blocos=cache');
    assert.equal(res.status, 200);
    const cache = res.json.cache;
    // Contrato antigo do L1 local, intacto.
    assert.equal(typeof cache.entries, 'number');
    assert.equal(typeof cache.maxEntries, 'number');
    assert.equal(typeof cache.namespaces, 'object');
    assert.equal(typeof cache.persistent, 'boolean');
    assert.ok('l2' in cache, 'a foto do L2 local continua no bloco');
    assert.equal(typeof cache.hits, 'number');
    assert.equal(typeof cache.misses, 'number');
    // Foto nativa: os números medidos, `staleGraceSeconds` fora do contrato do
    // painel e o `ok` de transporte não repassado.
    assert.deepEqual(cache.native, {
      source: 'gateway',
      entries: 12,
      quota: 5000,
      hit: 40,
      staleServed: 3,
      miss: 9,
      writes: 77,
      hitRate: 0.816,
      degraded: false,
    });
  } finally {
    stub.restore();
  }
});

test('gateway sem a rota (404): `native` AUSENTE e o L1 local intacto', async () => {
  const stub = stubFetch(() => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }));
  try {
    const res = await get('?blocos=cache');
    assert.equal(res.status, 200, 'fail-open: o painel não morre com a ponte fora');
    assert.equal('native' in res.json.cache, false, 'sem fonte: `native` ausente, nunca zero');
    assert.equal(typeof res.json.cache.entries, 'number', 'o L1 local segue no payload');
    assert.equal(typeof res.json.cache.maxEntries, 'number');
  } finally {
    stub.restore();
  }
});

test('gateway velho (shape parcial): só os campos medidos entram em `native`', async () => {
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, entries: 3, quota: 5000 }),
  }));
  try {
    const res = await get('?blocos=cache');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.cache.native, {
      source: 'gateway',
      entries: 3,
      quota: 5000,
    }, 'campo que o gateway não mandou não vira 0');
  } finally {
    stub.restore();
  }
});

test('hitRate null do gateway (sem consulta) viaja como null, não como 0', async () => {
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, entries: 1, quota: 5000, hitRate: null }),
  }));
  try {
    const res = await get('?blocos=cache');
    assert.equal(res.status, 200);
    assert.equal(res.json.cache.native.hitRate, null);
  } finally {
    stub.restore();
  }
});
