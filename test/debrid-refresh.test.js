const { test } = require('node:test');
const assert = require('node:assert');

process.env.CACHE_PERSIST = 'false';

const runtime = require('../src/runtime');
const { applyDebrid, debridRefreshSatisfied } = require('../src/providers');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const stream = (infoHash) => ({ infoHash, name: 'Release 1080p', title: 'Release 1080p' });

/**
 * O bug em produção: nenhum stream ganhava ⚡ na AllDebrid, e a lista sem raio
 * era cacheada como completa por CACHE_TTL. Duas metades, testadas separadas —
 * quem PRODUZ o pedido de refresh e quem o CONSOME.
 */

// --- Metade 1: o passo de resposta não pergunta à AllDebrid, e sinaliza isso.

test('AllDebrid no passo de resposta degrada sem rede e pede refresh', async () => {
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-que-nunca-sai-do-processo',
  };

  // A chave é falsa de propósito: se a checagem escapasse pra rede, o teste
  // pararia de ser determinístico — e é justamente o "não foi à rede" que se
  // quer provar. Um fetch dublado que explode denuncia a regressão.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('a checagem da AllDebrid não pode tocar a rede no passo de resposta');
  };

  let flag = null;
  try {
    const result = await runtime.run({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        deadlineAt: Date.now() + 5000, // teto ativo = passo de resposta
        onCacheResult: (res) => {
          flag = res.needsFullRefresh;
        },
      }),
    );

    // Sem resposta confiável ninguém pode receber ⚡: "não perguntei" não é
    // "não tem". Os dois saem como download.
    assert.equal(result.length, 2);
    for (const s of result) assert.match(s.name, /\[AD download\]/);
    assert.ok(!result.some((s) => s.name.includes('⚡')));

    // E o pedido de refresh precisa sair marcado, senão o ⚡ nunca se recupera.
    assert.equal(flag, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Metade 2: quem consome o pedido. Era aqui que ele morria.

test('lista promovida pelo passe tardio ainda precisa do refresh', () => {
  // O passe tardio fecha a coleta e marca partial:false SEM refazer a checagem.
  // Tratar isso como "já processado" foi o que matou o ⚡ na AllDebrid.
  assert.equal(
    debridRefreshSatisfied({ streams: [stream(A)], partial: false, debridKnown: false }),
    false,
  );
});

test('lista reconstruída com checagem confiável dispensa o refresh', () => {
  // Esse é o único caso em que repetir a consulta é desperdício — e, na
  // AllDebrid, um upload a mais na conta do usuário.
  assert.equal(
    debridRefreshSatisfied({ streams: [stream(A)], partial: false, debridKnown: true }),
    true,
  );
});

test('entrada antiga, sem o campo, paga uma checagem e se corrige', () => {
  // O cache em SQLite sobrevive ao deploy: as entradas gravadas antes deste
  // campo não têm `debridKnown`. Elas devem cair no refresh (uma vez), não ser
  // confundidas com lista já checada.
  assert.equal(debridRefreshSatisfied({ streams: [stream(A)], partial: false }), false);
});

test('lista parcial nunca dispensa o refresh', () => {
  assert.equal(
    debridRefreshSatisfied({ streams: [stream(A)], partial: true, debridKnown: true }),
    false,
  );
});

test('ausência de entrada não dispensa o refresh', () => {
  // cache.get devolve undefined quando a entrada expirou entre a resposta e o
  // setImmediate; nesse caso refazer é o certo.
  assert.equal(debridRefreshSatisfied(undefined), false);
  assert.equal(debridRefreshSatisfied(null), false);
});
