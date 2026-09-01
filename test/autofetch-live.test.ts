import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';

beforeEach(() => {
  autofetchLive.reset();
});

afterEach(() => {
  autofetchLive.reset();
});

test('autofetchLive.effective() reflete defaults do config.debrid inicialmente', () => {
  const eff = autofetchLive.effective();
  assert.equal(eff.autoFetchBr, config.debrid.autoFetchBr);
  assert.equal(eff.autoFetchAnyDubbed, config.debrid.autoFetchAnyDubbed);
  assert.equal(eff.autoFetchTopSeeds, config.debrid.autoFetchTopSeeds);
  assert.equal(eff.autoFetchSeedsPtFirst, config.debrid.autoFetchSeedsPtFirst);
  assert.equal(eff.autoFetchMinSeeders, config.debrid.autoFetchMinSeeders);
  assert.equal(eff.autoFetchMax, config.debrid.autoFetchMax);
  assert.equal(eff.autoFetchTopSeedsMax, config.debrid.autoFetchTopSeedsMax);
  assert.equal(eff.autoFetchEnqueueMaxHour, config.debrid.autoFetchEnqueueMaxHour);
  assert.equal(eff.autoFetchQueue, config.debrid.autoFetchQueue);
  assert.equal(eff.autoFetchQueueDepth, config.debrid.autoFetchQueueDepth);
  assert.equal(eff.autoFetchPauseAt, config.debrid.autoFetchPauseAt);
  assert.equal(eff.autoFetchPauseRefreshMs, config.debrid.autoFetchPauseRefreshMs);
  assert.equal(eff.autoFetchTtl, config.debrid.autoFetchTtl);
  assert.equal(eff.autoFetchRecheckMs, config.debrid.autoFetchRecheckMs);
  assert.equal(eff.autoFetchRecheckMax, config.debrid.autoFetchRecheckMax);
  assert.equal(eff.autoFetchStallStreak, config.debrid.autoFetchStallStreak);
  assert.equal(eff.autoFetchSettleMs, config.debrid.autoFetchSettleMs);
  assert.equal(eff.autoFetchDeadTtl, config.debrid.autoFetchDeadTtl);
  assert.equal(eff.autoFetchSeasonFill, config.debrid.autoFetchSeasonFill);
  assert.equal(eff.paused, false);
  assert.equal(eff.pausedSince, null);
});

test('autofetchLive.set() valida e aplica clamps nos valores numéricos', () => {
  const result = autofetchLive.set({
    autoFetchMax: 20, // clamp 1..12 -> 12
    autoFetchTopSeedsMax: -5, // clamp 1..4 -> 1
    autoFetchQueueDepth: 50, // clamp 0..12 -> 12
    autoFetchMinSeeders: -2, // clamp >= 0 -> 0
    autoFetchEnqueueMaxHour: 0, // clamp >= 1 -> 1
    autoFetchPauseAt: -10, // clamp >= 0 -> 0
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.effective.autoFetchMax, 12);
    assert.equal(result.effective.autoFetchTopSeedsMax, 1);
    assert.equal(result.effective.autoFetchQueueDepth, 12);
    assert.equal(result.effective.autoFetchMinSeeders, 0);
    assert.equal(result.effective.autoFetchEnqueueMaxHour, 1);
    assert.equal(result.effective.autoFetchPauseAt, 0);
    assert.ok(result.overriddenKeys.includes('autoFetchMax'));
    assert.ok(result.overriddenKeys.includes('autoFetchTopSeedsMax'));
  }
});

test('autofetchLive.set() rejeita chaves desconhecidas', () => {
  const result = autofetchLive.set({
    chaveInexistente: 123,
    outroCampoEstranho: true,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /chave desconhecida/);
  }
});

test('autofetchLive.set() valida tipos booleanos e numéricos', () => {
  const resBool = autofetchLive.set({
    autoFetchBr: 'true' as any,
  });
  assert.equal(resBool.ok, false);
  if (!resBool.ok) {
    assert.match(resBool.errors[0], /deve ser booleano/);
  }

  const resNum = autofetchLive.set({
    autoFetchMax: 'quatro' as any,
  });
  assert.equal(resNum.ok, false);
  if (!resNum.ok) {
    assert.match(resNum.errors[0], /deve ser um número/);
  }
});

test('autofetchLive.setPaused() atualiza estado de pausa e pausedSince', () => {
  assert.equal(autofetchLive.isPaused(), false);
  const paused = autofetchLive.setPaused(true);
  assert.equal(paused, true);
  assert.equal(autofetchLive.isPaused(), true);

  const eff = autofetchLive.effective();
  assert.equal(eff.paused, true);
  assert.ok(typeof eff.pausedSince === 'number');

  autofetchLive.setPaused(false);
  assert.equal(autofetchLive.isPaused(), false);
  assert.equal(autofetchLive.effective().paused, false);
  assert.equal(autofetchLive.effective().pausedSince, null);
});

test('autofetchLive.reset() limpa os overrides e restaura os defaults', () => {
  autofetchLive.set({
    autoFetchMax: 2,
    autoFetchBr: false,
  });
  assert.equal(autofetchLive.effective().autoFetchMax, 2);
  assert.equal(autofetchLive.effective().autoFetchBr, false);

  const restored = autofetchLive.reset();
  assert.equal(restored.autoFetchMax, config.debrid.autoFetchMax);
  assert.equal(restored.autoFetchBr, config.debrid.autoFetchBr);

  const snap = autofetchLive.snapshot();
  assert.equal(snap.overriddenKeys.length, 0);
});

test('autofetchLive.schema() fornece metadados consistentes de todos os campos expostos', () => {
  const schemaList = autofetchLive.schema();
  assert.ok(schemaList.length >= 18);
  for (const field of schemaList) {
    assert.ok(field.key);
    assert.ok(field.label);
    assert.ok(field.group);
    assert.ok(field.type === 'boolean' || field.type === 'number');
    assert.ok(field.description);
  }
});
