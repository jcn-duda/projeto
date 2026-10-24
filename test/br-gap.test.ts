// BR-gap: lacuna de dublado no índice coberto por pool. O índice guarda
// releases globais que fazem `idxPoolCovered` devolver true e a busca se serve
// do índice — o dublado BR fica inalcançável salvo que o colhedor NATIVO do
// gateway o busque em background. Este arquivo cobre só o que sobrou no Node:
// os predicados puros, a classificação de transição BR e o invalidador exato de
// streams por obra (a próxima request reflete o índice sem afetar outras obras).
//
// A FILA (`harvest:v1:q`), o dedupe, a promoção de motivo e a prioridade são do
// `adom-harvest` (Rust) — cobertos por `cargo test -p adom-harvest`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { prefix } from '../src/utils/cache-keys.js';
import { hasBrDubbed, hasBrDubbedAtQuality, hasBrDubbedBelowTarget, shouldBrGap, invalidateStreamsForObra, brTransition, BR_GAP_TARGET_QUALITY } from '../src/utils/br-gap.js';
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

// --- Decisão: só com index-only configurados e sem BR no índice ------------

test('shouldBrGap: cobertura sem BR + index-only configurados → verdadeiro', () => {
  assert.equal(shouldBrGap([{ isBr: false, dubbed: false, seeders: 999 } as any], true), true);
});

test('shouldBrGap: sem index-only configurados → falso (não há onde buscar)', () => {
  assert.equal(shouldBrGap([{ isBr: false, dubbed: false, seeders: 999 } as any], false), false);
});

test('shouldBrGap control: BR dublado presente → falso mesmo com index-only', () => {
  // Control com BR presente: a lacuna não existe, nada se enfileira.
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, lied: false } as any], true), false);
});

// --- Upgrade: BR dublado só em faixa inferior conhecida ---------------------

test('shouldBrGap upgrade: BR 720p + index-only → verdadeiro (caso tt0107953)', () => {
  const indexed = [{ isBr: true, dubbed: true, lied: false, quality: '720p' } as any];
  assert.equal(hasBrDubbedBelowTarget(indexed), true);
  assert.equal(shouldBrGap(indexed, true), true, 'upgrade de faixa abre o gap');
});

test('shouldBrGap upgrade: BR 1080p presente fecha o gap', () => {
  const indexed = [
    { isBr: true, dubbed: true, lied: false, quality: '720p' } as any,
    { isBr: true, dubbed: true, lied: false, quality: BR_GAP_TARGET_QUALITY } as any,
  ];
  assert.equal(hasBrDubbedAtQuality(indexed, BR_GAP_TARGET_QUALITY), true);
  assert.equal(shouldBrGap(indexed, true), false, 'a faixa alvo já está coberta');
});

test('shouldBrGap: BR só sem resolução NÃO abre upgrade (sem crawl eterno)', () => {
  // "sem resolução" é "não sei", não faixa inferior provada.
  const indexed = [
    { isBr: true, dubbed: true, lied: false, quality: 'sem resolução' } as any,
    { isBr: true, dubbed: true, quality: undefined } as any,
  ];
  assert.equal(shouldBrGap(indexed, true), false);
});

test('shouldBrGap: BR 2160p sem 1080p não abre upgrade (faixa superior cobre)', () => {
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: '2160p' } as any], true), false);
  assert.equal(shouldBrGap([
    { isBr: true, dubbed: true, quality: '2160p' } as any,
    { isBr: true, dubbed: true, quality: '720p' } as any,
  ], true), false, 'somar 720p não reabre uma lacuna já coberta por 2160p');
});

test('shouldBrGap: SD/480p BR também são faixa inferior que abre upgrade', () => {
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: 'SD' } as any], true), true);
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: '480p' } as any], true), true);
});

test('shouldBrGap upgrade: sem index-only não abre; lied não conta como faixa', () => {
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: '720p' } as any], false), false);
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, lied: true, quality: '720p' } as any], true), true,
    'o mentiroso não prova a faixa 720p, mas também não prova a alvo — gap de ausência permanece');
});

test('hasBrDubbedBelowTarget: release do autofetch não prova faixa (mesmo filtro de hasBrDubbed)', () => {
  assert.equal(hasBrDubbedBelowTarget([{ source: 'autofetch', isBr: true, dubbed: true, quality: '720p' } as any]), false);
  assert.equal(hasBrDubbedAtQuality([{ source: 'autofetch', isBr: true, dubbed: true, quality: '1080p' } as any], '1080p'), false);
});

// --- Transição BR: classificação pura (sem cache) ---------------------------

test('brTransition classifica ganho de BR e upgrade de faixa', () => {
  const br720 = [{ isBr: true, dubbed: true, quality: '720p' } as any];
  const br1080 = [{ isBr: true, dubbed: true, quality: '1080p' } as any];
  assert.equal(brTransition([], br720), 'br', 'sem BR → com BR é transição br');
  assert.equal(brTransition(br720, br1080), 'upgrade', '720p → 1080p é upgrade');
  assert.equal(brTransition(br1080, br1080), 'none', 'alvo já presente não retransiciona');
  assert.equal(brTransition(br720, br720), 'none', 'sem faixa nova não há transição');
  assert.equal(brTransition(br1080, br720), 'none', 'regressão de leitura não transiciona');
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
