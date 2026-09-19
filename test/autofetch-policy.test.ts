// Fase 1 do Chupim 2.0 — política do pool `seeds`: decisões intrínsecas do
// candidato e de despacho/dreno. Unidades puras + integração com stub de
// enqueue/checkCached (nenhuma rede real).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import { accountScope } from '../src/utils/request-key.js';
import { autoFetchCandidates, autoFetchBrDubbed } from '../src/providers/autofetch-runner.js';
import { drainNext } from '../src/providers/autofetch-recheck.js';
import { purgeSeedsQueue } from '../src/providers/autofetch-seeds-pool.js';
import {
  decideSeedsStop, effectiveSeedsMaxBytes, filterSeedsUniverse, hasPlayableStream,
  normalizeSeedsMaxQuality, seedsDrainRejection, seedsIntrinsicRejection, seedsSelectionBlock,
} from '../src/providers/autofetch-policy.js';
import type { DebridAdapter } from '../types/domain.js';

const GB = 1024 ** 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const counter = (k: string) => metrics.snapshot().counters[k] || 0;
const deltaOf = (k: string) => { const b = counter(k); return () => counter(k) - b; };
const CFG = { dubbedOnly: false, cachedOnly: true, maxSizeGb: 0, seedsMaxGb: 8, seedsMaxQuality: '1080p' };
const s = (extra: Record<string, unknown> = {}) => ({
  infoHash: 'a'.repeat(40), title: 'Movie 2010 1080p WEB-DL', name: 'Movie 2010 1080p WEB-DL',
  _quality: '1080p', _size: 2 * GB, ...extra,
});
const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
const originalAccountStatus = pmAdapter.accountStatus;

test('seleção: dubbedOnly e lista P2P tocável bloqueiam seeds; aviso não conta', () => {
  assert.equal(seedsSelectionBlock({ dubbedOnly: true, cachedOnly: true }, [s()]), 'dubbed-only');
  assert.equal(seedsSelectionBlock({ dubbedOnly: false, cachedOnly: false }, [s()]), 'seeds-playable');
  assert.equal(seedsSelectionBlock({ dubbedOnly: false, cachedOnly: true }, [s()]), null);
  assert.equal(hasPlayableStream([{ notice: true, externalUrl: 'http://x' }]), false, 'aviso não é play');
  assert.equal(hasPlayableStream([{ url: 'http://play' }]), true);
  assert.equal(hasPlayableStream([{ externalUrl: 'http://external' }]), true);
});

test('parada por cache: knob off para; knob on preserva a exceção Mortuary', () => {
  const base = { hasCachedDubbed: false, cachedCount: 1, rare: true, rareThreshold: 6, adapterCacheCheck: true };
  assert.deepEqual(decideSeedsStop({ ...base, hasCachedDubbed: true, rareOverCached: true }), { stop: 'stop-has-br', rareOverCached: false });
  assert.equal(decideSeedsStop({ hasCachedDubbed: false, cachedCount: 0, rare: true, rareThreshold: 6, adapterCacheCheck: true, rareOverCached: true }).stop, null);
  assert.equal(decideSeedsStop({ ...base, rareOverCached: false }).stop, 'stop-has-cached');
  assert.deepEqual(decideSeedsStop({ ...base, rareOverCached: true }), { stop: null, rareOverCached: true });
  assert.equal(decideSeedsStop({ ...base, rareOverCached: true, adapterCacheCheck: false }).stop, 'stop-has-cached');
  assert.equal(decideSeedsStop({ ...base, rareOverCached: true, rareThreshold: 0 }).stop, 'stop-has-cached');
});

