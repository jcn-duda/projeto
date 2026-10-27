// BR-gap: lacuna de dublado no índice coberto por pool. O índice guarda
// releases globais que fazem `idxPoolCovered` devolver true e a busca se serve
// do índice — o dublado BR fica inalcançável salvo que o colhedor NATIVO do
// gateway o busque em background. Este arquivo cobre só o que sobrou no Node:
// o predicado puro e o invalidador exato de streams por obra (a próxima
// request reflete o índice sem afetar outras obras).
//
// A FILA (`harvest:v1:q`), o dedupe, a promoção de motivo e a prioridade são do
// `adom-harvest` (Rust) — cobertos por `cargo test -p adom-harvest`; a decisão
// do gap e a transição de faixa, por `adom-core::br_gap`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { prefix } from '../src/utils/cache-keys.js';
import { hasBrDubbed, invalidateStreamsForObra } from '../src/utils/br-gap.js';
import { flushNativeStreamStores } from '../src/utils/streams-store-native.js';
import { createStreamsBridge } from './helpers/streams-bridge.js';

// --- Predicado: release "BR dublado comprovado" (isBr && dubbed && !lied) ---

test('hasBrDubbed: BR dublado comprovado retorna true', () => {
  assert.equal(hasBrDubbed([{ isBr: true, dubbed: true, lied: false } as any]), true);
});

test('hasBrDubbed: release condenada pela auditoria (_lied) NÃO conta', () => {
  // O post prometia PT mas era EN: não é acervo BR ao qual prometer cobertura.
  assert.equal(hasBrDubbed([{ isBr: true, dubbed: true, lied: true } as any]), false);
});

test('hasBrDubbed: não-BR ou sem dublado não conta', () => {
  assert.equal(hasBrDubbed([{ isBr: false, dubbed: true } as any]), false, 'gringo não é BR');
  assert.equal(hasBrDubbed([{ isBr: true, dubbed: false } as any]), false, 'legendado não cobre dublado');
  assert.equal(hasBrDubbed([]), false);
  assert.equal(hasBrDubbed(null), false);
});

// --- Invalidador por obra: pedido à ponte do `streams.db` ------------------
function entry(key: string, id: string, type: 'movie' | 'series' = 'movie') {
  return { type, id, key: `${prefix('streams')}${key}`, cache: { partial: false } };
}

test('invalidateStreamsForObra pede a invalidação da obra e só ela', async () => {
  // `streams` é Rust-owned (F4.2(c)): o recorte por obra acontece no
  // `streams.db` do gateway. A ponte dublada é o caminho real do teste.
  const bridge = createStreamsBridge({
    entries: [
      entry('movie:tt9000101:{}:account:a', 'tt9000101'),
      entry('series:tt9000101:S2:E5:{}:account:b', 'tt9000101:2:5', 'series'),
      entry('series:tt9000101:S2:{}:account:a', 'tt9000101:2', 'series'),
      entry('movie:tt9000102:{}:account:a', 'tt9000102'),
      entry('movie:tt9000103:{}:account:b', 'tt9000103'),
    ],
  });
  try {
    assert.equal(invalidateStreamsForObra('tt9000101'), true, 'o pedido foi enfileirado');
    await flushNativeStreamStores();
    assert.equal(bridge.size(), 2, 'só as 3 chaves de tt9000101 caíram (filme + episódio + temporada)');
    assert.equal(bridge.has(`${prefix('streams')}movie:tt9000101:{}:account:a`), false);
    assert.equal(bridge.has(`${prefix('streams')}series:tt9000101:S2:E5:{}:account:b`), false);
    assert.equal(bridge.has(`${prefix('streams')}series:tt9000101:S2:{}:account:a`), false);

    assert.equal(bridge.has(`${prefix('streams')}movie:tt9000102:{}:account:a`), true, 'outra obra intacta');
    assert.equal(bridge.has(`${prefix('streams')}movie:tt9000103:{}:account:b`), true, 'outra obra intacta');
  } finally {
    bridge.restore();
  }
});

test('invalidateStreamsForObra manda o imdbId EXATO (sem colidir com prefixo)', async () => {
  const bridge = createStreamsBridge({
    entries: [entry('movie:tt9000101:{}:account:a', 'tt9000101')],
  });
  try {
    // tt90001 NÃO é tt9000101: o payload leva o id curto e o Rust não acha a obra longa.
    assert.equal(invalidateStreamsForObra('tt90001'), true);
    await flushNativeStreamStores();
    assert.deepEqual(JSON.parse(String(bridge.calls.at(-1)?.options?.body)), { imdbId: 'tt90001' });
    assert.equal(bridge.size(), 1, 'a obra longa continua no store');
  } finally {
    bridge.restore();
  }
});

test('invalidateStreamsForObra ignora imdbId inválido sem tocar a ponte', async () => {
  const bridge = createStreamsBridge();
  try {
    assert.equal(invalidateStreamsForObra('abc'), false);
    assert.equal(invalidateStreamsForObra(''), false);
    assert.equal(bridge.calls.length, 0, 'id fora do contrato não vira pedido');
  } finally {
    bridge.restore();
  }
});
