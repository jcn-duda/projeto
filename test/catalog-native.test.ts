import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import { loadNativeCatalog } from '../src/providers/catalog-native.js';
import { jackettServiceFlag } from '../src/routes/dashboard-status-helpers.js';
import { stubFetch } from './helpers/stub.js';

// F4.6 — a ponte do catálogo NATIVO (gateway, admin 8711) é a ÚNICA fonte do
// catálogo de indexers: o `load()` TS (`jackett-catalog.ts`) saiu. Aqui o
// assunto é o shape que a ponte entrega (igual ao do antigo `load()`) e o
// fail-open quando o gateway não responde. Sem rede: fetch dublado (stubFetch).

test('ponte nativa: cards do gateway entram com o shape do antigo load() (status + source)', async () => {
  const saved = { url: config.streamStore.url, token: config.streamStore.token };
  config.streamStore.url = 'http://127.0.0.1:8711';
  config.streamStore.token = 'tok-catalog-native';
  let sent: { headers?: Record<string, string> } = {};
  const stub = stubFetch((url, options) => {
    sent = { headers: options?.headers as Record<string, string> };
    assert.match(url, /\/indexers\/catalog$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        cards: [
          { id: 'Bludv-Cardigann', label: 'BLUDV', language: 'pt-BR', isBr: true },
          { id: 'mico', label: 'Mico Leão Dublado', language: 'pt-BR', isBr: true, virtual: true },
        ],
        source: 'live',
      }),
    };
  });
  try {
    const list = await loadNativeCatalog();
    assert.ok(list, 'a ponte respondeu');
    assert.equal(list.source, 'live', 'o source vem do gateway');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'bludv-cardigann', 'id normalizado');
    assert.ok('status' in list[0], 'decoração de status presente no shape');
    assert.equal(list[1].virtual, true, 'o virtual do Mico atravessa a ponte');
    assert.equal(sent.headers?.['x-indexer-test-token'], 'tok-catalog-native');
    assert.equal(jackettServiceFlag(list), true, 'catálogo vivo do gateway prova Jackett vivo');
  } finally {
    stub.restore();
    config.streamStore.url = saved.url;
    config.streamStore.token = saved.token;
  }
});

test('ponte nativa fora devolve null (fail-open) — a rota segue com a lista vazia', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  try {
    assert.equal(await loadNativeCatalog(), null, 'fail-open: null, não lançamento');
  } finally {
    globalThis.fetch = realFetch;
  }
});
