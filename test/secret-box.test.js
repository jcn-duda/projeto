const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Cifra da chave de debrid no segmento de config.
 *
 * O contrato que mais importa é o de compatibilidade: ligar o RESOLVE_SECRET
 * não pode invalidar install URL já instalado no Stremio de ninguém.
 */
const config = require('../src/config');
const secretBox = require('../src/utils/secret-box');
const runtime = require('../src/runtime');

const KEY = 'chave-de-debrid-do-usuario';
const SECRET = 'segredo-do-operador';

/** O segredo é lido do config a cada chamada, então dá para trocar em teste. */
function withSecret(secret, fn) {
  const original = config.debrid.resolveSecret;
  config.debrid.resolveSecret = secret;
  try {
    return fn();
  } finally {
    config.debrid.resolveSecret = original;
  }
}

test('sem RESOLVE_SECRET o selo é desligado e nada muda', () => {
  withSecret('', () => {
    assert.equal(secretBox.enabled(), false);
    assert.equal(secretBox.seal(KEY), KEY, 'sem segredo não há o que derivar');
    assert.equal(secretBox.open(KEY), KEY);
  });
});

test('selar e abrir devolve a chave original', () => {
  withSecret(SECRET, () => {
    const sealed = secretBox.seal(KEY);

    assert.equal(secretBox.isSealed(sealed), true);
    assert.equal(sealed.includes(KEY), false, 'a chave não pode aparecer no blob');
    assert.equal(secretBox.open(sealed), KEY);
  });
});

test('o mesmo valor selado duas vezes dá blobs diferentes', () => {
  withSecret(SECRET, () => {
    // IV aleatório por selo: repetir o blob entregaria que duas URLs carregam a
    // MESMA chave, e isso já é informação demais.
    assert.notEqual(secretBox.seal(KEY), secretBox.seal(KEY));
  });
});

test('blob adulterado não vira chave: falha fechada em string vazia', () => {
  withSecret(SECRET, () => {
    const sealed = secretBox.seal(KEY);
    // Vira um caractere do corpo; a tag GCM tem que rejeitar.
    const tampered = sealed.slice(0, -2) + (sealed.slice(-2, -1) === 'A' ? 'B' : 'A') + sealed.slice(-1);

    assert.equal(secretBox.open(tampered), '', 'nunca devolver o blob cru como se fosse a chave');
  });
});

test('selo de outro segredo não abre neste servidor', () => {
  const sealed = withSecret('segredo-antigo', () => secretBox.seal(KEY));

  withSecret('segredo-novo', () => {
    // Cenário real: o operador trocou o RESOLVE_SECRET. O link antigo para de
    // funcionar — o que é o comportamento certo, e não uma chave lixo indo para
    // a API do debrid.
    assert.equal(secretBox.open(sealed), '');
  });
});

test('install URL antigo (chave em texto puro) continua valendo com o selo ligado', () => {
  withSecret(SECRET, () => {
    const legado = runtime.encode({ ds: 'alldebrid', dk: KEY });
    const parsed = runtime.decode(legado);

    // É isto que permite ligar o RESOLVE_SECRET sem quebrar quem já instalou.
    assert.equal(parsed.debridApiKey, KEY);
    assert.equal(parsed.debridService, 'alldebrid');
  });
});

test('sealSegment troca só o dk e o decode devolve a chave em claro', () => {
  withSecret(SECRET, () => {
    const original = runtime.encode({ ds: 'alldebrid', dk: KEY, m: 20, bf: 1 });
    const sealed = runtime.sealSegment(original);

    assert.notEqual(sealed, original);
    const raw = JSON.parse(Buffer.from(sealed, 'base64url').toString('utf8'));
    assert.equal(secretBox.isSealed(raw.dk), true);
    // O resto da configuração atravessa intacto: o segmento é reescrito sem
    // normalizar, senão o link mudaria de significado ao ser selado.
    assert.deepEqual({ ds: raw.ds, m: raw.m, bf: raw.bf }, { ds: 'alldebrid', m: 20, bf: 1 });

    const parsed = runtime.decode(sealed);
    assert.equal(parsed.debridApiKey, KEY);
    assert.equal(parsed.maxResults, 20);
  });
});

test('sealSegment é idempotente e ignora config sem chave', () => {
  withSecret(SECRET, () => {
    const semChave = runtime.encode({ ds: '', m: 10 });
    assert.equal(runtime.sealSegment(semChave), semChave, 'P2P puro não tem o que selar');

    const selado = runtime.sealSegment(runtime.encode({ dk: KEY }));
    assert.equal(runtime.sealSegment(selado), selado, 'selar de novo não pode recifrar');
  });
});

test('sealSegment recusa o que não é um segmento de config', () => {
  withSecret(SECRET, () => {
    assert.equal(runtime.sealSegment(''), null);
    assert.equal(runtime.sealSegment('não é base64url!'), null);
    assert.equal(runtime.sealSegment(Buffer.from('[1,2]', 'utf8').toString('base64url')), null);
    assert.equal(runtime.sealSegment('A'.repeat(runtime.MAX_CONFIG_SEGMENT + 1)), null);
  });
});

test('chave selada na URL sem RESOLVE_SECRET no servidor vira chave vazia', () => {
  const sealed = withSecret(SECRET, () => runtime.encode({ dk: secretBox.seal(KEY) }));

  withSecret('', () => {
    // Modo P2P puro em vez de mandar o blob para a API do debrid a cada busca.
    assert.equal(runtime.decode(sealed).debridApiKey, '');
  });
});
