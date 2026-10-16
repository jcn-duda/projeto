// Decisão de limpeza (Rust): só apaga com inventário carregado, hash que não
// era do usuário e sem proteção do autofetch — as 8 combinações.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const { mayDeleteHash } = await import('../src/utils/rust-debrid-clean.js');

test('só apaga com inventário carregado, hash novo e sem proteção', () => {
  const bits = [false, true];
  for (const inventoryLoaded of bits) {
    for (const knownBefore of bits) {
      for (const protectedHash of bits) {
        const expect = inventoryLoaded && !knownBefore && !protectedHash;
        assert.equal(mayDeleteHash({ inventoryLoaded, knownBefore, protected: protectedHash }), expect);
      }
    }
  }
});