test('intrínseco: 4K/REMUX/BDREMUX/desconhecidos recusados; teto é o menor limite', () => {
  assert.equal(normalizeSeedsMaxQuality('bogus'), '1080p');
  assert.equal(effectiveSeedsMaxBytes({ seedsMaxGb: 8, maxSizeGb: 4 }), 4 * GB);
  assert.equal(effectiveSeedsMaxBytes({ seedsMaxGb: 0, maxSizeGb: 0 }), 0);
  assert.equal(seedsIntrinsicRejection(s({ _quality: '2160p', _size: 60 * GB }), CFG), 'seeds-quality');
  assert.equal(seedsIntrinsicRejection(s({ title: 'Movie 1080p REMUX', _size: 19.8 * GB }), CFG), 'seeds-quality');
  assert.equal(seedsIntrinsicRejection(s({ title: 'Movie 1080p BDREMUX' }), CFG), 'seeds-quality');
  assert.equal(seedsIntrinsicRejection(s({ _quality: undefined, title: 'Rare 1988 Rip' }), CFG), 'seeds-quality');
  assert.equal(seedsIntrinsicRejection(s({ _size: 10 * GB }), CFG), 'seeds-too-big');
  assert.equal(seedsIntrinsicRejection(s({ _size: 6 * GB }), { ...CFG, maxSizeGb: 4 }), 'seeds-too-big');
  assert.equal(seedsIntrinsicRejection(s({ _size: undefined }), CFG), 'seeds-size-unknown');
  assert.equal(seedsIntrinsicRejection(s({ _size: undefined, _packBytes: 3 * GB }), CFG), null);
  assert.equal(seedsIntrinsicRejection(s({ _size: undefined, title: 'Movie 1080p\n💾 3.00 GB' }), CFG), null);
});

test('filtro do universo e revalidação permanente do dreno', () => {
  const { eligible, rejected } = filterSeedsUniverse([
    s(), s({ infoHash: 'b'.repeat(40), _quality: '2160p', _size: 60 * GB }),
    s({ infoHash: 'c'.repeat(40), _size: 20 * GB }),
    s({ infoHash: 'd'.repeat(40), _size: undefined, title: 'No Size 1080p' }),
  ], CFG);
  assert.equal(eligible.length, 1);
  assert.deepEqual([rejected.get('seeds-quality'), rejected.get('seeds-too-big'), rejected.get('seeds-size-unknown')], [1, 1, 1]);
  const bad = { infoHash: 'a'.repeat(40), pool: 'seeds', quality: '1080p', size: 20 * GB };
  assert.equal(seedsDrainRejection(bad, CFG), 'seeds-too-big');
  assert.equal(seedsDrainRejection(bad, { ...CFG, dubbedOnly: true }), 'dubbed-only');
  const semQualidade = { infoHash: 'b'.repeat(40), pool: 'seeds', quality: 'sem resolução', size: 2 * GB };
  const ok = { infoHash: 'c'.repeat(40), pool: 'seeds', quality: '1080p', size: 2 * GB };
  assert.equal(seedsDrainRejection(semQualidade, CFG), 'seeds-quality');
  assert.equal(seedsDrainRejection(ok, CFG), null);
});

// --- Integração: seleção ---

const KEY = 'chave-policy-selecao';
const account = accountScope(KEY);
const selOpts = (extra: Record<string, unknown> = {}) => ({
  ...runtime.defaults(), debridService: 'premiumize', debridApiKey: KEY,
  debridCachedOnly: true, dubbedOnly: false, autoFetchBr: true, ...extra,
});
const selRun = <T>(opts: Record<string, unknown>, fn: () => T): T => runtime.run({ opts, encoded: 'cfg' }, fn);
const LIVE = { autoFetchTopSeeds: true, autoFetchMinSeeders: 1, autoFetchTopSeedsMax: 2, autoFetchRareThreshold: 0, autoFetchQueueDepth: 6 };
const poolOf = (out: any[]) => out.map((c) => String(c.stream.infoHash).toLowerCase());

test.beforeEach(() => {
  autofetchLive.set({ ...LIVE });
  config.debrid.autoFetchRareOverCached = false;
  pmAdapter.accountStatus = async () => ({ magnets: 0 });
});
test.afterEach(() => {
  autofetchLive.reset();
  config.debrid.autoFetchRareOverCached = false;
  pmAdapter.accountStatus = originalAccountStatus;
});

