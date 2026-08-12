const { test } = require('node:test');
const assert = require('node:assert');

const { authorized, createDiagnosticGate } = require('../src/utils/diagnostic-guard');

test('diagnóstico exige token configurado e exato', () => {
  assert.equal(authorized('', ''), false);
  assert.equal(authorized('segredo', ''), false);
  assert.equal(authorized('segredo', 'outro'), false);
  assert.equal(authorized('segredo', 'segredo'), true);
});

test('diagnóstico limita concorrência e libera a vaga uma vez', () => {
  const gate = createDiagnosticGate({ limit: 10, maxConcurrent: 1 });
  const first = gate.enter('cliente-a');
  assert.equal(first.ok, true);
  assert.equal(gate.enter('cliente-b').status, 429);
  first.release();
  first.release();
  assert.equal(gate.enter('cliente-b').ok, true);
});

test('diagnóstico limita chamadas por cliente dentro da janela', () => {
  let time = 1000;
  const gate = createDiagnosticGate({ limit: 2, windowMs: 100, maxConcurrent: 1, now: () => time });
  const first = gate.enter('cliente');
  first.release();
  const second = gate.enter('cliente');
  second.release();
  assert.equal(gate.enter('cliente').status, 429);
  time += 101;
  assert.equal(gate.enter('cliente').ok, true);
});
