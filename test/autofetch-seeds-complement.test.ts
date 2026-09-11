// --- Complemento relaxado do pool seeds (caso real The Rejuvenator, 1988) ---
//
// O pool estrito (minSeeders=3) pode sobreviver PARCIAL e ainda sobrar vaga
// imediata: Lime/1337x com 4 seeders preenchem 1 das 2 vagas de
// autoFetchTopSeedsMax e o VHSRip de 1 seeder ficava de fora porque o
// relaxamento antigo só rodava com o pool VAZIO. Agora: estritos primeiro, e
// as vagas que faltam até autoFetchTopSeedsMax são completadas com
// minSeeders=1 distintos — nunca abaixo de 1, sem duplicar hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import { applyDebrid } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';

const counter = (key: string) => metrics.snapshot().counters[key] || 0;
const deltaOf = (key: string) => {
  const before = counter(key);
  return () => counter(key) - before;
};

const LIVE_KNOBS = { autoFetchMinSeeders: 3, autoFetchTopSeedsMax: 2, autoFetchQueueDepth: 0 };

function seedsHarness(key: string) {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope(key);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey: any, infoHash: any) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: key,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  return {
    account, enqueued,
    searchKey: `busca-${key}`,
    run: (fn: () => unknown) => runtime.run({ opts: userOpts, encoded: `cfg-${key}` }, fn),
    cleanup() {
      debrid.checkCached = originalCheck;
      config.debrid.publicUrl = originalPublicUrl;
      pmAdapter.enqueue = originalEnqueue;
    },
  };
}

const releaseAll = (harness: ReturnType<typeof seedsHarness>, hashes: string[]) => {
  autofetch.releaseSearch(harness.searchKey);
  for (const h of hashes) {
    cache.forget(autofetch.markerKey('premiumize', harness.account, h));
    held.release(h, harness.account);
  }
};

test('seeds: pool estrito cheio nao complementa com relaxado', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  const harness = seedsHarness('seeds-strict-full');
  const h4 = '1'.repeat(40);
  const h5 = '2'.repeat(40);
  const h1seed = '3'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dRelaxed = deltaOf('autofetch.top-seeded-relaxed');
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'Strict Full 1988 DVDRip', title: 'Strict Full 1988 DVDRip', _seeders: 4 },
          { infoHash: h5, name: 'Strict Full 1988 WEBRip', title: 'Strict Full 1988 WEBRip', _seeders: 5 },
          { infoHash: h1seed, name: 'Strict Full 1988 VHSRip', title: 'Strict Full 1988 VHSRip', _seeders: 1 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(harness.enqueued, [h5, h4], 'os dois estritos enchem o max=2');
    assert.equal(dRelaxed(), 0, 'estrito cheio nao incrementa o relaxo');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [h4, h5, h1seed]);
  }
});

test('seeds: pool estrito parcial completa com relaxado distinto (estritos primeiro)', async () => {
  // Caso real: Lime/1337x com 4 seeders (estrito) + VHSRip com 1 (relaxado).
  autofetchLive.set({ ...LIVE_KNOBS });
  const harness = seedsHarness('seeds-strict-partial');
  const h4 = '4'.repeat(40);
  const h1seed = '5'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dRelaxed = deltaOf('autofetch.top-seeded-relaxed');
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'The Rejuvenator 1988 Rejuvenatrix DVDrip', title: 'The Rejuvenator 1988 Rejuvenatrix DVDrip', _seeders: 4 },
          { infoHash: h1seed, name: 'The Rejuvenator 1988 VHSRip', title: 'The Rejuvenator 1988 VHSRip', _seeders: 1 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      harness.enqueued,
      [h4, h1seed],
      'vaga restante ate max=2 e completada com o 1-seeder, estrito primeiro',
    );
    assert.equal(dRelaxed(), 1, 'complemento relaxado fica mensurado');
    assert.equal(counter('autofetch.top-seeded-relaxed.added') >= 1, true, 'total de adicionados mensurado');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [h4, h1seed]);
  }
});

