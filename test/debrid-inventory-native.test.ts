// Ponte do painel com o inventário NATIVO da conta AllDebrid
// (`GET /debrid/inventory` na admin 8711) e seus dois consumidores.
//
// Prova (a) a URL/header da admin 8711 com a precedência de token da casa,
// (b) a validação campo a campo do shape, (c) o fail-open (404/500/timeout/
// corpo estranho → null), (d) o TTL com dedupe in-flight, (e) o bloco
// `debrid` publicando `inventory` SEMPRE (null = desconhecido, nunca zero) e
// (f) o cartão da Limpeza dizendo "desconhecido"/"ainda não carregado" —
// nunca erro e nunca "conta vazia" sem medição.
//
// Sem rede: o dublê de fetch responde a rota; o `beforeEach` aponta a URL para
// a admin de verdade (o `setup-env` pina uma porta fechada para o resto da
// suíte) e zera o estado da ponte.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import type { AppServices } from '../src/routes/types.js';
import { debridBlock } from '../src/routes/dashboard-debrid-block.js';
import {
  fetchNativeDebridInventory,
  resetDebridInventoryBridgeForTests,
} from '../src/providers/debrid-inventory-native.js';
import { SweepsCard, inventoryLine } from '../src/client/painel/limpeza/view-sweeps.js';
import { expand, textOf } from './helpers/painel-vnode.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const URL_BASE = 'http://127.0.0.1:8711';
/** Token de DIAGNÓSTICO (`JACKETT_TEST_TOKEN`): abre a superfície de leitura. */
const TOKEN = 'token-inventario';
const FOTO_COMPLETA = {
  ok: true,
  enabled: true,
  reason: null,
  count: 42,
  at: 1_793_220_000_000,
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
  resetDebridInventoryBridgeForTests();
});

afterEach(() => {
  config.streamStore = savedConfig;
  config.jackett.testToken = savedToken;
  resetDebridInventoryBridgeForTests();
});

