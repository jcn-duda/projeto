import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import { accountScope } from '../src/utils/request-key.js';
import { createTestServer } from './e2e/e2e-harness.js';

// Fase 3: ações magnet-inspect / magnet-clear-bad / magnet-summary do
// /dashboard-action.json. Semeia o banco de magnets por chaves reais
// (markAlive/markBad/markLie) e verifica enumeração do L1, filtros, teto,
// idempotência do clear-bad e ausência de credencial/digest no payload.

const TOKEN = 'tok-magnetdb';
const API_KEY = 'chave-secreta-do-operador-nao-vazar';
const ADAPTER = 'magfake';
const HASH_ALIVE = 'a'.repeat(40);
const HASH_BAD_1 = 'b'.repeat(40);
const HASH_BAD_2 = 'c'.repeat(40);
const HASH_LIE = 'd'.repeat(40);
const HASH_BAD_OUTRO = 'e'.repeat(40);

let server: any;
const saved: Record<string, any> = {};

function seed() {
  magnetdb.markAlive(ADAPTER, API_KEY, [HASH_ALIVE]);
  magnetdb.markBad(ADAPTER, API_KEY, HASH_BAD_1);
  magnetdb.markBad(ADAPTER, API_KEY, HASH_BAD_2);
  magnetdb.markLie(ADAPTER, API_KEY, HASH_LIE);
  magnetdb.markBad('magfake2', API_KEY, HASH_BAD_OUTRO);
}

before(async () => {
  saved.enabled = config.magnetDb.enabled;
  saved.lieEnabled = config.magnetDb.lieEnabled;
  saved.testToken = config.jackett.testToken;
  config.magnetDb.enabled = true;
  config.magnetDb.lieEnabled = true;

  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.magnetDb.enabled = saved.enabled;
  config.magnetDb.lieEnabled = saved.lieEnabled;
  config.jackett.testToken = saved.testToken;
});

function post(body: any) {
  return server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body,
  });
}

