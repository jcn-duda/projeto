// --- Complemento relaxado do pool seeds (caso real The Rejuvenator, 1988) ---
//
// A régua TS (`pickSeedsPool`, de `autofetch-seeds-pool.ts`) e a métrica
// `autofetch.top-seeded-relaxed` saíram na leva B4 (2026-10-28). Quem decide é
// `adom-core::autofetch_seeds_pick`, consumido pelo MESMO lote napi que o
// runner usava (`decideAutofetch`) — o oráculo do `applyDebrid` continua
// medindo a decisão do NÚCLEO, nunca uma cópia dela.
//
// Regra (dois regimes):
// - estrito VAZIO   ⇒ o relaxado preenche a capacidade TOTAL (imediatos + fila);
// - estrito PARCIAL ⇒ o relaxado completa só as vagas IMEDIATAS que faltam.
// O estrito vem primeiro (swarm decrescente) e o relaxado nunca repete hash.
//
// O QUE ESTE ARQUIVO NÃO MEDE MAIS, e quem assume:
// - a FILA persistente e o excedente relaxado (`autofetch.readQueue`): o
//   escritor único de `autofetch:v3:q:` é o nativo — o oráculo devolve a lista
//   escolhida e a contagem de disparos, nunca a fila
//   (`helpers/pipeline-oracle/autofetch-bridge.ts`);
// - a capacidade (`slotLimit`)/escolha dentro do lote: `cargo test -p adom-core
//   autofetch_seeds_pick` (`complemento_relaxado_preenche_vagas`) e o lote
//   unitário em `autofetch-seeds-rare-viable.test.ts` (`pick.queue` incluído).
//
// Sobra a superfície viva do disparo congelado: QUAIS hashes saem, em que ordem,
// a contagem `autofetchCount` desta busca e o hold tomado ANTES da checagem de
// cache (invariante 6 — autofetch × dropUncached).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import { kvForget } from '../src/utils/native-kv.js';
import * as metrics from '../src/utils/metrics.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import { applyDebrid } from './helpers/pipeline-oracle/index.js';
import type { DebridAdapter } from '../types/domain.js';

const counter = (key: string) => metrics.snapshot().counters[key] || 0;
const deltaOf = (key: string) => {
  const before = counter(key);
  return () => counter(key) - before;
};

const LIVE_KNOBS = { autoFetchMinSeeders: 3, autoFetchTopSeedsMax: 2, autoFetchQueueDepth: 0 };
// Política seeds da Fase 1: tamanho desconhecido é recusado. Os fixtures destes
// testes exercitam swarm/seeders, então recebem um tamanho dentro do teto.
const withSize = (s: any) => ({ ...s, _size: 2 * 1024 ** 3 });

function seedsHarness(key: string) {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope(key);
  const enqueued: string[] = [];
  const counts: number[] = [];
  pmAdapter.enqueue = async (_apiKey: any, infoHash: any) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: key,
    debridCachedOnly: true,
    // Seeds exige instalação que aceite não-dublado (`d` desligado).
    dubbedOnly: false,
    autoFetchBr: true,
  };
  return {
    account, enqueued,
    searchKey: `busca-${key}`,
    run: (fn: () => unknown) => runtime.run({ opts: userOpts, encoded: `cfg-${key}` }, fn),
    /** `autofetchCount` do último `onCacheResult`: disparos desta busca. */
    dispatchCount: () => (counts.length ? counts[counts.length - 1] : 0),
    onCacheResult: (r: { autofetchCount?: number }) => {
      if (typeof r.autofetchCount === 'number') counts.push(r.autofetchCount);
    },
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
    kvForget(autofetch.markerKey('premiumize', harness.account, h));
    held.release(h, harness.account);
  }
};

// Os testes do complemento usam 1-3 candidatos — todos seriam "título raro".
// O regime raro fica DESLIGADO neste arquivo (cada arquivo roda em processo
// próprio); ele tem testes dedicados em autofetch-seeds-rare.test.ts.
config.debrid.autoFetchRareThreshold = 0;

