import { test } from 'node:test';
import assert from 'node:assert';

// Antes de carregar config.js (que lê o .env real): força segredo vazio para
// o teste não depender da chave do operador da máquina. Em ESM os imports
// estáticos são hoisted, então config.js entra por import dinâmico depois
// destas linhas — senão o segredo real do operador vazaria para os testes.
process.env.DEBRID_API_KEY = '';
process.env.RESOLVE_SECRET = '';

const { signResolve, verifyResolve } = await import('../src/utils/sign.js');
const runtime = await import('../src/runtime.js');

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

test('dica de obra entra na assinatura; sem dica é compatível com URL antiga', () => {
  runtime.run({ opts: { ...runtime.defaults(), debridApiKey: 'chave-do-usuario' }, encoded: 'x' }, () => {
    const hint = JSON.stringify({ n: ['Jornada nas Estrelas', 'Star Trek'], y: 1979 });
    // Sem dica a string assinada é idêntica à antiga: URLs já cacheadas
    // continuam verificando.
    assert.equal(signResolve(HASH, ''), signResolve(HASH, '', ''));
    const sigComDica = signResolve(HASH, '', hint);
    assert.equal(verifyResolve(HASH, '', sigComDica, hint), true);
    // Dica adulterada ou ausente invalida: a escolha do arquivo dentro do
    // pack não pode ser trocada por quem só conhece a URL.
    assert.equal(verifyResolve(HASH, '', sigComDica, ''), false);
    assert.equal(verifyResolve(HASH, '', sigComDica, JSON.stringify({ n: ['Outro'], y: 2000 })), false);
    // Assinatura antiga (sem dica) não verifica quando a URL carrega dica.
    const sigSemDica = signResolve(HASH, '');
    assert.equal(verifyResolve(HASH, '', sigSemDica, hint), false);
    assert.notEqual(sigComDica, sigSemDica);
  });
});

test('flag p (pack) entra na assinatura: {"p":1} difere de sem p', () => {
  runtime.run({ opts: { ...runtime.defaults(), debridApiKey: 'chave-do-usuario' }, encoded: 'x' }, () => {
    const hintBase = { n: ['Jornada nas Estrelas', 'Star Trek'], y: 1979 };
    const hintPack = { ...hintBase, p: 1 };
    const sigBase = signResolve(HASH, '', JSON.stringify(hintBase));
    const sigPack = signResolve(HASH, '', JSON.stringify(hintPack));
    assert.notEqual(sigBase, sigPack, 'assinatura com p:1 deve diferir da sem p');
    // Verificação cruzada: cada uma só valida com a sua dica.
    assert.equal(verifyResolve(HASH, '', sigPack, JSON.stringify(hintPack)), true);
    assert.equal(verifyResolve(HASH, '', sigPack, JSON.stringify(hintBase)), false);
    assert.equal(verifyResolve(HASH, '', sigBase, JSON.stringify(hintPack)), false);
  });
});
