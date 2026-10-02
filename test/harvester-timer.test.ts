// Etapa 4 — timer rearmável do colhedor. O intervalo do ciclo mora na config
// ao vivo (harvesterLive) e o painel pode mudá-lo sem restart; o setInterval
// do start() tem que acompanhar. Fase 3: harvestEnabled vivo também arma/
// desarma o timer via onConfigChange (sem restart). Os globals setInterval/
// clearInterval são dublados para nenhum timer real viver no processo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
config.seed.enabled = false;
import harvester from '../src/providers/harvester.js';
import * as harvesterNs from '../src/providers/harvester.js';
import * as harvesterLive from '../src/utils/harvester-live.js';

function stubTimers() {
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  const fakeTimer = { unref(): void {} };
  const setCalls: number[] = [];
  const clearCalls: number[] = [];
  global.setInterval = ((_fn: () => void, ms: number) => {
    setCalls.push(ms);
    return fakeTimer;
  }) as unknown as typeof setInterval;
  global.clearInterval = (() => {
    clearCalls.push(1);
  }) as unknown as typeof clearInterval;
  return {
    setCalls,
    clearCalls,
    restore() {
      global.setInterval = originalSet;
      global.clearInterval = originalClear;
    },
  };
}

test('Etapa 4: start() arma com o valor vivo; set rearranja; tick rearma se divergir', async () => {
  const timers = stubTimers();
  try {
    harvesterNs._resetForTest();
    harvesterLive.reset();
    // Valor vivo ANTES do start: sem a Etapa 4 o start usaria o estático (60s).
    harvesterLive.set({ harvestIntervalMs: 5000 });
    harvester.start();
    assert.deepEqual(timers.setCalls, [5000], 'start() arma com o harvestIntervalMs vivo');
    assert.equal(harvesterNs._armedIntervalMsForTest(), 5000);

    // Fase 3: set() notifica onConfigChange e rearranja na hora.
    timers.setCalls.length = 0;
    timers.clearCalls.length = 0;
    harvesterLive.set({ harvestIntervalMs: 8000 });
    assert.equal(timers.clearCalls.length, 1, 'set live clearou o timer antigo');
    assert.deepEqual(timers.setCalls, [8000], 'set live rearranja com o novo intervalo');
    assert.equal(harvesterNs._armedIntervalMsForTest(), 8000);

    // Intervalo inalterado: tick não reagenda (early-return da Etapa 4).
    timers.setCalls.length = 0;
    timers.clearCalls.length = 0;
    await harvester.tick();
    assert.equal(timers.setCalls.length, 0, 'intervalo inalterado não reagenda');
    assert.equal(timers.clearCalls.length, 0);

    // Etapa 4: com listener off, set muda o vivo sem sync; tick rearma.
    harvesterLive.onConfigChange(null);
    harvesterLive.set({ harvestIntervalMs: 12_000 });
    assert.equal(harvesterNs._armedIntervalMsForTest(), 8000, 'sem listener o armado ficou velho');
    timers.setCalls.length = 0;
    timers.clearCalls.length = 0;
    await harvester.tick();
    assert.equal(timers.clearCalls.length, 1, 'tick clearou o timer divergente');
    assert.deepEqual(timers.setCalls, [12_000], 'tick rearranja com o vivo');
    assert.equal(harvesterNs._armedIntervalMsForTest(), 12_000);
  } finally {
    harvesterNs._resetForTest();
    harvesterLive.reset();
    timers.restore();
  }
});

test('Fase 3: start com vivo off não arma; set harvestEnabled true arma sem restart', () => {
  const timers = stubTimers();
  const savedRelease = config.releaseIndex.enabled;
  try {
    harvesterNs._resetForTest();
    config.releaseIndex.enabled = true;
    harvesterLive.reset();
    harvesterLive.set({ harvestEnabled: false, harvestIntervalMs: 7000 });
    harvester.start();
    assert.equal(timers.setCalls.length, 0, 'vivo off → start não chama setInterval');
    assert.equal(harvesterNs._timerArmedForTest(), false);
    assert.equal(harvesterNs._armedIntervalMsForTest(), 0);
    assert.equal((harvester.status() as any).enabled, false);

    timers.setCalls.length = 0;
    harvesterLive.set({ harvestEnabled: true });
    assert.deepEqual(timers.setCalls, [7000], 'painel liga → arma com intervalo vivo');
    assert.equal(harvesterNs._timerArmedForTest(), true);
    assert.equal(harvesterNs._armedIntervalMsForTest(), 7000);
    assert.equal((harvester.status() as any).enabled, true);
  } finally {
    config.releaseIndex.enabled = savedRelease;
    harvesterNs._resetForTest();
    harvesterLive.reset();
    timers.restore();
  }
});

test('Fase 3: set harvestEnabled false desarma o timer sem restart', () => {
  const timers = stubTimers();
  try {
    harvesterNs._resetForTest();
    harvesterLive.reset();
    harvesterLive.set({ harvestEnabled: true, harvestIntervalMs: 6000 });
    harvester.start();
    assert.equal(harvesterNs._timerArmedForTest(), true);
    assert.deepEqual(timers.setCalls, [6000]);

    timers.clearCalls.length = 0;
    harvesterLive.set({ harvestEnabled: false });
    assert.equal(timers.clearCalls.length, 1, 'desligar vivo clearInterval');
    assert.equal(harvesterNs._timerArmedForTest(), false);
    assert.equal(harvesterNs._armedIntervalMsForTest(), 0);
    assert.equal((harvester.status() as any).enabled, false);
  } finally {
    harvesterNs._resetForTest();
    harvesterLive.reset();
    timers.restore();
  }
});

test('Fase 3: start com vivo on arma (critério alinhado ao status)', () => {
  const timers = stubTimers();
  try {
    harvesterNs._resetForTest();
    harvesterLive.reset();
    harvesterLive.set({ harvestEnabled: true, harvestIntervalMs: 4500 });
    harvester.start();
    assert.deepEqual(timers.setCalls, [4500]);
    assert.equal(harvesterNs._timerArmedForTest(), true);
    assert.equal((harvester.status() as any).enabled, true);
  } finally {
    harvesterNs._resetForTest();
    harvesterLive.reset();
    timers.restore();
  }
});