test('seeds: complemento relaxado nao duplica hash do pool estrito', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  const harness = seedsHarness('seeds-relax-dedupe');
  const h4 = '6'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dRelaxed = deltaOf('autofetch.top-seeded-relaxed');
    await harness.run(() =>
      applyDebrid(
        [
          // Unico candidato: estrito E topo do pick relaxado — o mesmo hash
          // NAO pode ocupar duas vagas nem ser enfileirado duas vezes.
          { infoHash: h4, name: 'Dedupe Case 1988 DVDrip', title: 'Dedupe Case 1988 DVDrip', _seeders: 4 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(harness.enqueued, [h4], 'hash do estrito nao reaparece como complemento');
    assert.equal(dRelaxed(), 0, 'sem candidato novo nao ha relaxo');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [h4]);
  }
});

test('seeds: autoFetchTopSeedsMax=1 preserva o comportamento antigo', async () => {
  autofetchLive.set({ ...LIVE_KNOBS, autoFetchTopSeedsMax: 1 });
  const harness = seedsHarness('seeds-relax-max1');
  const h4 = '7'.repeat(40);
  const h1seed = '8'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dRelaxed = deltaOf('autofetch.top-seeded-relaxed');
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'Max One 1988 DVDrip', title: 'Max One 1988 DVDrip', _seeders: 4 },
          { infoHash: h1seed, name: 'Max One 1988 VHSRip', title: 'Max One 1988 VHSRip', _seeders: 1 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(harness.enqueued, [h4], 'com max=1 o estrito esgota as vagas: sem complemento');
    assert.equal(dRelaxed(), 0, 'max=1 nao dispara o relaxo');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [h4, h1seed]);
  }
});

