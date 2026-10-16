// Modo `on` do índice de releases e da seleção do autofetch: o valor do Rust
// é o que vale, o TS é reserva quando o napi lança. Núcleo stub; não carrega
// .node nem sobe o runner (mesmo molde de rust-release-index/rust-autofetch).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { record, lookup } = await import('../src/utils/release-index.js');
const { installReleaseIndexHook, resetReleaseIndexHook } = await import('../src/utils/rust-release-index.js');
const {
  decideAutofetch, observeAutofetch, installAutofetchHook, resetAutofetchHook,
} = await import('../src/utils/rust-autofetch.js');
import type { AutofetchCapture, AutofetchDecisionNapi } from '../src/utils/rust-autofetch.js';

const saved = {
  releaseIndex: config.releaseIndex.enabled,
  indexMode: config.rustReleaseIndex.mode,
  autofetchMode: config.rustAutofetch.mode,
};

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const titles = () => ({ normalizeTitle: (title: string) => title });

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.releaseIndex.enabled = true;
  config.rustReleaseIndex.mode = 'off';
  config.rustAutofetch.mode = 'off';
  resetReleaseIndexHook();
  resetAutofetchHook();
});

after(() => {
  config.releaseIndex.enabled = saved.releaseIndex;
  config.rustReleaseIndex.mode = saved.indexMode;
  config.rustAutofetch.mode = saved.autofetchMode;
  rustCore.setCoreForTest(null);
  resetReleaseIndexHook();
  resetAutofetchHook();
});

// ---------------------------------------------------------------------------
// Índice de releases
// ---------------------------------------------------------------------------

function indexItem(hash: string) {
  return { title: 'Filme Teste BluRay 1080p DUBLADO', infoHash: hash, seeders: 12, indexer: 'testindexer', isBr: true };
}

test('índice on: grava a fonte do Rust e não agenda comparação', async () => {
  config.rustReleaseIndex.mode = 'on';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest({ ...titles(), releaseIndexMediaMerge: () => 'webdl' });
  record('tt9200001', {}, [indexItem('4'.repeat(40))]);
  await flush();
  assert.equal((lookup('tt9200001')[0] as any).mediaSource, 'webdl');
  assert.equal(counter('rust.release_index.calls'), 1);
  assert.equal(counter('rust.release_index.divergence'), 0);
});

test('índice on: napi que lança grava o valor do TS', async () => {
  config.rustReleaseIndex.mode = 'on';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest({ ...titles(), releaseIndexMediaMerge: () => { throw new Error('boom'); } });
  record('tt9200002', {}, [indexItem('5'.repeat(40))]);
  assert.equal((lookup('tt9200002')[0] as any).mediaSource, 'BluRay');
  assert.equal(counter('rust.release_index.error'), 1);
});

test('índice on sem núcleo: TS grava como antes', () => {
  config.rustReleaseIndex.mode = 'on';
  installReleaseIndexHook(() => rustCore.getCore());
  record('tt9200003', {}, [indexItem('6'.repeat(40))]);
  assert.equal((lookup('tt9200003')[0] as any).mediaSource, 'BluRay');
});

// ---------------------------------------------------------------------------
// Seleção do autofetch
// ---------------------------------------------------------------------------

function capture(): Omit<AutofetchCapture, 'pool' | 'immediateHashes' | 'queueEntries'> {
  return {
    streams: [
      { infoHash: 'aaa', title: 'Filme 1988 1080p DUBLADO', _br: true, _dubbed: true, _seeders: 10 },
      { infoHash: 'bbb', title: 'Filme 1988 720p DUBLADO', _br: true, _dubbed: true, _seeders: 5 },
    ],
    season: null,
    queueDepth: 2,
    live: {
      autoFetchMinSeeders: 1,
      autoFetchSeedsPtFirst: true,
      autoFetchMax: 1,
      autoFetchTopSeedsMax: 2,
      autoFetchRareMax: 0,
      autoFetchRareThreshold: 0,
      autoFetchRareMaxSeeders: 0,
      autoFetchAnyDubbed: true,
      autoFetchTopSeeds: true,
    },
    policy: { dubbedOnly: false, cachedOnly: true, maxSizeGb: 0, seedsMaxGb: 0, seedsMaxQuality: '1080p' },
    autoFetchBr: true,
    adapter: { cacheCheck: true },
    seedsBlocked: false,
  };
}

function autofetchStub(decision: AutofetchDecisionNapi | (() => AutofetchDecisionNapi)) {
  return { ...titles(), evaluateAutofetchCandidates: typeof decision === 'function' ? decision : () => decision };
}

test('autofetch off/shadow: decideAutofetch não decide', () => {
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(autofetchStub({ immediates: [], queue: [], skips: [] }));
  assert.equal(decideAutofetch(capture()), null);
  config.rustAutofetch.mode = 'shadow';
  assert.equal(decideAutofetch(capture()), null);
});

test('autofetch on: imediatos e fila vêm do Rust, casados com os streams vivos', () => {
  config.rustAutofetch.mode = 'on';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(autofetchStub({
    immediates: [{ infoHash: 'BBB', pool: 'br', rare: false }],
    queue: [{ infoHash: 'aaa', pool: 'seeds', rare: true, slotLimit: 2 }],
    skips: [],
  }));
  const c = capture();
  const pick = decideAutofetch(c);
  assert.ok(pick);
  assert.equal(pick.immediate.length, 1);
  assert.equal(pick.immediate[0].stream, c.streams[1], 'o mesmo objeto do runner');
  assert.equal(pick.immediate[0].pool, 'br');
  assert.equal(pick.queue[0].stream, c.streams[0]);
  assert.equal(pick.queue[0].pool, 'seeds');
  assert.equal(pick.queue[0].rare, true);
  assert.equal(pick.queue[0].slotLimit, 2);
  assert.equal(counter('rust.autofetch.calls'), 1);
});

test('autofetch on: hash fora da lista viva devolve o controle ao TS', () => {
  config.rustAutofetch.mode = 'on';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(autofetchStub({ immediates: [{ infoHash: 'zzz', pool: 'br', rare: false }], queue: [], skips: [] }));
  assert.equal(decideAutofetch(capture()), null);
  assert.equal(counter('rust.autofetch.error'), 1);
});

test('autofetch on: napi que lança devolve o controle ao TS', () => {
  config.rustAutofetch.mode = 'on';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(autofetchStub(() => { throw new Error('boom'); }));
  assert.equal(decideAutofetch(capture()), null);
  assert.equal(counter('rust.autofetch.error'), 1);
});

test('autofetch on: observeAutofetch não compara (o Rust já decidiu)', async () => {
  config.rustAutofetch.mode = 'on';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(autofetchStub({ immediates: [], queue: [], skips: [] }));
  observeAutofetch({ ...capture(), pool: 'br', immediateHashes: ['aaa'], queueEntries: [] });
  await flush();
  assert.equal(counter('rust.autofetch.calls'), 0);
  assert.equal(counter('rust.autofetch.divergence'), 0);
});
