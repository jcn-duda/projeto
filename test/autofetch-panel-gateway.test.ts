// Painel do Chupim ATRAVÉS da ponte com a admin do gateway: o bloco
// `autofetch` do `/dashboard-status.json` e as ações do `/dashboard-action.json`
// quando a rota `/autofetch*` existe. A ponte em si (token, prazo, backoff) é
// de `autofetch-native.test.ts`; aqui o `fetch` é dublado com as rotas da admin.
//
// Duas regras que estes testes travam:
//   1. `confirm` roda no despacho ANTES da ponte: ação destrutiva sem confirmação
//      não chega ao gateway;
//   2. enquanto o worker nativo nasce desligado (`enabled:false`,
//      `effect:'none'`), o Chupim que executa é o do Node — o efeito local
//      continua, e o bloco não troca os números do Node pela foto nativa.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { createApp } from '../src/app.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetchQueues from '../src/providers/autofetch.js';
import { resetAutofetchBridgeForTests } from '../src/utils/autofetch-native.js';
import { createTestServer, withMockFetch } from './e2e/e2e-harness.js';

const TOKEN = 'tok-painel-chupim';
const HASH = '0123456789abcdef0123456789abcdef01234567';
let server: any;
let savedToken = '';

before(async () => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = '';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = savedToken;
});

beforeEach(() => {
  resetAutofetchBridgeForTests();
  autofetchLive.reset();
});

function adminStatus(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: {
      enabled: false, phase: 'prepared', paused: false,
      queueDepth: 0, lots: 0, inflight: false, intervalMs: 60_000,
      ...over,
    },
  };
}

// Semeia a fila DENTRO do mock: `withMockFetch` chama `cache.clear()`, que
// zera o mesmo KV nativo onde as filas do Chupim vivem (a semeadura feita fora
// seria apagada antes de a ação rodar).
function seedQueue() {
  autofetchQueues.writeQueue('search-key-ponte', [{ infoHash: HASH, name: 'Release de teste' }]);
}

async function panelStatus(): Promise<Record<string, any>> {
  const res = await server.request('GET', '/dashboard-status.json?blocos=autofetch', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  return res.json.autofetch as Record<string, any>;
}

function action(name: string, body: Record<string, unknown> = {}) {
  return server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { action: name, ...body },
  });
}

// (d) bloco: gateway fora do ar → snapshot do Node, shape de sempre.
test('bloco autofetch: sem a admin, source node e o snapshot do Node intacto', async () => {
  config.jackett.testToken = TOKEN;
  config.streamStore.url = 'http://127.0.0.1:1';
  try {
    const af = await panelStatus();
    assert.equal(af.source, 'node');
    assert.equal(af.gateway, undefined, 'sem admin não há foto nativa para exibir');
    assert.ok(af.config?.effective, 'config ao vivo continua no payload');
    // Corte do Chupim TS: o snapshot do Node é PARCIAL. Lotes/settle eram do
    // runner em memória; sem fonte no Node eles NÃO aparecem (nada de zero
    // inventado) — quem mede é o worker nativo, publicado em `gateway`.
    assert.equal(af.partial, true, 'a foto do Node se declara parcial');
    assert.equal('recheckLots' in af, false, 'sem runner, sem contagem de lotes');
    assert.equal(typeof af.budget?.used, 'number', 'orçamento continua no snapshot de autofetch');
    assert.ok(Array.isArray(af.lastSkips));
  } finally {
    config.jackett.testToken = '';
  }
});

// (d) bloco: admin respondendo → `source:'gateway'`, mesmo FORMATO.
test('bloco autofetch: admin preparada marca source gateway sem apagar os números do Node', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch$/, handler: () => adminStatus({ paused: true, queueDepth: 4 }) },
    ], async () => {
      const af = await panelStatus();
      assert.equal(af.source, 'gateway');
      assert.deepEqual(
        { phase: af.gateway?.phase, paused: af.gateway?.paused, queueDepth: af.gateway?.queueDepth },
        { phase: 'prepared', paused: true, queueDepth: 4 },
        'a foto crua da admin viaja em `gateway`',
      );
      // Worker desligado (`enabled:false`): quem executa é o Chupim do Node, e
      // o bloco não troca os números dele pela foto nativa.
      assert.equal(af.paused, false);
      assert.ok(af.config?.effective, 'shape preservado');
      assert.ok(Array.isArray(af.obras));
      assert.equal(af.partial, undefined, 'foto do gateway não é parcial');
      assert.equal('settleLots' in af, false, 'settle não é do Node');
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('bloco autofetch: worker ligado entra com os nomes do bloco (paused/lots/queueDepth)', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch$/, handler: () => adminStatus({ enabled: true, phase: 'running', paused: true, lots: 7, queueDepth: 4, inflight: true }) },
    ], async () => {
      const af = await panelStatus();
      assert.equal(af.source, 'gateway');
      assert.equal(af.paused, true, 'paused vem do worker que executa');
      assert.equal(af.recheckLots, 7, 'lots nativos ocupam o nome que o painel já lê');
      assert.equal(af.queues.count, 4, 'queueDepth ocupa queues.count');
      assert.equal(af.gateway.inflight, true);
    });
  } finally {
    config.jackett.testToken = '';
  }
});

