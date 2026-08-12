const { test } = require('node:test');
const assert = require('node:assert');

// Contrato do src/runtime.js para as opções novas do install URL: preferDubbed
// ("a"), excludeCam ("c") e maxSizeGb ("z"). O
// módulo é importável sem subir servidor (diferente de addon.js) e nada aqui
// toca rede — só normalização, clamp e roundtrip do segmento de config.
const config = require('../src/config');
const runtime = require('../src/runtime');

const { SCHEMA, defaults, normalize, encode, decode } = runtime;

test('SCHEMA declara as opções novas com chave curta, tipo e limites', () => {
  assert.deepEqual(SCHEMA.preferDubbed, { type: 'bool', key: 'a' });
  assert.deepEqual(SCHEMA.excludeCam, { type: 'bool', key: 'c' });
  assert.deepEqual(SCHEMA.maxSizeGb, { type: 'int', key: 'z', min: 0, max: 200 });
});

test('defaults() traz preferDubbed/excludeCam falsos e maxSizeGb 0', () => {
  const d = defaults();
  assert.equal(d.preferDubbed, false);
  assert.equal(d.excludeCam, false);
  assert.equal(d.maxSizeGb, 0);
});

test('normalize lê as chaves curtas e ignora chave desconhecida', () => {
  const out = normalize({ a: true, c: true, z: 25, x: 'zzz' });
  assert.equal(out.preferDubbed, true);
  assert.equal(out.excludeCam, true);
  assert.equal(out.maxSizeGb, 25);
  // Chave fora do SCHEMA não vira opção nem derruba a normalização.
  assert.equal('x' in out, false);
  assert.equal(out.maxResults, config.maxResults);
  // null e não-objeto devolvem os defaults sem quebrar.
  assert.deepEqual(normalize(null), defaults());
  assert.deepEqual(normalize('abc'), defaults());
});

test('maxSizeGb (z) trunca e clampa em 0..200; fora do range cai no default', () => {
  assert.equal(normalize({ z: 12.9 }).maxSizeGb, 12);
  assert.equal(normalize({ z: -5 }).maxSizeGb, 0);
  assert.equal(normalize({ z: 999 }).maxSizeGb, 200);
  assert.equal(normalize({ z: 'abc' }).maxSizeGb, 0);
});

test('preferDubbed (a) e excludeCam (c) só são true com valores afirmativos', () => {
  for (const truthy of [true, 1, '1', 'true']) {
    assert.equal(normalize({ a: truthy }).preferDubbed, true);
    assert.equal(normalize({ c: truthy }).excludeCam, true);
  }
  for (const falsy of [false, 0, '0', 'false', '', 'qualquer']) {
    assert.equal(normalize({ a: falsy }).preferDubbed, false);
    assert.equal(normalize({ c: falsy }).excludeCam, false);
  }
});

test('roundtrip encode/decode preserva as opções novas e rejeita segmento inválido', () => {
  const decoded = decode(encode({ a: true, c: false, z: 42 }));
  assert.equal(decoded.preferDubbed, true);
  assert.equal(decoded.excludeCam, false);
  assert.equal(decoded.maxSizeGb, 42);
  // Segmento fora do charset base64url ou vazio não é config.
  assert.equal(decode('@nao-base64url@'), null);
  assert.equal(decode(null), null);
  assert.equal(decode(''), null);
});

test('roundtrip dos defaults é estável', () => {
  // O objeto normalizado já tem as chaves longas; re-encodar e decodificar
  // devolve os mesmos defaults (chaves desconhecidas são ignoradas).
  const d = defaults();
  assert.deepEqual(decode(encode(d)), d);
});