test('tt0107953: 4K 60GB e REMUX 19.8GB recusados; 1080p dentro do teto passa', async () => {
  const [h4k, hRemux, hOk] = ['4'.repeat(40), '5'.repeat(40), '6'.repeat(40)];
  try {
    const dQuality = deltaOf('autofetch.seeds.rejected.seeds-quality');
    const dSkip = deltaOf('autofetch.skip.seeds-quality');
    const out = await selRun(selOpts(), () => autoFetchCandidates([
      { infoHash: h4k, name: 'Mortuary 1983 2160p BluRay', title: 'Mortuary 1983 2160p BluRay', _quality: '2160p', _size: 60 * GB, _seeders: 90 },
      { infoHash: hRemux, name: 'Mortuary 1983 1080p REMUX', title: 'Mortuary 1983 1080p REMUX', _quality: '1080p', _size: 19.8 * GB, _seeders: 80 },
      { infoHash: hOk, name: 'Mortuary 1983 1080p WEB-DL', title: 'Mortuary 1983 1080p WEB-DL', _quality: '1080p', _size: 2 * GB, _seeders: 40 },
    ] as any));
    assert.deepEqual(poolOf(out), [hOk]);
    assert.equal(dQuality(), 2, 'volume do motivo conta os dois recusados');
    assert.equal(dSkip(), 1, 'skip por motivo NÃO é inflado por candidato');
    assert.equal(held.isHeld(h4k, account), false);
    assert.equal(held.isHeld(hRemux, account), false);
  } finally {
    held.release(hOk, account);
  }
});

test('maxSizeGb menor que o teto do pool também recusa', async () => {
  const [hBig, hOk] = ['7'.repeat(40), '8'.repeat(40)];
  try {
    const out = await selRun(selOpts({ maxSizeGb: 4 }), () => autoFetchCandidates([
      { infoHash: hBig, name: 'Movie 1080p', title: 'Movie 1080p', _quality: '1080p', _size: 6 * GB, _seeders: 50 },
      { infoHash: hOk, name: 'Movie 1080p', title: 'Movie 1080p', _quality: '1080p', _size: 3 * GB, _seeders: 40 },
    ] as any));
    assert.deepEqual(poolOf(out), [hOk]);
  } finally {
    held.release(hOk, account);
  }
});

test('d=1 com BR waived não enfileira inglês e conta dubbed-only UMA vez', async () => {
  const hs = ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
  const hBrWaived = 'e'.repeat(40);
  const dDubbed = deltaOf('autofetch.skip.dubbed-only');
  const dNoCandidate = deltaOf('autofetch.skip.no-candidate');
  const out = await selRun(selOpts({ dubbedOnly: true }), () => autoFetchCandidates([
    { infoHash: hBrWaived, name: 'Coringa Dublado 1080p', title: 'Coringa (2019) Dublado 1080p', _br: true, _dubbed: true, _quality: '1080p', _seedFloorWaived: true },
    ...hs.map((h, i) => ({ infoHash: h, name: `Movie 2010 1080p ${i}`, title: `Movie 2010 1080p ${i}`, _quality: '1080p', _size: 2 * GB, _seeders: 90 - i })),
  ] as any));
  assert.deepEqual(out, [], 'instalação dublada não baixa o swarm inglês');
  assert.equal(dDubbed(), 1);
  assert.equal(dNoCandidate(), 0, 'bloqueio explícito não vira no-candidate também');
  for (const h of hs) assert.equal(held.isHeld(h, account), false);
});

// --- Integração: despacho pós-cache e purga da fila ---

const DKEY = 'chave-policy-dispatch';
const dAccount = accountScope(DKEY);
const dOpts = (extra: Record<string, unknown> = {}) => ({
  ...runtime.defaults(), debridService: 'premiumize', debridApiKey: DKEY,
  debridCachedOnly: true, dubbedOnly: false, autoFetchBr: true, ...extra,
});
const marker = (h: string) => autofetch.markerKey('premiumize', dAccount, h);

function stubEnqueue(searchKey: string, hashes: string[]) {
  const original = pmAdapter.enqueue;
  const enqueued: string[] = [];
  for (const h of hashes) {
    cache.forget(marker(h)); // L2 pode ter sobrevivido a execução anterior
    cache.forget(autofetch.deadKey('premiumize', dAccount, h));
    held.release(h, dAccount);
  }
  pmAdapter.enqueue = async (_k, h) => { enqueued.push(h); return true; };
  return {
    enqueued,
    restore() {
      pmAdapter.enqueue = original;
      autofetch.releaseSearch(searchKey);
      autofetch.dropQueue(searchKey);
      for (const h of hashes) { cache.forget(marker(h)); held.release(h, dAccount); }
    },
  };
}

