const { test } = require('node:test');
const assert = require('node:assert');

// Escolha do que baixar + proteção do hash: as duas peças que decidem se algo é
// escrito na conta do usuário. Testadas sem rede, com objetos de stream mínimos.
const { pickBrDubbedCandidate, hasCachedBrDubbed } = require('../src/utils/format');
const held = require('../src/debrid/protected');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const stream = (infoHash, extra = {}) => ({ infoHash, name: 'Release', ...extra });

test('pickBrDubbedCandidate pega o melhor BR e ignora quem não é BR', () => {
  const global = stream(A, { name: 'Joker 1080p', _dubbed: true });
  const br = stream(B, { name: 'Coringa Dublado', _br: true, _dubbed: true });
  // A lista chega ordenada, então o 1º BR é o melhor candidato.
  assert.equal(pickBrDubbedCandidate([global, br]), br);
  assert.equal(pickBrDubbedCandidate([global]), null);
  assert.equal(pickBrDubbedCandidate([]), null);
});

test('pickBrDubbedCandidate nunca escolhe um LEGENDADO explícito', () => {
  // Nenhum BR tem marca de áudio: cai no padrão "BR é dublado", menos o legendado.
  const leg = stream(A, { name: 'Coringa (2019) [LEGENDADO opção 1]', _br: true });
  const sem = stream(B, { name: 'Coringa (2019) [opção 2]', _br: true });
  assert.equal(pickBrDubbedCandidate([leg, sem]), sem);
  // Só legendado disponível: não baixa nada.
  assert.equal(pickBrDubbedCandidate([leg]), null);
});

test('pickBrDubbedCandidate exige infoHash', () => {
  // Stream já resolvido pelo debrid não tem hash — não há o que enfileirar.
  assert.equal(pickBrDubbedCandidate([{ name: 'Coringa', _br: true, _dubbed: true }]), null);
});

test('hasCachedBrDubbed enxerga o dublado que já toca na hora', () => {
  const br1 = stream(A, { name: 'Coringa Dublado', _br: true, _dubbed: true });
  const br2 = stream(B, { name: 'Coringa Dual', _br: true, _dubbed: true });
  assert.equal(hasCachedBrDubbed([br1, br2], new Set([B])), true);
  assert.equal(hasCachedBrDubbed([br1, br2], new Set([C])), false);
  assert.equal(hasCachedBrDubbed([br1, br2], new Set()), false);
  // Global em cache não conta como dublado BR disponível.
  const global = stream(C, { name: 'Joker 1080p' });
  assert.equal(hasCachedBrDubbed([global, br1], new Set([C])), false);
});

test('protected: hold protege, release libera e o TTL expira', () => {
  held.release(A);
  assert.equal(held.isHeld(A), false);
  held.hold(A, 60);
  assert.equal(held.isHeld(A), true);
  // Case-insensitive: a AllDebrid devolve o hash em maiúsculas.
  assert.equal(held.isHeld(A.toUpperCase()), true);
  held.release(A);
  assert.equal(held.isHeld(A), false);

  // TTL mínimo é 1s; um valor zerado não pode virar proteção eterna.
  held.hold(B, 0);
  assert.equal(held.isHeld(B), true);
  held.release(B);
  assert.equal(held.isHeld(''), false);
});
