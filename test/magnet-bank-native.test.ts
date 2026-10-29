// Ponte do import do banco de magnets com a admin do gateway (`importNativeBank`).
// O import é nativo: a ponte só pede a mescla e repassa a resposta. Sem rede
// real; o `fetch` é o dublê de `withMockFetch`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { importNativeBank } from '../src/utils/magnet-bank-native.js';
import { withMockFetch } from './e2e/e2e-harness.js';

const SPOOL = '/tmp/adom-magnets-import-1-2.ndjson';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('magnet-bank-native: ponte do import com a admin', () => {
  const saved: Record<string, any> = {};
  before(() => {
    saved.url = config.streamStore.url;
    saved.token = config.streamStore.token;
    config.streamStore.url = 'http://127.0.0.1:8711';
  });
  after(() => {
    config.streamStore.url = saved.url;
    config.streamStore.token = saved.token;
  });

  test('sem credencial destrutiva devolve null sem abrir conexão', async () => {
    config.streamStore.token = '';
    let calls = -1;
    const result = await withMockFetch([
      { match: /./, handler: () => json(200, { ok: true }) },
    ], async (mock) => {
      const r = await importNativeBank(SPOOL);
      calls = mock.calls.length;
      return r;
    });
    assert.equal(result, null);
    assert.equal(calls, 0, 'sem token não há requisição nenhuma');
  });

  test('200 da admin é repassado com o status e o corpo; pedido leva token, caminho e confirm', async () => {
    config.streamStore.token = 'tok-destrutivo';
    const sent: { headers?: Record<string, string>; body?: Record<string, unknown>; url?: string } = {};
    const result = await withMockFetch([{
      match: /\/magnet-bank\/import$/,
      handler: (url: string, init?: RequestInit) => {
        sent.url = url;
        sent.headers = init?.headers as Record<string, string>;
        sent.body = JSON.parse(String(init?.body));
        return json(200, { ok: true, lines: 4, rejected: 0, magnets: { read: 3, inserted: 2, merged: 1 } });
      },
    }], () => importNativeBank(SPOOL));
    assert.deepEqual(result, {
      status: 200,
      body: { ok: true, lines: 4, rejected: 0, magnets: { read: 3, inserted: 2, merged: 1 } },
    });
    assert.equal(sent.url, 'http://127.0.0.1:8711/magnet-bank/import');
    assert.equal(sent.headers?.['x-indexer-test-token'], 'tok-destrutivo');
    assert.deepEqual(sent.body, { path: SPOOL, confirm: true });
  });

  test('recusa da admin (409) volta com o status e o motivo, sem virar null', async () => {
    config.streamStore.token = 'tok-destrutivo';
    const result = await withMockFetch([{
      match: /\/magnet-bank\/import$/,
      handler: () => json(409, { ok: false, error: 'busy' }),
    }], () => importNativeBank(SPOOL));
    assert.deepEqual(result, { status: 409, body: { ok: false, error: 'busy' } });
  });

  test('corpo que não é JSON vira ok:false com o status, não lança', async () => {
    config.streamStore.token = 'tok-destrutivo';
    const result = await withMockFetch([{
      match: /\/magnet-bank\/import$/,
      handler: () => new Response('<html>502</html>', { status: 502 }),
    }], () => importNativeBank(SPOOL));
    assert.equal(result?.status, 502);
    assert.equal(result?.body.ok, false);
  });

  test('erro de rede devolve null (a rota responde 503), sem lançar', async () => {
    config.streamStore.token = 'tok-destrutivo';
    const result = await withMockFetch([{
      match: /\/magnet-bank\/import$/,
      handler: () => { throw new Error('ECONNREFUSED'); },
    }], () => importNativeBank(SPOOL));
    assert.equal(result, null);
  });
});
