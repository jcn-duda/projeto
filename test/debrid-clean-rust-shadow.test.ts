// Decisão de limpeza: as 8 combinações e a sombra que não apaga a mais.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { installDebridCleanHook, resetDebridCleanHook, mayDeleteHash } = await import('../src/utils/rust-debrid-clean.js');

const saved = config.rustDebrid.clean;

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.rustDebrid.clean = 'off';
  resetDebridCleanHook();
});

after(() => {
  config.rustDebrid.clean = saved;
  rustCore.setCoreForTest(null);
  resetDebridCleanHook();
});

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

test('shadow conta divergência e a recusa do Node continua valendo', () => {
  config.rustDebrid.clean = 'shadow';
  installDebridCleanHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    debridMayDelete: () => true,
  });
  const facts = { inventoryLoaded: false, knownBefore: false, protected: false };
  assert.equal(mayDeleteHash(facts), false);
  assert.equal(counter('rust.debrid.clean.diff'), 1);
});

test('on não apaga quando o Node recusa, mesmo se o stub autoriza', () => {
  config.rustDebrid.clean = 'on';
  installDebridCleanHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    debridMayDelete: () => true,
  });
  assert.equal(mayDeleteHash({ inventoryLoaded: false, knownBefore: false, protected: false }), false);
  assert.equal(mayDeleteHash({ inventoryLoaded: true, knownBefore: false, protected: false }), true);
});
