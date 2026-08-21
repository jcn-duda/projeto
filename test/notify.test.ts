import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { notify } from '../src/utils/notify.js';
import { stubFetch } from './helpers/stub.js';
import debrid from '../src/debrid/index.js';
import * as indexerStatus from '../src/providers/indexer-status.js';

test('notify envia POST JSON formatado e sanitiza credenciais', async () => {
  const saved = {
    enabled: config.notify.enabled,
    url: config.notify.webhookUrl,
    cooldownS: config.notify.cooldownS,
  };
  const calls: { url: string; options: any; body?: any }[] = [];
  const stub = stubFetch((url: string, options: any) => {
    if (url === 'https://webhook.teste/alerta') {
      const body = options?.body ? JSON.parse(options.body) : {};
      calls.push({ url, options, body });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  try {
    config.notify.enabled = true;
    config.notify.webhookUrl = 'https://webhook.teste/alerta';
    config.notify.cooldownS = 3600;

    const ok = await notify('test_event_1', 'error', 'Teste de erro', {
      adapter: 'alldebrid',
      apiKey: 'segredo-secreto',
      nested: { token: 'token-123', safeValue: 42 },
      count: 10,
    });

    assert.equal(ok, true, 'webhook disparado com sucesso');
    assert.equal(calls.length, 1);
    const payload = calls[0].body;
    assert.equal(payload.event, 'test_event_1');
    assert.equal(payload.severity, 'error');
    assert.equal(payload.message, 'Teste de erro');
    assert.equal(payload.data.adapter, 'alldebrid');
    assert.equal(payload.data.count, 10);
    assert.equal(payload.data.apiKey, undefined, 'apiKey foi filtrada');
    assert.equal(payload.data.nested.token, undefined, 'nested.token foi filtrado');
    assert.equal(payload.data.nested.safeValue, 42);
    assert.ok(payload.at, 'timestamp incluído');
  } finally {
    stub.restore();
    config.notify.enabled = saved.enabled;
    config.notify.webhookUrl = saved.url;
    config.notify.cooldownS = saved.cooldownS;
  }
});

test('notify respeita cooldown por evento', async () => {
  const saved = {
    enabled: config.notify.enabled,
    url: config.notify.webhookUrl,
    cooldownS: config.notify.cooldownS,
  };
  let count = 0;
  const stub = stubFetch((url: string) => {
    if (url === 'https://webhook.teste/cooldown') {
      count++;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  try {
    config.notify.enabled = true;
    config.notify.webhookUrl = 'https://webhook.teste/cooldown';
    config.notify.cooldownS = 3600;

    const first = await notify('cooldown_event', 'warning', 'Primeiro aviso');
    assert.equal(first, true);
    assert.equal(count, 1);

    // Segundo disparo imediato do mesmo evento deve ser suprimido pelo cooldown
    const second = await notify('cooldown_event', 'warning', 'Segundo aviso');
    assert.equal(second, false, 'suprimido pelo cooldown');
    assert.equal(count, 1);
  } finally {
    stub.restore();
    config.notify.enabled = saved.enabled;
    config.notify.webhookUrl = saved.url;
    config.notify.cooldownS = saved.cooldownS;
  }
});

test('notify desliga quando NOTIFY_ENABLED=false ou URL vazia', async () => {
  const saved = {
    enabled: config.notify.enabled,
    url: config.notify.webhookUrl,
  };
  try {
    config.notify.enabled = false;
    config.notify.webhookUrl = 'https://webhook.teste/alerta';
    const res1 = await notify('disabled_event', 'info', 'msg');
    assert.equal(res1, false);

    config.notify.enabled = true;
    config.notify.webhookUrl = '';
    const res2 = await notify('no_url_event', 'info', 'msg');
    assert.equal(res2, false);
  } finally {
    config.notify.enabled = saved.enabled;
    config.notify.webhookUrl = saved.url;
  }
});

test('notify é best-effort e não lança se o endpoint falhar ou der timeout', async () => {
  const saved = {
    enabled: config.notify.enabled,
    url: config.notify.webhookUrl,
    cooldownS: config.notify.cooldownS,
  };
  const stub = stubFetch(() => {
    throw new Error('Falha de rede simulada');
  });
  try {
    config.notify.enabled = true;
    config.notify.webhookUrl = 'https://webhook.teste/error';
    config.notify.cooldownS = 0;

    const ok = await notify('net_error_event', 'error', 'Erro de rede');
    assert.equal(ok, false, 'retorna false sem lançar erro');
  } finally {
    stub.restore();
    config.notify.enabled = saved.enabled;
    config.notify.webhookUrl = saved.url;
    config.notify.cooldownS = saved.cooldownS;
  }
});

test('indexer_down notifica quando indexer BR fica offline', async () => {
  const saved = {
    enabled: config.notify.enabled,
    url: config.notify.webhookUrl,
    cooldownS: config.notify.cooldownS,
    ptBr: config.jackett.ptBrIndexers,
  };
  const calls: any[] = [];
  const stub = stubFetch((url: string, options: any) => {
    if (url === 'https://webhook.teste/indexer') {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.notify.enabled = true;
    config.notify.webhookUrl = 'https://webhook.teste/indexer';
    config.notify.cooldownS = 0;
    config.jackett.ptBrIndexers = ['br-indexer-test'];

    // Grava amostra offline
    indexerStatus.record('br-indexer-test', { ok: false });
    // Aguarda microtask
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(calls.length >= 1, 'notificação de indexer down disparada');
    assert.equal(calls[0].event, 'indexer_down');
    assert.equal(calls[0].data.indexer, 'br-indexer-test');
  } finally {
    stub.restore();
    config.notify.enabled = saved.enabled;
    config.notify.webhookUrl = saved.url;
    config.notify.cooldownS = saved.cooldownS;
    config.jackett.ptBrIndexers = saved.ptBr;
  }
});