test('despacho: cache conhecido não-dublado para o seeds (knob off) e a fila perde só seeds', async () => {
  autofetchLive.set({ ...LIVE, autoFetchQueue: true, autoFetchRareThreshold: 6 });
  const searchKey = 'busca-policy-stop';
  const [cachedGlobal, seedHash, brHash] = ['c1'.repeat(20), 'c2'.repeat(20), 'c3'.repeat(20)];
  const h = stubEnqueue(searchKey, [cachedGlobal, seedHash, brHash]);
  try {
    autofetch.writeQueue(searchKey, [
      { infoHash: seedHash, pool: 'seeds', title: 'Cold 1080p' },
      { infoHash: brHash, pool: 'br', title: 'BR Dub 1080p' },
    ], 3600, 'premiumize', dAccount);
    const dStop = deltaOf('autofetch.skip.stop-has-cached');
    const streams = [
      { infoHash: cachedGlobal, name: 'Global 1080p', title: 'Global 1080p', _quality: '1080p' },
      { infoHash: seedHash, name: 'Cold 1080p', title: 'Cold 1080p', _quality: '1080p', _size: 2 * GB },
    ];
    const n = await runtime.run({ opts: dOpts(), encoded: 'cfg' }, () => autoFetchBrDubbed(
      streams as any, [{ stream: streams[1] as any, account: dAccount, pool: 'seeds', rare: false }],
      { cached: new Set([cachedGlobal]), known: true, searchKey },
    ));
    assert.equal(n, 0);
    assert.equal(dStop(), 1);
    assert.deepEqual(autofetch.readQueue(searchKey).map((q) => String(q.infoHash).toLowerCase()), [brHash]);
  } finally {
    h.restore();
  }
});

test('despacho: knob rareOverCached ligado preserva a exceção Mortuary', async () => {
  autofetchLive.set({ ...LIVE, autoFetchQueue: false, autoFetchRareThreshold: 6 });
  config.debrid.autoFetchRareOverCached = true;
  const searchKey = 'busca-policy-rare';
  const [cachedGlobal, seedHash] = ['d1'.repeat(20), 'd2'.repeat(20)];
  const h = stubEnqueue(searchKey, [cachedGlobal, seedHash]);
  try {
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    const streams = [
      { infoHash: cachedGlobal, name: 'Global 1080p', title: 'Global 1080p', _quality: '1080p' },
      { infoHash: seedHash, name: 'Cold 720p', title: 'Cold 720p', _quality: '720p', _size: 2 * GB },
    ];
    const n = await runtime.run({ opts: dOpts(), encoded: 'cfg' }, () => autoFetchBrDubbed(
      streams as any, [{ stream: streams[1] as any, account: dAccount, pool: 'seeds', rare: true }],
      { cached: new Set([cachedGlobal]), known: true, searchKey },
    ));
    await sleep(10);
    assert.equal(n, 1);
    assert.equal(dOver(), 1);
    assert.deepEqual(h.enqueued, [seedHash]);
  } finally {
    h.restore();
  }
});

test('despacho: dubbedOnly purga seeds e preserva br', async () => {
  autofetchLive.set({ ...LIVE, autoFetchQueue: true });
  const searchKey = 'busca-policy-dubbed';
  const [seedHash, brHash] = ['e1'.repeat(20), 'e2'.repeat(20)];
  const h = stubEnqueue(searchKey, [seedHash, brHash]);
  try {
    autofetch.writeQueue(searchKey, [
      { infoHash: seedHash, pool: 'seeds', title: 'Cold 1080p' },
      { infoHash: brHash, pool: 'br', title: 'BR Dub 1080p' },
    ], 3600, 'premiumize', dAccount);
    const dDubbed = deltaOf('autofetch.skip.dubbed-only');
    const streams = [{ infoHash: seedHash, name: 'Cold 1080p', title: 'Cold 1080p', _quality: '1080p' }];
    const n = await runtime.run({ opts: dOpts({ dubbedOnly: true }), encoded: 'cfg' }, () => autoFetchBrDubbed(
      streams as any, [{ stream: streams[0] as any, account: dAccount, pool: 'seeds', rare: false }],
      { cached: new Set(), known: true, searchKey },
    ));
    assert.equal(n, 0);
    assert.equal(dDubbed(), 1);
    assert.deepEqual(autofetch.readQueue(searchKey).map((q) => String(q.infoHash).toLowerCase()), [brHash]);
  } finally {
    h.restore();
  }
});

