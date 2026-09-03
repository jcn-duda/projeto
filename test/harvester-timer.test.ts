// Etapa 4 — timer rearmável do colhedor. O intervalo do ciclo mora na config
// ao vivo (harvesterLive) e o painel pode mudá-lo sem restart; o setInterval
// do start() tem que acompanhar. Os globals setInterval/clearInterval são
// dublados para nenhum timer real viver no processo (o fake devolve .unref()).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
config.seed.enabled = false;
import harvester from '../src/providers/harvester.js';
import * as harvesterNs from '../src/providers/harvester.js';
import * as harvesterLive from '../src/utils/harvester-live.js';

test('Etapa 4: start() arma com o valor vivo e tick() rearrma em mudança de harvestIntervalMs', async () => {
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
  try {
    harvesterLive.reset();
    // Valor vivo ANTES do start: hoje (sem a Etapa 4) o start() armaria com o
    // config.harvest.intervalMs estático (60s) e este assert falharia.
    harvesterLive.set({ harvestIntervalMs: 5000 });
    harvester.start();
    assert.deepEqual(setCalls, [5000], 'start() arma com o harvestIntervalMs vivo');
    assert.equal(harvesterNs._armedIntervalMsForTest(), 5000);

    // Mudança ao vivo: o tick seguinte reagenda ANTES de qualquer retorno
    // precoce — rearranja mesmo com a fila vazia.
    harvesterLive.set({ harvestIntervalMs: 8000 });
    setCalls.length = 0;
    clearCalls.length = 0;
    await harvester.tick();
    assert.equal(clearCalls.length, 1, 'tick clearou o timer antigo');
    assert.deepEqual(setCalls, [8000], 'tick rearranja com o novo intervalo');
    assert.equal(harvesterNs._armedIntervalMsForTest(), 8000);

    // Intervalo inalterado no tick seguinte: nada de clear+set novo.
    setCalls.length = 0;
    clearCalls.length = 0;
    await harvester.tick();
    assert.equal(setCalls.length, 0, 'intervalo inalterado não reagenda');
    assert.equal(clearCalls.length, 0, 'intervalo inalterado não clearou nada');
  } finally {
    harvesterLive.reset();
    global.setInterval = originalSet;
    global.clearInterval = originalClear;
  }
});