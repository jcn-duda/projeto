// Despacho paralelo entre sites (`crawl-dispatch.ts`): vagas, faixa única do
// FlareSolverr, ritmo por site e site em voo fora da disputa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteRuntime } from '../src/providers/crawl-site-runtime.js';
import { pickBatch } from '../src/providers/crawl-dispatch.js';

const EMPTY = {
  pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0,
};
const cfg = { enabled: true, dryRun: true, delayMs: 500, maxPerHour: 1000, incrementalIntervalMin: 60 } as never;
const deps = {
  counters: () => ({ total: 5, byStatus: { ...EMPTY, pending: 5 } }),
  probeOpen: () => true,
  globalCapHit: () => false,
};

function setup(ids: string[]) {
  const rts = new Map(ids.map((id) => [id, createSiteRuntime(id)]));
  for (const rt of rts.values()) rt.openRunId = 1;
  return { rts, runtimeOf: (id: string) => rts.get(id)! };
}

test('paralelo: até maxParallel sites por ciclo, e quem está em voo fica de fora', () => {
  const { runtimeOf } = setup(['a', 'b', 'c', 'd']);
  const base = { ids: ['a', 'b', 'c', 'd'], flareSites: new Set<string>(), runtimeOf, configOf: () => cfg, deps, now: Date.now() };
  assert.deepEqual(pickBatch({ ...base, inflight: new Set(), maxParallel: 3 }).chosen.map((c) => c.id), ['a', 'b', 'c']);
  assert.deepEqual(pickBatch({ ...base, inflight: new Set(['a', 'b']), maxParallel: 3 }).chosen.map((c) => c.id), ['c']);
  assert.equal(pickBatch({ ...base, inflight: new Set(['a', 'b', 'c']), maxParallel: 3 }).chosen.length, 0);
  // 1 é o serial de antes.
  assert.deepEqual(pickBatch({ ...base, inflight: new Set(), maxParallel: 1 }).chosen.map((c) => c.id), ['a']);
});

test('faixa do FlareSolverr: dois sites dele nunca correm juntos', () => {
  const { runtimeOf } = setup(['rede', 'bludv', 'vaca']);
  const flareSites = new Set(['rede', 'bludv']);
  const base = { ids: ['rede', 'bludv', 'vaca'], flareSites, runtimeOf, configOf: () => cfg, deps, now: Date.now(), maxParallel: 3 };
  assert.deepEqual(pickBatch({ ...base, inflight: new Set() }).chosen.map((c) => c.id), ['rede', 'vaca']);
  assert.deepEqual(pickBatch({ ...base, inflight: new Set(['rede']) }).chosen.map((c) => c.id), ['vaca']);
});

test('ritmo POR SITE: quem requisitou há menos que o delayMs espera, o vizinho não', () => {
  const now = Date.now();
  const { runtimeOf } = setup(['a', 'b']);
  runtimeOf('a').lastActiveAt = now - 100; // dentro dos 500 ms
  runtimeOf('b').lastActiveAt = now - 900;
  const out = pickBatch({ ids: ['a', 'b'], inflight: new Set(), flareSites: new Set(), runtimeOf, configOf: () => cfg, deps, now, maxParallel: 3 });
  assert.deepEqual(out.chosen.map((c) => c.id), ['b']);
  assert.ok(out.paced.has('a'));
});
