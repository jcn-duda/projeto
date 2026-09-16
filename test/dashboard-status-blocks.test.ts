import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { ALL_BLOCKS } from '../src/routes/dashboard-status-blocks.js';

test('ALL_BLOCKS contém todos os blocos esperados (incluindo conta e gate)', () => {
  assert.ok(ALL_BLOCKS.includes('conta'));
  assert.ok(ALL_BLOCKS.includes('gate'));
  assert.ok(ALL_BLOCKS.includes('general'));
  assert.ok(ALL_BLOCKS.includes('debrid'));
  assert.ok(ALL_BLOCKS.includes('autofetch'));
  assert.ok(ALL_BLOCKS.includes('harvest'));
});

test('/dashboard-status.json sem ?blocos= devolve payload completo byte-compatível', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.generatedAt, 'precisa ter generatedAt');
    assert.equal(res.json.blocos, undefined, 'sem ?blocos= não deve ter campo blocos');
    assert.ok(res.json.general, 'deve conter general');
    assert.ok(res.json.debrid, 'deve conter debrid');
    assert.ok(res.json.metrics, 'deve conter metrics');
    assert.ok(res.json.cache, 'deve conter cache');
    assert.ok(res.json.harvest, 'deve conter harvest');
    assert.ok(res.json.autofetch, 'deve conter autofetch');
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});

test('/dashboard-status.json?blocos=conta,gate devolve APENAS os blocos pedidos e ecoa blocos', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json?blocos=conta,gate', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.blocos, ['conta', 'gate']);
    assert.ok(res.json.generatedAt);
    assert.ok(res.json.conta, 'deve conter bloco conta');
    assert.ok(res.json.gate, 'deve conter bloco gate');
    assert.equal(res.json.general, undefined, 'não deve computar general');
    assert.equal(res.json.metrics, undefined, 'não deve computar metrics');
    assert.equal(res.json.cache, undefined, 'não deve computar cache');

    // Validação da estrutura do bloco conta
    const conta = res.json.conta;
    assert.equal(typeof conta.cap, 'number');
    assert.equal(typeof conta.warnAt, 'number');
    assert.equal(typeof conta.total, 'number');
    assert.equal(typeof conta.usagePercent, 'number');

    // Validação da estrutura do bloco gate
    const gate = res.json.gate;
    assert.ok(gate.effective, 'gate deve ter effective');
    assert.ok(gate.envDefaults, 'gate deve ter envDefaults');
    assert.ok(Array.isArray(gate.diffs), 'gate deve ter diffs');
    assert.equal(typeof gate.autoFetchPauseAt, 'number');
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});

test('/dashboard-status.json com bloco desconhecido devolve 400 com lista de permitidos', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json?blocos=conta,invalido_xyz', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /bloco desconhecido/);
    assert.ok(Array.isArray(res.json.allowed));
    assert.ok(res.json.allowed.includes('conta'));
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});
