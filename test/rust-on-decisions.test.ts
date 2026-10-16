// Índice de releases e seleção do autofetch, só em Rust: o valor do núcleo é o
// que vale. Núcleo stub (ou o real); não sobe o runner.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { record, lookup } = await import('../src/utils/release-index.js');
const { decideAutofetch } = await import('../src/utils/rust-autofetch.js');
import type { AutofetchCapture, AutofetchDecisionNapi } from '../src/utils/rust-autofetch.js';

const saved = { releaseIndex: config.releaseIndex.enabled };

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

const titles = () => ({ normalizeTitle: (title: string) => title });

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.releaseIndex.enabled = true;
});

after(() => {
  config.releaseIndex.enabled = saved.releaseIndex;
  rustCore.setCoreForTest(null);
});

// ---------------------------------------------------------------------------
// Índice de releases
// ---------------------------------------------------------------------------

function indexItem(hash: string) {
  return { title: 'Filme Teste BluRay 1080p DUBLADO', infoHash: hash, seeders: 12, indexer: 'testindexer', isBr: true };
}

test('índice: grava a fonte de mídia que o Rust decide', () => {
  rustCore.setCoreForTest({ ...titles(), releaseIndexMediaMerge: () => 'webdl' });
  record('tt9200001', {}, [indexItem('4'.repeat(40))]);
  assert.equal((lookup('tt9200001')[0] as any).mediaSource, 'webdl');
  assert.equal(counter('rust.release_index.calls'), 1);
});

test('índice: núcleo real lê BluRay do título', () => {
  record('tt9200003', {}, [indexItem('6'.repeat(40))]);
  assert.equal((lookup('tt9200003')[0] as any).mediaSource, 'BluRay');
});

// ---------------------------------------------------------------------------
// Seleção do autofetch
// ---------------------------------------------------------------------------

function capture(): AutofetchCapture {
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

test('autofetch: imediatos e fila vêm do Rust, casados com os streams vivos', () => {
  rustCore.setCoreForTest(autofetchStub({
    immediates: [{ infoHash: 'BBB', pool: 'br', rare: false }],
    queue: [{ infoHash: 'aaa', pool: 'seeds', rare: true, slotLimit: 2 }],
    skips: [],
  }));
  const c = capture();
  const pick = decideAutofetch(c);
  assert.equal(pick.immediate.length, 1);
  assert.equal(pick.immediate[0].stream, c.streams[1], 'o mesmo objeto do runner');
  assert.equal(pick.immediate[0].pool, 'br');
  assert.equal(pick.queue[0].stream, c.streams[0]);
  assert.equal(pick.queue[0].pool, 'seeds');
  assert.equal(pick.queue[0].rare, true);
  assert.equal(pick.queue[0].slotLimit, 2);
  assert.equal(counter('rust.autofetch.calls'), 1);
});

test('autofetch: hash fora da lista viva lança (nunca dispara stream desconhecido)', () => {
  rustCore.setCoreForTest(autofetchStub({ immediates: [{ infoHash: 'zzz', pool: 'br', rare: false }], queue: [], skips: [] }));
  assert.throws(() => decideAutofetch(capture()), /fora da lista viva/);
});

test('autofetch: napi que lança propaga o erro', () => {
  rustCore.setCoreForTest(autofetchStub(() => { throw new Error('boom'); }));
  assert.throws(() => decideAutofetch(capture()), /boom/);
});