test('seeds: pool estrito cheio nao complementa com relaxado', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  const harness = seedsHarness('seeds-strict-full');
  const h4 = '1'.repeat(40);
  const h5 = '2'.repeat(40);
  const h1seed = '3'.repeat(40);
  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const dEnqueued = deltaOf('autofetch.enqueued');
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'Strict Full 1988 DVDRip', title: 'Strict Full 1988 DVDRip', _seeders: 4 },
          { infoHash: h5, name: 'Strict Full 1988 720p WEBRip', title: 'Strict Full 1988 720p WEBRip', _seeders: 5 },
          { infoHash: h1seed, name: 'Strict Full 1988 VHSRip', title: 'Strict Full 1988 VHSRip', _seeders: 1 },
        ].map(withSize),
        { searchKey: harness.searchKey, onCacheResult: harness.onCacheResult } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(harness.enqueued, [h5, h4], 'os dois estritos enchem o max=2 (swarm decrescente)');
    assert.equal(harness.dispatchCount(), 2, 'autofetchCount = disparos desta busca');
    assert.equal(dEnqueued(), 2, 'autofetch.enqueued conta cada aceite');
    assert.equal(held.isHeld(h1seed, harness.account), false, 'o 1-seeder nem chega a receber hold');
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
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'The Rejuvenator 1988 Rejuvenatrix DVDrip', title: 'The Rejuvenator 1988 Rejuvenatrix DVDrip', _seeders: 4 },
          { infoHash: h1seed, name: 'The Rejuvenator 1988 VHSRip', title: 'The Rejuvenator 1988 VHSRip', _seeders: 1 },
        ].map(withSize),
        { searchKey: harness.searchKey, onCacheResult: harness.onCacheResult } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      harness.enqueued,
      [h4, h1seed],
      'vaga restante ate max=2 e completada com o 1-seeder, estrito primeiro',
    );
    assert.equal(harness.dispatchCount(), 2, 'dois disparos nesta busca');
    // Invariante 6: o hold é tomado ANTES da checagem de cache e só sai no
    // colapso — os dois hashes em voo ficam protegidos do dropUncached.
    assert.equal(held.isHeld(h4, harness.account), true, 'hold do estrito retido (download em voo)');
    assert.equal(held.isHeld(h1seed, harness.account), true, 'hold do complemento retido também');
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
    await harness.run(() =>
      applyDebrid(
        [
          // Unico candidato: estrito E topo do pick relaxado — o mesmo hash
          // NAO pode ocupar duas vagas nem ser enfileirado duas vezes.
          { infoHash: h4, name: 'Dedupe Case 1988 DVDrip', title: 'Dedupe Case 1988 DVDrip', _seeders: 4 },
        ].map(withSize),
        { searchKey: harness.searchKey, onCacheResult: harness.onCacheResult } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(harness.enqueued, [h4], 'hash do estrito nao reaparece como complemento');
    assert.equal(harness.dispatchCount(), 1, 'um unico disparo');
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
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'Max One 1988 DVDrip', title: 'Max One 1988 DVDrip', _seeders: 4 },
          { infoHash: h1seed, name: 'Max One 1988 VHSRip', title: 'Max One 1988 VHSRip', _seeders: 1 },
        ].map(withSize),
        { searchKey: harness.searchKey, onCacheResult: harness.onCacheResult } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(harness.enqueued, [h4], 'com max=1 o estrito esgota as vagas: sem complemento');
    assert.equal(held.isHeld(h1seed, harness.account), false, 'relaxado descartado nem recebe hold');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [h4, h1seed]);
  }
});

// Estrito VAZIO: o relaxado preenche a capacidade TOTAL (imediatos + fila). O
// que o oráculo vê são os imediatos — o excedente que desce para a fila é do
// escritor nativo (ver cabeçalho).
test('seeds: estrito vazio preenche as vagas imediatas com o relaxado', async () => {
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
    await harness.run(() =>
      applyDebrid(
        [
          // Pool estrito VAZIO (todos abaixo do piso 3): o relaxado preenche.
          { infoHash: s1, name: 'Queue Fill 1988 VHSRip A', title: 'Queue Fill 1988 VHSRip A', _seeders: 1 },
          { infoHash: s2, name: 'Queue Fill 1988 VHSRip B', title: 'Queue Fill 1988 VHSRip B', _seeders: 2 },
          { infoHash: s3, name: 'Queue Fill 1988 VHSRip C', title: 'Queue Fill 1988 VHSRip C', _seeders: 1 },
        ].map(withSize),
        { searchKey: harness.searchKey, onCacheResult: harness.onCacheResult } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    // max=2 imediatos: só os dois melhores swarms saem NESTA busca.
    assert.equal(harness.enqueued.length, 2, 'dois imediatos conforme autoFetchTopSeedsMax');
    assert.equal(new Set(harness.enqueued).size, 2, 'nenhum hash duplicado entre os imediatos');
    assert.ok(harness.enqueued.includes(s2), 'o maior swarm do pool relaxado entra');
    assert.ok(harness.enqueued.length <= 4, 'nao ultrapassa o seedsLimit (max 2 + queueDepth 2)');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [s1, s2, s3]);
  }
});

// Regime strict PARCIAL: o complemento preenche SOMENTE as vagas imediatas que
// faltam até autoFetchTopSeedsMax — a profundidade da fila não entra (fila
// relaxada só existe no strict vazio).
test('seeds: strict parcial completa so vagas imediatas, nao usa a profundidade da fila', async () => {
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
    await harness.run(() =>
      applyDebrid(
        [
          { infoHash: h4, name: 'Partial Case 1988 DVDrip', title: 'Partial Case 1988 DVDrip', _seeders: 4 },
          { infoHash: w1, name: 'Partial Case 1988 VHSRip A', title: 'Partial Case 1988 VHSRip A', _seeders: 1 },
          { infoHash: w2, name: 'Partial Case 1988 VHSRip B', title: 'Partial Case 1988 VHSRip B', _seeders: 2 },
        ].map(withSize),
        { searchKey: harness.searchKey, onCacheResult: harness.onCacheResult } as any,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    // max=2: strict (4 seeds) + UM relaxado, o de MAIOR swarm (w2). O segundo
    // fraco não vira imediato nem ocupa vaga de fila aqui.
    assert.deepEqual(harness.enqueued, [h4, w2], 'estrito + o relaxado de maior swarm');
    assert.equal(harness.dispatchCount(), 2, 'queueDepth=2 nao infla os imediatos');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    releaseAll(harness, [h4, w1, w2]);
  }
});