// Regressao de integracao: o fallback antigo, com o pool estrito VAZIO,
// preenchia seedsLimit = autoFetchTopSeedsMax + queueDepth e preservava os
// excedentes na fila persistente. O complemento novo limitava aos imediatos
// e apagava silenciosamente a fila relaxada com queueDepth > 0. A capacidade
// do complemento e a TOTAL (imediatos + fila), estritos primeiro.
test('seeds: complemento relaxado ocupa imediatos E a fila ate seedsLimit', async () => {
  autofetchLive.set({
    ...LIVE_KNOBS,
    autoFetchQueue: true,
    autoFetchQueueDepth: 2,
  });
  const harness = seedsHarness('seeds-relax-queue');
  const s1 = '9'.repeat(40);
  const s2 = '0'.repeat(40);
  const s3 = 'b'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dRelaxed = deltaOf('autofetch.top-seeded-relaxed');
    await harness.run(() =>
      applyDebrid(
        [
          // Pool estrito VAZIO (todos abaixo do piso 3): o fallback relaxado
          // antigo enfileirava ate seedsLimit=4 e a fila guardava o resto.
          { infoHash: s1, name: 'Queue Fill 1988 VHSRip A', title: 'Queue Fill 1988 VHSRip A', _seeders: 1 },
          { infoHash: s2, name: 'Queue Fill 1988 VHSRip B', title: 'Queue Fill 1988 VHSRip B', _seeders: 2 },
          { infoHash: s3, name: 'Queue Fill 1988 VHSRip C', title: 'Queue Fill 1988 VHSRip C', _seeders: 1 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    // max=2 imediatos + fila: TODOS os 3 relaxados cabem em seedsLimit=4.
    assert.equal(harness.enqueued.length, 2, 'dois imediatos conforme autoFetchTopSeedsMax');
    assert.equal(dRelaxed(), 1, 'fallback relaxado fica mensurado');
    const queue = autofetch.readQueue(harness.searchKey);
    assert.equal(queue.length, 1, 'o excedente vai para a fila, nao e descartado');
    const all = [...harness.enqueued, ...queue.map((q: any) => String(q.infoHash).toLowerCase())];
    assert.equal(new Set(all).size, all.length, 'nenhum hash duplicado entre imediatos e fila');
    assert.ok(all.length <= 4, 'nao ultrapassa seedsLimit (max 2 + queueDepth 2)');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    autofetch.dropQueue(harness.searchKey);
    releaseAll(harness, [s1, s2, s3]);
  }
});
// Regime strict PARCIAL: o complemento preenche SOMENTE as vagas imediatas
// que faltam ate autoFetchTopSeedsMax — a fila persistente nao recebe lote de
// candidatos fracos num caso comum (fila relaxada so existe no strict vazio).
test('seeds: strict parcial completa so vagas imediatas, nao enche a fila fraca', async () => {
  autofetchLive.set({
    ...LIVE_KNOBS,
    autoFetchQueue: true,
    autoFetchQueueDepth: 2,
  });
  const harness = seedsHarness('seeds-partial-noqueue');
  const h4 = 'c'.repeat(40);
  const w1 = 'd'.repeat(40);
  const w2 = 'e'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dRelaxed = deltaOf('autofetch.top-seeded-relaxed');
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'Partial Case 1988 DVDrip', title: 'Partial Case 1988 DVDrip', _seeders: 4 },
          { infoHash: w1, name: 'Partial Case 1988 VHSRip A', title: 'Partial Case 1988 VHSRip A', _seeders: 1 },
          { infoHash: w2, name: 'Partial Case 1988 VHSRip B', title: 'Partial Case 1988 VHSRip B', _seeders: 2 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    // max=2: strict (4 seeds) + UM relaxado. O segundo fraco NAO vai para a
    // fila — queueDepth=2 so cria capacidade no strict VAZIO.
    // O relaxado escolhido e o de MAIOR swarm entre os fracos (w2, 2 seeders).
    assert.deepEqual(harness.enqueued, [h4, w2]);
    assert.equal(dRelaxed(), 1, 'complemento imediato fica mensurado');
    assert.equal(autofetch.readQueue(harness.searchKey).length, 0, 'fila fraca nao e criada no strict parcial');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    autofetch.dropQueue(harness.searchKey);
    releaseAll(harness, [h4, w1, w2]);
  }
});

// O runner passa o queueDepth EFETIVO (0 com a fila desligada): com
// autoFetchQueue=false, autoFetchQueueDepth=NAO cria capacidade nenhuma — o
// fallback relaxado fica limitado ao autoFetchTopSeedsMax.
test('seeds: queue off nao cria capacidade de fallback relaxado', async () => {
  autofetchLive.set({
    ...LIVE_KNOBS,
    autoFetchQueue: false,
    autoFetchQueueDepth: 2,
  });
  const harness = seedsHarness('seeds-queue-off');
  const s1 = 'f'.repeat(40);
  const s2h = '1'.repeat(40);
  const s3 = '2'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    await harness.run(() =>
      applyDebrid(
        [
          // Strict vazio (todos 1-2 seeders): sem fila, seedsLimit = max = 2.
          { infoHash: s1, name: 'Queue Off 1988 VHSRip A', title: 'Queue Off 1988 VHSRip A', _seeders: 1 },
          { infoHash: s2h, name: 'Queue Off 1988 VHSRip B', title: 'Queue Off 1988 VHSRip B', _seeders: 2 },
          { infoHash: s3, name: 'Queue Off 1988 VHSRip C', title: 'Queue Off 1988 VHSRip C', _seeders: 1 },
        ],
        { searchKey: harness.searchKey } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(harness.enqueued.length, 2, 'queueDepth ignorado com a fila desligada');
    assert.equal(autofetch.readQueue(harness.searchKey).length, 0, 'fila desligada nao guarda candidato');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    autofetch.dropQueue(harness.searchKey);
    releaseAll(harness, [s1, s2h, s3]);
  }
});