test('magnet-inspect lista entradas do L1 sem vazar chave nem digest de conta', async () => {
  config.jackett.testToken = TOKEN;
  cache.clear();
  try {
    seed();
    const res = await post({ action: 'magnet-inspect' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.matched, 5);
    assert.equal(res.json.returned, 5);
    assert.equal(res.json.truncated, false);
    assert.ok(Array.isArray(res.json.items));

    // Payload seguro: nem a chave crua, nem o digest accountScope dela.
    const raw = JSON.stringify(res.json);
    assert.ok(!raw.includes(API_KEY), 'apiKey não aparece no payload');
    assert.ok(!raw.includes(accountScope(API_KEY)), 'accountScope não aparece no payload');

    const bad = res.json.items.find((i: any) => i.hash === HASH_BAD_1);
    assert.deepEqual(Object.keys(bad).sort(), ['adapterId', 'hash', 'side', 'ttlRemainingSeconds']);
    assert.equal(bad.side, 'bad');
    assert.equal(bad.adapterId, ADAPTER);
    assert.equal(bad.ttlRemainingSeconds > 0, true);
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('magnet-inspect aplica filtros side, adapterId e hash, e o teto de itens', async () => {
  config.jackett.testToken = TOKEN;
  cache.clear();
  try {
    seed();

    const bads = await post({ action: 'magnet-inspect', side: 'bad' });
    assert.equal(bads.json.matched, 3);
    assert.ok(bads.json.items.every((i: any) => i.side === 'bad'));

    const outro = await post({ action: 'magnet-inspect', adapterId: 'magfake2' });
    assert.equal(outro.json.matched, 1);
    assert.equal(outro.json.items[0].hash, HASH_BAD_OUTRO);

    const um = await post({ action: 'magnet-inspect', hash: HASH_LIE });
    assert.equal(um.json.matched, 1);
    assert.equal(um.json.items[0].side, 'lie');

    const limitado = await post({ action: 'magnet-inspect', max: 2 });
    assert.equal(limitado.json.returned, 2);
    assert.equal(limitado.json.matched, 5);
    assert.equal(limitado.json.truncated, true);
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('magnet-inspect devolve 400 para filtro inválido em vez de ignorá-lo', async () => {
  config.jackett.testToken = TOKEN;
  try {
    seed();
    for (const body of [
      { action: 'magnet-inspect', side: 'quebrado' },
      { action: 'magnet-inspect', adapterId: 'id com espaço' },
      { action: 'magnet-inspect', hash: 'abcdef' },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, `filtro inválido deveria reprovar: ${JSON.stringify(body)}`);
      assert.equal(res.json.ok, false);
    }
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('magnet-summary agrega por adapter × side sem expor hash nenhum', async () => {
  config.jackett.testToken = TOKEN;
  cache.clear();
  try {
    seed();
    const res = await post({ action: 'magnet-summary' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.entries, 5);
    assert.deepEqual(res.json.totals, { alive: 1, bad: 3, lie: 1 });
    assert.deepEqual(res.json.byAdapter[ADAPTER], { alive: 1, bad: 2, lie: 1 });
    assert.deepEqual(res.json.byAdapter.magfake2, { alive: 0, bad: 1, lie: 0 });

    const raw = JSON.stringify(res.json);
    assert.ok(!raw.includes(API_KEY));
    assert.ok(!raw.includes(accountScope(API_KEY)));
    assert.ok(!raw.includes(HASH_ALIVE), 'summary é agregado: nenhum hash no payload');
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('magnet-clear-bad exige confirmação central (400 confirmation_required)', async () => {
  config.jackett.testToken = TOKEN;
  cache.clear();
  try {
    seed();
    const res = await post({ action: 'magnet-clear-bad' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'confirmation_required');
    // Nada foi apagado pela recusa.
    assert.equal(magnetdb.peekBad(ADAPTER, API_KEY, HASH_BAD_1), true);
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('magnet-clear-bad com confirm apaga só bad, preserva alive/lie e é idempotente', async () => {
  config.jackett.testToken = TOKEN;
  cache.clear();
  try {
    seed();
    // Filtro por adapter: só o bad do magfake2 sai nesta passagem.
    const res = await post({ action: 'magnet-clear-bad', confirm: true, adapterId: 'magfake2' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.cleared, 1);
    assert.equal(res.json.remaining, 0);

    assert.equal(magnetdb.peekBad('magfake2', API_KEY, HASH_BAD_OUTRO), false);
    assert.equal(magnetdb.peekBad(ADAPTER, API_KEY, HASH_BAD_1), true, 'bad de outro adapter permanece');
    assert.equal(magnetdb.peekAlive(ADAPTER, API_KEY, HASH_ALIVE), true, 'alive não é tocado');
    assert.equal(magnetdb.peekLie(ADAPTER, API_KEY, HASH_LIE), true, 'lie não é tocado');

    // Idempotência: segunda passada no mesmo escopo não tem o que apagar.
    const deNovo = await post({ action: 'magnet-clear-bad', confirm: true, adapterId: 'magfake2' });
    assert.equal(deNovo.json.cleared, 0);

    // Contagem durável por adapter acompanha as remoções (hook onForget) —
    // o delta da passagem é que é contrato, não o valor absoluto: testes
    // anteriores semearam o mesmo adapter e cache.clear() não dispara hook.
    const sizeBadAntes = magnetdb.status().byAdapter[ADAPTER].sizeBad;
    const geral = await post({ action: 'magnet-clear-bad', confirm: true });
    assert.equal(geral.json.cleared, 2);
    assert.equal(magnetdb.peekBad(ADAPTER, API_KEY, HASH_BAD_1), false);
    assert.equal(magnetdb.peekBad(ADAPTER, API_KEY, HASH_BAD_2), false);
    const status = magnetdb.status();
    assert.equal(status.byAdapter[ADAPTER].sizeBad, sizeBadAntes - 2);
    assert.equal(status.byAdapter[ADAPTER].sizeAlive >= 1, true);
    assert.equal(status.byAdapter[ADAPTER].sizeLie >= 1, true);
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('magnet-clear-bad respeita filtro de hash, teto e valida side alheio', async () => {
  config.jackett.testToken = TOKEN;
  cache.clear();
  try {
    seed();
    // side !== 'bad' é recusado: a ação só apaga bad.
    const recusado = await post({ action: 'magnet-clear-bad', confirm: true, side: 'alive' });
    assert.equal(recusado.status, 400);
    assert.equal(magnetdb.peekAlive(ADAPTER, API_KEY, HASH_ALIVE), true);

    // Teto por passagem: max 1 derruba só um bad e reporta o restante.
    const limitado = await post({ action: 'magnet-clear-bad', confirm: true, max: 1 });
    assert.equal(limitado.json.cleared, 1);
    assert.equal(limitado.json.remaining, 2, 'os outros 2 bads ficam para a próxima passagem');

    // Alvo específico por hash.
    const alvo = await post({ action: 'magnet-clear-bad', confirm: true, hash: HASH_BAD_2 });
    assert.equal(alvo.json.cleared, 1);
    assert.equal(magnetdb.peekBad(ADAPTER, API_KEY, HASH_BAD_2), false);
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});