// (c) confirm na frente da ponte e o efeito dividido com o Node.
test('painel: autofetch-drain exige confirm ANTES de falar com a admin', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/drain$/, handler: () => ({ ok: true, enabled: false, phase: 'prepared', operation: 'drain', effect: 'none', drained: 0 }) },
    ], async (mock) => {
      const semConfirm = await action('autofetch-drain');
      assert.equal(semConfirm.status, 400);
      assert.equal(semConfirm.json.error, 'confirmation_required');
      assert.equal(
        mock.calls.filter((call: any) => String(call.url).includes('/autofetch')).length,
        0,
        'sem confirm o despacho nem chega à ponte',
      );
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('painel: dreno com a admin preparada (effect:none) mantém o efeito do Node', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/drain$/, handler: () => ({ ok: true, enabled: false, phase: 'prepared', operation: 'drain', effect: 'none', drained: 0 }) },
    ], async () => {
      seedQueue();
      const res = await action('autofetch-drain', { confirm: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.action, 'autofetch-drain');
      assert.ok(res.json.items >= 1, 'formato antigo preservado: o Node drenou de verdade');
      assert.equal(res.json.source, 'node');
      assert.equal(res.json.gateway.effect, 'none', 'a recusa de efeito do worker fica visível');
      assert.equal(autofetchQueues.snapshot().queues.items, 0);
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('painel: dreno aplicado pela admin não drena a fila do Node', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/drain$/, handler: () => ({ ok: true, enabled: true, phase: 'running', operation: 'drain', effect: 'applied', drained: 2 }) },
    ], async () => {
      seedQueue();
      assert.ok(autofetchQueues.snapshot().queues.items >= 1, 'fila semeada antes da ação');
      const res = await action('autofetch-drain', { confirm: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.items, 2, 'o número é o do worker');
      assert.equal(res.json.source, 'gateway');
      assert.ok(autofetchQueues.snapshot().queues.items >= 1, 'o Node não mexeu na fila');
    });
  } finally {
    autofetchQueues.drainQueues();
    config.jackett.testToken = '';
  }
});

test('painel: autofetch-pause repassa à admin e espelha o overlay do Node', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      {
        match: /\/autofetch\/pause$/,
        handler: (_url: string, init?: RequestInit) => ({
          ok: true,
          status: {
            enabled: false, phase: 'prepared', intervalMs: 60_000,
            paused: JSON.parse(String(init?.body || '{}')).paused === true,
          },
        }),
      },
    ], async (mock) => {
      const res = await action('autofetch-pause', { paused: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.paused, true);
      assert.equal(res.json.source, 'gateway');
      assert.equal(autofetchLive.isPaused(), true, 'o Chupim de pé (Node) pausa junto até o corte');
      assert.deepEqual(JSON.parse(String(mock.calls.at(-1)?.body)), { paused: true });
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('painel: autofetch-config-set manda ao worker só a pausa efetiva', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/config$/, handler: () => adminStatus() },
    ], async (mock) => {
      const res = await action('autofetch-config-set', { patch: { autoFetchMax: 2, paused: true } });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.effective.autoFetchMax, 2, 'formato antigo da config preservado');
      assert.equal(res.json.nativeApplied, true);
      assert.deepEqual(
        JSON.parse(String(mock.calls.at(-1)?.body)),
        { paused: true },
        'a admin só aceita paused/intervalMs; o resto é do Node',
      );
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('painel: autofetch-suppressed-drain com o worker desligado não drena pelo Node', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/suppressed-drain$/, handler: () => ({ ok: true, enabled: false, phase: 'prepared', operation: 'suppressed-drain', effect: 'none', drained: 0, reason: 'worker-disabled' }) },
    ], async () => {
      const res = await action('autofetch-suppressed-drain', { confirm: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, false, 'effect none não vira dreno local');
      assert.equal(res.json.reason, 'native-unavailable');
      assert.equal(res.json.gateway?.effect, 'none');
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('painel: autofetch-suppressed-drain com a represa vazia é sucesso com zero', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/suppressed-drain$/, handler: () => ({ ok: true, enabled: true, phase: 'running', operation: 'suppressed-drain', effect: 'none', drained: 0, reason: 'empty' }) },
    ], async () => {
      const res = await action('autofetch-suppressed-drain', { confirm: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true, 'passagem real sem o que apagar não é falha');
      assert.equal(res.json.removidas, 0);
      assert.equal(res.json.source, 'gateway');
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('painel: autofetch-suppressed-drain aplicado pela admin dispensa a conta do operador', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([
      { match: /\/autofetch\/suppressed-drain$/, handler: () => ({ ok: true, enabled: true, phase: 'running', operation: 'suppressed-drain', effect: 'applied', drained: 1 }) },
    ], async () => {
      const res = await action('autofetch-suppressed-drain', { confirm: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.removidas, 1);
      assert.equal(res.json.source, 'gateway');
      assert.equal(res.json.restantes, null, 'por conta não existe na admin: null, não zero inventado');
    });
  } finally {
    config.jackett.testToken = '';
  }
});