function json(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

function headerOf(call: { options?: any }, name: string): string | undefined {
  const headers = call.options?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

/** `services` mínimo do bloco: só o trio que `debridBlock` consome. */
function fakeServices() {
  return {
    debrid: {
      current: () => ({ id: 'alldebrid', label: 'AllDebrid' }),
      dashboardAccounts: async () => ({ alldebrid: { ok: true } }),
      SERVICES: [{ id: 'alldebrid' }],
    },
  } as unknown as AppServices;
}

test('GET /debrid/inventory na admin 8711 com o token da superfície', async () => {
  const stub = stubFetch(() => json({ ...FOTO_COMPLETA }));
  try {
    const foto = await fetchNativeDebridInventory();
    assert.ok(foto, 'shape válido não vira null');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${URL_BASE}/debrid/inventory`);
    // Sem token próprio, o de diagnóstico abre a leitura (mesma precedência
    // das outras rotas de superfície da admin).
    assert.equal(headerOf(stub.calls[0], 'x-indexer-test-token'), TOKEN);

    // O token próprio vence quando configurado (TTL 0: sem cache entre as duas).
    config.streamStore.token = 'tok-proprio';
    await fetchNativeDebridInventory({ ttlMs: 0 });
    assert.equal(headerOf(stub.calls[1], 'x-indexer-test-token'), 'tok-proprio');
  } finally {
    stub.restore();
  }
});

test('shape completo → foto com os campos medidos e o relógio da ponte', async () => {
  const stub = stubFetch(() => json({ ...FOTO_COMPLETA }));
  try {
    const foto = await fetchNativeDebridInventory();
    assert.ok(foto);
    assert.equal(foto.ok, true);
    assert.equal(foto.enabled, true);
    assert.equal(foto.reason, null);
    assert.equal(foto.count, 42);
    assert.equal(foto.at, 1_793_220_000_000);
    assert.match(foto.pulledAt, /^\d{4}-\d{2}-\d{2}T/, 'a ponte carrega a hora em que ELA tirou a foto');
  } finally {
    stub.restore();
  }
});

test('enabled:false com reason é RESPOSTA do gateway (não falha) e viaja inteira', async () => {
  const stub = stubFetch(() => json({
    ok: true, enabled: false, reason: 'no_operator_account', count: null, at: 7,
  }));
  try {
    const foto = await fetchNativeDebridInventory();
    assert.ok(foto, 'sem conta do operador não é falha de ponte');
    assert.equal(foto.enabled, false);
    assert.equal(foto.reason, 'no_operator_account');
    assert.equal(foto.count, null, 'sem conta não há contagem: null, nunca 0');
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('404/500/timeout/corpo estranho → null, com bridge_errors contado', async () => {
  const antes = metrics.snapshot().counters['debrid.inventory.bridge_errors'] || 0;

  // 404: gateway velho sem a rota.
  const notFound = stubFetch(() => json({ error: 'not found' }, 404));
  try {
    assert.equal(await fetchNativeDebridInventory(), null);
  } finally { notFound.restore(); }

  // 500: gateway doente.
  const serverError = stubFetch(() => json({}, 500));
  try {
    assert.equal(await fetchNativeDebridInventory(), null);
  } finally { serverError.restore(); }

  // Timeout: o fetch aborta (o mesmo caminho do prazo estourado).
  const timeout = stubFetch(() => { throw new Error('The operation was aborted'); });
  try {
    assert.equal(await fetchNativeDebridInventory(), null);
  } finally { timeout.restore(); }

  // Corpo estranho: não-objeto, array e ok:false — cada um por vez.
  const corpos = ['não sou json de inventário', [{ ok: true }], { ok: false, error: 'x' }];
  const estranho = stubFetch(() => json(corpos.shift()));
  try {
    assert.equal(await fetchNativeDebridInventory(), null);
    assert.equal(await fetchNativeDebridInventory(), null);
    assert.equal(await fetchNativeDebridInventory(), null);
  } finally { estranho.restore(); }

  const depois = metrics.snapshot().counters['debrid.inventory.bridge_errors'] || 0;
  assert.ok(depois - antes >= 6, `cada falha da ponte conta bridge_errors (delta ${depois - antes})`);
});

test('sem token: ponte não sai do lugar (bridge_no_token), null sem fetch', async () => {
  config.streamStore.token = '';
  config.jackett.testToken = '';
  const antes = metrics.snapshot().counters['debrid.inventory.bridge_no_token'] || 0;
  const stub = stubFetch(() => { throw new Error('não deveria ter saído chamada'); });
  try {
    assert.equal(await fetchNativeDebridInventory(), null);
    const depois = metrics.snapshot().counters['debrid.inventory.bridge_no_token'] || 0;
    assert.ok(depois - antes >= 1, 'configuração ausente é contada, não escondida');
    assert.equal(stub.calls.length, 0, 'sem token NÃO há fetch: não é falha de rede');
  } finally {
    stub.restore();
  }
});

test('TTL: foto em cache não refaz o fetch; ttlMs:0 refaz; voo em curso não duplica', async () => {
  const stub = stubFetch(() => json({ ...FOTO_COMPLETA }));
  try {
    // Dedupe in-flight: duas chamadas simultâneas, UM fetch.
    const [a, b] = await Promise.all([
      fetchNativeDebridInventory({ ttlMs: 0 }),
      fetchNativeDebridInventory({ ttlMs: 0 }),
    ]);
    assert.equal(stub.calls.length, 1, 'o voo em curso é compartilhado');
    assert.equal(a?.count, 42);
    assert.equal(b?.count, 42);

    // Cache vivo: dentro do TTL nem chega a criar voo novo.
    await fetchNativeDebridInventory({ ttlMs: 60_000 });
    assert.equal(stub.calls.length, 1, 'a foto em cache é servida sem rede');

    // TTL 0: sempre refaz (é o que os testes usam para isolar estados).
    await fetchNativeDebridInventory({ ttlMs: 0 });
    assert.equal(stub.calls.length, 2, 'ttlMs 0 força o refetch');
  } finally {
    stub.restore();
  }
});

// BLOCO: `debrid.inventory` existe SEMPRE no /dashboard-status.json; falha da
// ponte é null (o painel mostra "desconhecido") — o contrato antigo do bloco
// (active/account/accounts/services/sweeps) fica inteiro.
test('bloco debrid: inventory sempre presente; ponte falhando → null, nunca zero', async () => {
  const falha = stubFetch(() => json({}, 503));
  try {
    const bloco = await debridBlock(fakeServices(), { ok: true, total: 933 });
    assert.ok('inventory' in bloco, 'a chave existe mesmo com a ponte fora');
    assert.equal(bloco.inventory, null, 'ponte falhando: desconhecido, nunca 0');
    // Contrato anterior preservado.
    assert.equal(bloco.active, 'alldebrid');
    assert.deepEqual(bloco.accounts, { alldebrid: { ok: true } });
  } finally {
    falha.restore();
  }

  const ok = stubFetch(() => json({ ...FOTO_COMPLETA }));
  try {
    const bloco = await debridBlock(fakeServices(), { ok: true });
    assert.equal((bloco.inventory as any)?.count, 42, 'com o gateway são, a foto viaja');
  } finally {
    ok.restore();
  }
});

// CARTÃO: a linha do inventário nunca inventa medida nem vira erro na tela.
test('inventoryLine: desconhecido, indisponível com motivo, frio e contagem', () => {
  // Sem foto / corpo estranho: desconhecido (a ponte falhou — não é erro).
  for (const entry of [null, undefined, 'lixo', { sem: 'ok' }, { ok: false }]) {
    assert.match(
      inventoryLine(entry as any),
      /Inventário da conta: desconhecido/,
      `${JSON.stringify(entry)} não vira medida`,
    );
  }
  // Gateway sem conta do operador: motivo traduzido do vocabulário estável.
  assert.equal(
    inventoryLine({ ok: true, enabled: false, reason: 'no_operator_account', count: null }),
    'Inventário da conta: indisponível — sem conta do operador configurada',
  );
  // Conta viva, snapshot frio: "ainda não carregado", NUNCA 0.
  assert.equal(
    inventoryLine({ ok: true, enabled: true, reason: null, count: null }),
    'Inventário da conta: ainda não carregado no gateway',
  );
  // Foto quente: a contagem medida.
  assert.equal(
    inventoryLine({ ok: true, enabled: true, reason: null, count: 42 }),
    'Inventário da conta (gateway): 42 magnet(s) protegido(s)',
  );
});

test('SweepsCard renderiza a linha do inventário com a foto e sem ela', () => {
  const sweeps = {
    ok: true, enabled: true, scheduled: true, mode: 'read_only', intervalMs: 21_600_000,
    running: false, startedAt: 1_793_220_000_000, lastTickAt: 1_793_223_600_000,
    nextDueAt: 1_793_245_200_000, disabledReason: null,
    counters: { runs: 3, manualRuns: 0, planned: 7, swept: 0, failed: 0, blocked: 0, calls: 0, reasons: {} },
    last: { at: 1_793_223_600_000, manual: false, outcomes: [], missing: [] },
    pulledAt: '2026-10-31T12:00:00.000Z',
  };
  const comFoto = SweepsCard({ sweeps, inventory: { ok: true, enabled: true, reason: null, count: 42 } });
  assert.match(textOf(comFoto), /Inventário da conta \(gateway\): 42 magnet\(s\) protegido\(s\)/);

  // Cartão indisponível continua mostrando a linha do inventário: são fotos
  // independentes (varreduras × inventário).
  const semSweeps = SweepsCard({ sweeps: null, inventory: { ...FOTO_COMPLETA } });
  assert.match(textOf(semSweeps), /status nativo indisponível/);
  assert.match(textOf(semSweeps), /Inventário da conta \(gateway\): 42 magnet\(s\) protegido\(s\)/);

  // Sem NENHUMA foto: desconhecido nos dois sentidos, sem erro lançado.
  const semNada = SweepsCard({});
  assert.match(textOf(semNada), /Inventário da conta: desconhecido/);
  const texto = expand(semNada).map((n) => textOf(n)).join(' ');
  assert.doesNotMatch(texto, /undefined|\[object Object\]/);
});
