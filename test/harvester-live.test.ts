import test from 'node:test';
import assert from 'node:assert/strict';
import * as harvesterLive from '../src/utils/harvester-live.js';

test('harvesterLive: schema expõe os 12 campos esperados', () => {
  const s = harvesterLive.schema();
  assert.equal(s.length, 12);
  const keys = s.map((f) => f.key);
  assert.ok(keys.includes('harvestEnabled'));
  assert.ok(keys.includes('harvestMaxPerHour'));
  assert.ok(keys.includes('harvestIdleWindowMs'));
  assert.ok(keys.includes('harvestIntervalMs'));
  assert.ok(keys.includes('harvestIndexerDelayMs'));
  assert.ok(keys.includes('harvestQueueMax'));
  assert.ok(keys.includes('harvestDrainMaxWorks'));
  assert.ok(keys.includes('harvestEntryTtl'));
  assert.ok(keys.includes('seedEnabled'));
  assert.ok(keys.includes('seedMaxPerCycle'));
  assert.ok(keys.includes('seedMinVotes'));
  assert.ok(keys.includes('seedIntervalH'));
});

test('harvesterLive: clamps numéricos e validação de tipos', () => {
  harvesterLive.reset();

  // Teste de clamps de extremos
  const r1 = harvesterLive.set({
    harvestMaxPerHour: 99999,
    harvestQueueMax: 0,
    harvestDrainMaxWorks: 100,
    seedMaxPerCycle: -5,
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.effective.harvestMaxPerHour, 1000);
  assert.equal(r1.effective.harvestQueueMax, 10);
  assert.equal(r1.effective.harvestDrainMaxWorks, 50);
  assert.equal(r1.effective.seedMaxPerCycle, 1);

  // Teste de chave desconhecida
  const r2 = harvesterLive.set({ chaveInvalida: 123 } as any);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors && r2.errors.length > 0);

  // Teste de tipo inválido para boolean
  const r3 = harvesterLive.set({ harvestEnabled: 'talvez' } as any);
  assert.equal(r3.ok, false);

  // Teste de tipo inválido para número
  const r4 = harvesterLive.set({ harvestMaxPerHour: 'dez' } as any);
  assert.equal(r4.ok, false);

  harvesterLive.reset();
});

test('harvesterLive: persistência e restauração com reset', () => {
  harvesterLive.reset();
  const init = harvesterLive.effective();

  harvesterLive.set({ harvestMaxPerHour: 250, seedEnabled: false });
  const updated = harvesterLive.effective();
  assert.equal(updated.harvestMaxPerHour, 250);
  assert.equal(updated.seedEnabled, false);

  const resetResult = harvesterLive.reset();
  assert.equal(resetResult.harvestMaxPerHour, init.harvestMaxPerHour);
  assert.equal(resetResult.seedEnabled, init.seedEnabled);
});

test('harvesterLive: alternância de pausa e snapshot', () => {
  harvesterLive.reset();
  assert.equal(harvesterLive.isPaused(), false);

  harvesterLive.setPaused(true);
  assert.equal(harvesterLive.isPaused(), true);

  const snap = harvesterLive.snapshot();
  assert.equal(snap.paused, true);
  assert.ok(snap.pausedSince !== null);

  harvesterLive.setPaused(false);
  assert.equal(harvesterLive.isPaused(), false);
  assert.equal(harvesterLive.snapshot().pausedSince, null);

  harvesterLive.reset();
});
