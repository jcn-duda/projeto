// Variante "<título> dublado" da varredura do colhedor, para quando o título pt
// é IGUAL ao original. Medido em 15 filmes assim (2026-09-24): o LimeTorrents
// devolve 12 resultados e enterrava "Apocalypse Now (1979) … 720p Dublado"
// atrás das edições gringas; só a variante o achava.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
config.seed.enabled = false;
import { dubbedSweepQueryFor, ptSweepQueryFor } from '../src/providers/search-plan.js';
import { runPtSweep, resetSweepCursor } from '../src/providers/harvest-sweep.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch } from './helpers/stub.js';

test('dubbedSweepQueryFor: só quando o pt é igual ao original (sem acento/caixa)', () => {
  const same = { pt: 'Apocalypse Now', original: 'Apocalypse Now', en: 'Apocalypse Now' };
  assert.equal(ptSweepQueryFor({ titles: same }), null, 'a varredura pt não existe nesse caso');
  assert.equal(dubbedSweepQueryFor({ titles: same }), 'Apocalypse Now dublado');
  assert.equal(dubbedSweepQueryFor({ titles: { pt: 'deadpool & wolverine', original: 'Deadpool & Wolverine' } }), 'deadpool & wolverine dublado');
  // pt diferente: a varredura pt normal já cobre, a variante não entra.
  assert.equal(dubbedSweepQueryFor({ titles: { pt: 'Coringa', original: 'Joker', en: 'Joker' } }), null);
  assert.equal(dubbedSweepQueryFor({ titles: { original: 'Joker' } }), null, 'sem pt não inventa query');
});

function sweepInput(titles: unknown) {
  return {
    entry: { type: 'movie', imdbId: 'tt0078788', season: null, episode: null } as any,
    titles,
    matchContext: null,
    indexers: ['thepiratebay'],
    directed: false,
    urgent: true,
    harvestMaxPerHour: 100,
    harvestIdleWindowMs: 0,
    queriesThisHour: 0,
    awaitGap: async () => {},
    markQueried: () => {},
  };
}

test('colhedor varre "<título> dublado" quando o pt é igual ao original; knob desliga', async () => {
  const saved = { sweep: config.jackett.ptSweepGlobal, key: config.jackett.apiKey, dubbed: config.harvest.dubbedQuery };
  const queries: string[] = [];
  const stub = stubFetch((url: string) => {
    const m = url.match(/[?&]Query=([^&]*)/i);
    if (m) queries.push(decodeURIComponent(m[1].replace(/\+/g, ' ')));
    return { ok: true, status: 200, json: async () => ({ Results: [] }) };
  });
  try {
    config.jackett.ptSweepGlobal = true;
    config.jackett.apiKey = 'x';
    config.harvest.dubbedQuery = true;
    metrics.reset();
    resetSweepCursor();
    const titles = { pt: 'Apocalypse Now', original: 'Apocalypse Now', en: 'Apocalypse Now' };
    const out = await runPtSweep(sweepInput(titles));
    assert.equal(out.attempted, 1);
    assert.ok(queries.some((q) => /^Apocalypse Now dublado$/i.test(q)), `consultou: ${queries.join(' | ')}`);
    assert.equal(metrics.snapshot().counters['harvest.sweep.dubbed'], 1);

    queries.length = 0;
    config.harvest.dubbedQuery = false;
    const off = await runPtSweep(sweepInput(titles));
    assert.equal(off.attempted, 0, 'kill-switch: nada a varrer');
    assert.equal(queries.length, 0);
  } finally {
    stub.restore();
    config.jackett.ptSweepGlobal = saved.sweep;
    config.jackett.apiKey = saved.key;
    config.harvest.dubbedQuery = saved.dubbed;
  }
});
