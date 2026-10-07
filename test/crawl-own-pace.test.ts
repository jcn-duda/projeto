// Site de ritmo PRÓPRIO (Mico, 2026-10-07): o limitador do adaptador
// (`MICO_CRAWL_MIN_GAP_MS`) é o teto dele. Ele não usa Jackett nem
// FlareSolverr, então fica fora do teto horário (do site e agregado) e da
// janela de ociosidade, e o custo dele não consome o teto agregado dos outros.
// Medido no local: 1 obra/s batia os 3.000/h em 50 min e o site parava o resto
// da hora, além de parar sempre que o app era usado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteRuntime } from '../src/providers/crawl-site-runtime.js';
import { assessSites } from '../src/providers/crawl-site-select.js';
import { isOwnPace } from '../src/providers/crawl-sites/registry.js';

const EMPTY = {
  pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0,
};
const cfg = { enabled: true, dryRun: false, delayMs: 500, maxPerHour: 3000, incrementalIntervalMin: 60 } as never;

function assess(ids: string[], globalHit: boolean, sitePages = 0) {
  const rts = new Map(ids.map((id) => [id, createSiteRuntime(id)]));
  for (const rt of rts.values()) {
    rt.openRunId = 1;
    if (sitePages) rt.hourPages.note(sitePages);
  }
  const deps = {
    counters: () => ({ total: 5, byStatus: { ...EMPTY, pending: 5 } }),
    probeOpen: () => true,
    globalCapHit: () => globalHit,
  };
  return Object.fromEntries(
    assessSites(ids, (id) => rts.get(id)!, () => cfg, deps, Date.now()).map((c) => [c.id, c.skipReason]),
  );
}

test('só o Mico tem ritmo próprio na tabela', () => {
  assert.equal(isOwnPace('mico'), true);
  assert.equal(isOwnPace('hdrtorrent-cardigann'), false);
  assert.equal(isOwnPace('vacatorrent'), false);
  assert.equal(isOwnPace('desconhecido'), false);
});

test('teto agregado estourado barra os sites comuns, não o Mico', () => {
  const out = assess(['mico', 'vacatorrent'], true);
  assert.equal(out.mico, null);
  assert.equal(out.vacatorrent, 'teto-horario');
});

test('teto do próprio site estourado também não barra o Mico', () => {
  const out = assess(['mico', 'vacatorrent'], false, 5000);
  assert.equal(out.mico, null);
  assert.equal(out.vacatorrent, 'teto-horario');
});

test('o ritmo do motor (delayMs) não segura o Mico entre um tique e outro', async () => {
  const { pickBatch } = await import('../src/providers/crawl-dispatch.js');
  const now = Date.now();
  const rts = new Map(['mico', 'vacatorrent'].map((id) => [id, createSiteRuntime(id)]));
  for (const rt of rts.values()) { rt.openRunId = 1; rt.lastActiveAt = now - 100; }
  const deps = {
    counters: () => ({ total: 5, byStatus: { ...EMPTY, pending: 5 } }),
    probeOpen: () => true,
    globalCapHit: () => false,
  };
  const out = pickBatch({
    ids: ['mico', 'vacatorrent'], inflight: new Set(), flareSites: new Set(),
    runtimeOf: (id) => rts.get(id)!, configOf: () => cfg, deps, now, maxParallel: 3,
  });
  assert.deepEqual(out.chosen.map((c) => c.id), ['mico']);
  assert.ok(out.paced.has('vacatorrent'));
});
