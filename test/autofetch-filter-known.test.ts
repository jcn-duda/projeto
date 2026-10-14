// Vaga BR fora do cache e o corte ternário do cachedOnly (known/missHashes):
// o que ocupa as vagas reservadas antes da checagem e o que some dela.
// Extraído de test/autofetch.test.ts (teto 400 linhas).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { uncachedBrHashes, filterKnownCache } from '../src/utils/format.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const stream = (infoHash: any, extra = {}) => ({ infoHash, name: 'Release', ...extra });

test('fontes BR fora do cache ocupam só as vagas reservadas', () => {
  const global = stream(A, { name: 'Prometheus 1080p', _br: false });
  const br1 = stream(B, { name: 'Prometheus Dublado', _br: true, _dubbed: true });
  const br2 = stream(C, { name: 'Prometheus Dual', _br: true, _dubbed: true });

  assert.deepEqual([...uncachedBrHashes([global, br1, br2], new Set(), 1)], [B]);
  assert.deepEqual([...uncachedBrHashes([global, br1, br2], new Set([B]), 2)], [C]);
  assert.deepEqual([...uncachedBrHashes([global, br1], new Set(), 0)], []);
});

test('vaga P2P prefere o dublado e ignora LEGENDADO no topo', () => {
  const legendado = stream(A, { name: 'Prometheus LEGENDADO', _br: true });
  const dublado = stream(B, { name: 'Prometheus Dublado', _br: true, _dubbed: true });

  assert.deepEqual([...uncachedBrHashes([legendado, dublado], new Set(), 1)], [B]);
  assert.deepEqual(
    filterKnownCache([legendado, dublado], new Set(), {
      cachedOnly: true,
      showUncachedBr: true,
      brReservedSlots: 1,
    }).streams.map((item) => item.infoHash),
    [B],
  );
});

test('cachedOnly mantém cacheados e apenas a cota BR fora do cache', () => {
  const globalCached = stream(A, { _br: false });
  const globalUncached = stream(B, { _br: false });
  const brUncached = stream(C, { _br: true, _dubbed: true });
  const out = filterKnownCache(
    [globalCached, globalUncached, brUncached],
    new Set([A]),
    { cachedOnly: true, showUncachedBr: true, brReservedSlots: 1 },
  );

  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, C]);
  assert.deepEqual([...out.visibleBr], [C]);
  assert.deepEqual(
    filterKnownCache([globalCached, brUncached], new Set([A]), {
      cachedOnly: true,
      showUncachedBr: false,
      brReservedSlots: 1,
    }).streams.map((item) => item.infoHash),
    [A],
  );
});

test('BR já cacheado desconta das vagas P2P', () => {
  const brCached = stream(A, { _br: true, _dubbed: true });
  const brUncached = stream(B, { _br: true, _dubbed: true });
  const out = filterKnownCache(
    [brCached, brUncached],
    new Set([A]),
    { cachedOnly: true, showUncachedBr: true, brReservedSlots: 1 },
  );

  assert.deepEqual(out.streams.map((item) => item.infoHash), [A]);
  assert.equal(out.visibleBr.size, 0);
});

test('filterKnownCache ternário: known=true + cachedOnly remove não-cacheados (AllDebrid/Premiumize)', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: true, known: true },
  );
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A]);
});

test('filterKnownCache ternário: known=false + missHashes remove apenas miss confirmado e desconhecido sobrevive', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: true, known: false, missHashes: new Set([C]) },
  );
  // A (cached) e B (desconhecido) sobrevivem; C (miss confirmado) é removido.
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, B]);
});

test('filterKnownCache ternário: known=false sem missHashes não corta nada (AllDebrid/Premiumize quando known=false)', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: true, known: false },
  );
  // Sem missHashes com known=false, nada é cortado
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, B, C]);
});

test('filterKnownCache ternário: cachedOnly=false não corta nada', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: false, known: false, missHashes: new Set([C]) },
  );
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, B, C]);
});

test('filterKnownCache ternário: visibleBr (vaga BR) sobrevive mesmo se constar em missHashes', () => {
  const brMiss = stream(C, { _br: true, _dubbed: true });
  const out = filterKnownCache(
    [brMiss],
    new Set(),
    { cachedOnly: true, showUncachedBr: true, brReservedSlots: 1, known: false, missHashes: new Set([C]) },
  );
  assert.deepEqual(out.streams.map((item) => item.infoHash), [C]);
  assert.deepEqual([...out.visibleBr], [C]);
});
