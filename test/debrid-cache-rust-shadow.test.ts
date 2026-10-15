// Sombra do veredito de cache com núcleo stub. Não carrega .node nem sobe o addon.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { installDebridCacheHook, resetDebridCacheHook } = await import('../src/utils/rust-debrid-cache.js');
const { normalizeCacheResult } = await import('../src/debrid/cache-check.js');

const saved = config.rustDebrid.cache;
const adapter = { id: 'premiumize' } as never;

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

function titles(): { normalizeTitle(title: string): string } {
  return { normalizeTitle: (title: string) => title };
}

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.rustDebrid.cache = 'off';
  resetDebridCacheHook();
});

after(() => {
  config.rustDebrid.cache = saved;
  rustCore.setCoreForTest(null);
  resetDebridCacheHook();
});

test('sem gancho, o stub não classifica mesmo em shadow', () => {
  config.rustDebrid.cache = 'shadow';
  rustCore.setCoreForTest({
    ...titles(),
    debridCacheVerdict: () => ({ cached: ['zz'], known: false, reason: null, message: null }),
  });
  const verdict = normalizeCacheResult(adapter, new Set(['aa']));
  assert.equal(verdict.known, true);
  assert.equal([...verdict.cached][0], 'aa');
  assert.equal(counter('rust.debrid.cache.calls'), 0);
});

test('shadow: divergência conta e o veredito continua o do TS', () => {
  config.rustDebrid.cache = 'shadow';
  installDebridCacheHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    ...titles(),
    debridCacheVerdict: () => ({ cached: ['zz'], known: false, reason: null, message: null }),
  });
  const verdict = normalizeCacheResult(adapter, new Set(['aa']));
  assert.equal(verdict.known, true);
  assert.equal([...verdict.cached][0], 'aa');
  assert.equal(counter('rust.debrid.cache.diff'), 1);
  assert.equal(counter('rust.debrid.cache.calls'), 1);
});

test('on: a resposta é a do stub e um throw cai no TS', () => {
  config.rustDebrid.cache = 'on';
  installDebridCacheHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    ...titles(),
    debridCacheVerdict: () => ({ cached: ['zz'], known: false, reason: null, message: null }),
  });
  const on = normalizeCacheResult(adapter, new Set(['aa']));
  assert.equal(on.known, false);
  assert.equal([...on.cached][0], 'zz');

  metrics.reset();
  rustCore.setCoreForTest({
    ...titles(),
    debridCacheVerdict: () => { throw new Error('núcleo estourou'); },
  });
  const fallen = normalizeCacheResult(adapter, new Set(['aa']));
  assert.equal(fallen.known, true);
  assert.equal(counter('rust.debrid.cache.error'), 1);
});
