const { test } = require('node:test');
const assert = require('node:assert');

// Antes de carregar config.js (que lê o .env real): força segredo vazio para
// o teste não depender da chave do operador da máquina.
process.env.DEBRID_API_KEY = '';
process.env.RESOLVE_SECRET = '';

const { signResolve, verifyResolve } = require('../src/utils/sign');
const runtime = require('../src/runtime');

const HASH = 'a'.repeat(40);

// O segredo padrão do HMAC é a API key de debrid da requisição corrente
// (AsyncLocalStorage); sem contexto ativo não há o que assinar.
test('sem segredo ativo não assina nem verifica', () => {
  assert.equal(signResolve(HASH), '');
  assert.equal(verifyResolve(HASH, '', 'qualquercoisa'), false);
});

test('round-trip de assinatura com key do usuário', () => {
  runtime.run({ opts: { ...runtime.defaults(), debridApiKey: 'chave-do-usuario' }, encoded: 'x' }, () => {
    const ep = '?s=1&e=2';
    const sig = signResolve(HASH, ep);
    assert.ok(/^[a-f0-9]{64}$/.test(sig));
    assert.equal(verifyResolve(HASH, ep, sig), true);
    // Episódio diferente invalida: a assinatura cobre hash + temporada/episódio.
    assert.equal(verifyResolve(HASH, '', sig), false);
    assert.equal(verifyResolve(HASH, ep, sig.replace(/.$/, '0')), false);
    assert.equal(verifyResolve(HASH, ep, undefined), false);
  });
});

test('hash de outro torrent não passa com a mesma assinatura', () => {
  runtime.run({ opts: { ...runtime.defaults(), debridApiKey: 'chave-do-usuario' }, encoded: 'x' }, () => {
    const sig = signResolve(HASH, '');
    assert.equal(verifyResolve('b'.repeat(40), '', sig), false);
  });
});

test('keys diferentes geram assinaturas diferentes', () => {
  let sigA;
  let sigB;
  runtime.run({ opts: { ...runtime.defaults(), debridApiKey: 'usuario-a' }, encoded: 'x' }, () => {
    sigA = signResolve(HASH, '');
  });
  runtime.run({ opts: { ...runtime.defaults(), debridApiKey: 'usuario-b' }, encoded: 'x' }, () => {
    sigB = signResolve(HASH, '');
  });
  assert.notEqual(sigA, sigB);
});
