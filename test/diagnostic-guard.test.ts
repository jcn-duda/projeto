import { test } from 'node:test';
import assert from 'node:assert';

import * as diagGuard from '../src/utils/diagnostic-guard.js';

test('diagnóstico exige token configurado e exato', () => {
  assert.equal(diagGuard.authorized('', ''), false);
  assert.equal(diagGuard.authorized('segredo', ''), false);
  assert.equal(diagGuard.authorized('segredo', 'outro'), false);
  assert.equal(diagGuard.authorized('segredo', 'segredo'), true);
});

test('diagnóstico limita concorrência e libera a vaga uma vez', () => {
  const gate = diagGuard.createDiagnosticGate({ limit: 10, maxConcurrent: 1 });
  const first = gate.enter('cliente-a');
  assert.equal(first.ok, true);
  assert.equal(gate.enter('cliente-b').status, 429);
  first.release();
  first.release();
  assert.equal(gate.enter('cliente-b').ok, true);
});

test('o gate aceita mensagens próprias sem mudar as do diagnóstico', () => {
  // O /seal-config reusa o mesmo gate; falar de "teste em andamento" lá seria
  // mentira para quem só está gerando o link de instalação.
  const padrao = diagGuard.createDiagnosticGate({ limit: 1, maxConcurrent: 1 });
  const primeiro = padrao.enter('a');
  assert.match(padrao.enter('b').error, /teste em andamento/);
  primeiro.release();
  assert.match(padrao.enter('a').error, /limite de testes/);

  const selo = diagGuard.createDiagnosticGate({
    limit: 1,
    maxConcurrent: 1,
    rateMessage: 'muitos pedidos de selo',
    busyMessage: 'selo ocupado',
  });
  const ativo = selo.enter('a');
  assert.equal(selo.enter('b').error, 'selo ocupado');
  ativo.release();
  assert.equal(selo.enter('a').error, 'muitos pedidos de selo');
});

test('diagnóstico limita chamadas por cliente dentro da janela', () => {
  let time = 1000;
  const gate = diagGuard.createDiagnosticGate({ limit: 2, windowMs: 100, maxConcurrent: 1, now: () => time });
  const first = gate.enter('cliente');
  first.release();
  const second = gate.enter('cliente');
  second.release();
  assert.equal(gate.enter('cliente').status, 429);
  time += 101;
  assert.equal(gate.enter('cliente').ok, true);
});