test('purgeSeedsQueue: remove só seeds; modo cached remove só as cacheadas', () => {
  const searchKey = 'busca-policy-purge';
  const [s1, s2, b1] = ['f1'.repeat(20), 'f2'.repeat(20), 'f3'.repeat(20)];
  try {
    autofetch.writeQueue(searchKey, [
      { infoHash: s1, pool: 'seeds' }, { infoHash: s2, pool: 'seeds' }, { infoHash: b1, pool: 'br' },
    ], 3600, 'premiumize', dAccount);
    assert.equal(purgeSeedsQueue(searchKey, { ttl: 3600, adapterId: 'premiumize', account: dAccount, cached: new Set([s1]) }), 1);
    assert.deepEqual(autofetch.readQueue(searchKey).map((q) => String(q.infoHash).toLowerCase()), [s2, b1]);
    assert.equal(purgeSeedsQueue(searchKey, { ttl: 3600, adapterId: 'premiumize', account: dAccount }), 1);
    assert.deepEqual(autofetch.readQueue(searchKey).map((q) => String(q.infoHash).toLowerCase()), [b1]);
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

// --- Integração: dreno revalida regras permanentes ---

test('dreno: seeds fora do teto é descartado; o br seguinte drena', async () => {
  autofetchLive.set({ ...LIVE, autoFetchQueue: true, autoFetchQueueDepth: 6 });
  const original = pmAdapter.enqueue;
  const enqueued: string[] = [];
  const searchKey = 'busca-policy-drain-x';
  const [bigSeed, brHash] = ['a1'.repeat(20), 'a2'.repeat(20)];
  try {
    pmAdapter.enqueue = async (_k, h) => { enqueued.push(h); return true; };
    autofetch.writeQueue(searchKey, [
      { infoHash: bigSeed, pool: 'seeds', quality: '1080p', size: 20 * GB, title: 'Big 1080p' },
      { infoHash: brHash, pool: 'br', quality: '1080p', title: 'BR Dub 1080p' },
    ], 3600, 'premiumize', dAccount);
    autofetch.resetBudget('premiumize', dAccount);
    const dTooBig = deltaOf('autofetch.skip.seeds-too-big');
    await runtime.run({ opts: dOpts(), encoded: 'cfg' }, async () => {
      drainNext(searchKey, { refusals: 0, hashes: new Set(), seasonHints: new Map() });
    });
    await sleep(10);
    assert.deepEqual(enqueued, [brHash]);
    assert.equal(dTooBig(), 1);
    assert.equal(autofetch.readQueue(searchKey).length, 0);
  } finally {
    pmAdapter.enqueue = original;
    autofetch.dropQueue(searchKey);
    for (const h of [bigSeed, brHash]) { cache.forget(marker(h)); held.release(h, dAccount); }
  }
});

test('dreno: dubbedOnly descarta a entrada seeds (regra permanente)', async () => {
  autofetchLive.set({ ...LIVE, autoFetchQueue: true, autoFetchQueueDepth: 6 });
  const original = pmAdapter.enqueue;
  const enqueued: string[] = [];
  const searchKey = 'busca-policy-drain-d';
  const seedHash = 'b1'.repeat(20);
  try {
    pmAdapter.enqueue = async (_k, h) => { enqueued.push(h); return true; };
    autofetch.writeQueue(searchKey, [{ infoHash: seedHash, pool: 'seeds', quality: '1080p', size: 2 * GB }], 3600, 'premiumize', dAccount);
    autofetch.resetBudget('premiumize', dAccount);
    const dDubbed = deltaOf('autofetch.skip.dubbed-only');
    await runtime.run({ opts: dOpts({ dubbedOnly: true }), encoded: 'cfg' }, async () => {
      drainNext(searchKey, { refusals: 0, hashes: new Set(), seasonHints: new Map() });
    });
    await sleep(10);
    assert.deepEqual(enqueued, []);
    assert.equal(dDubbed(), 1);
    assert.equal(autofetch.readQueue(searchKey).length, 0);
  } finally {
    pmAdapter.enqueue = original;
    autofetch.dropQueue(searchKey);
    cache.forget(marker(seedHash));
    held.release(seedHash, dAccount);
  }
});
