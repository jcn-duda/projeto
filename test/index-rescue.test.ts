// A Grande Aposta (2026-10-04, Premiumize + cachedOnly): o instantâneo do
// acervo trouxe 8 dublados BR, 0/8 em cache, todos ocultos — a 1ª resposta foi
// só o aviso. Resposta do índice sem stream tocável agora coleta ao vivo na hora.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import { rescueEmptyIndexAnswer } from '../src/providers/search-index-path.js';
import type { RawBatch } from '../src/providers/search-index-path.js';

const notice: Record<string, string> = { name: '⏳', externalUrl: 'https://x.test/aviso' };
const playable: Record<string, string> = { name: '[PM⚡] 1080p', infoHash: 'a'.repeat(40) };
const batch = (items: any[], extra: Partial<RawBatch> = {}): RawBatch =>
  ({ items, partial: false, completion: Promise.resolve(), sweepInline: false, ...extra });

function harness(liveItems: any[] = [{ title: 'The Big Short 2015 1080p', infoHash: 'b'.repeat(40) }]) {
  const calls = { collect: 0, rebuild: [] as RawBatch[] };
  return {
    calls,
    collect: async () => { calls.collect += 1; return batch(liveItems, { partial: true }); },
    rebuild: async (raw: RawBatch) => { calls.rebuild.push(raw); return { streams: [playable] }; },
  };
}

test('índice sem stream tocável: coleta ao vivo agora e mescla o lote', async () => {
  const h = harness();
  const indexRaw = batch([{ title: 'A Grande Aposta [1080p DUBLADO]', infoHash: 'c'.repeat(40) }], { instant: true });
  const out = await rescueEmptyIndexAnswer({
    servedFromIndex: true, result: { streams: [notice] }, raw: indexRaw, deadlineAt: Date.now() + 8000, collect: h.collect, rebuild: h.rebuild,
  });
  assert.ok(out);
  assert.equal(h.calls.collect, 1);
  assert.equal(out.raw.items.length, 2, 'itens do índice + itens ao vivo');
  assert.equal(out.raw.instant, true, 'o tail da via instantânea continua igual');
  assert.equal(out.raw.partial, true, 'o estado parcial vem da coleta ao vivo');
  assert.deepEqual(out.result.streams, [playable]);
});

test('lista vazia também é resgatada', async () => {
  const h = harness();
  const out = await rescueEmptyIndexAnswer({
    servedFromIndex: true, result: { streams: [] }, raw: batch([]), deadlineAt: Date.now() + 8000, collect: h.collect, rebuild: h.rebuild,
  });
  assert.ok(out);
  assert.equal(h.calls.collect, 1);
});

test('não resgata: já há stream tocável, não veio do índice, ou falta prazo', async () => {
  const cases = [
    { servedFromIndex: true, result: { streams: [notice, playable] }, deadlineAt: Date.now() + 8000 },
    { servedFromIndex: false, result: { streams: [notice] }, deadlineAt: Date.now() + 8000 },
    { servedFromIndex: true, result: { streams: [notice] }, deadlineAt: Date.now() + 500 },
  ];
  for (const c of cases) {
    const h = harness();
    const out = await rescueEmptyIndexAnswer({ ...c, raw: batch([]), collect: h.collect, rebuild: h.rebuild });
    assert.equal(out, null);
    assert.equal(h.calls.collect, 0);
  }
});

test('SEARCH_INDEX_RESCUE_MIN_MS=0 desliga', async () => {
  const before = config.search.indexRescueMinMs;
  (config.search as { indexRescueMinMs: number }).indexRescueMinMs = 0;
  try {
    const h = harness();
    const out = await rescueEmptyIndexAnswer({
      servedFromIndex: true, result: { streams: [notice] }, raw: batch([]), deadlineAt: Date.now() + 8000, collect: h.collect, rebuild: h.rebuild,
    });
    assert.equal(out, null);
    assert.equal(h.calls.collect, 0);
  } finally {
    (config.search as { indexRescueMinMs: number }).indexRescueMinMs = before;
  }
});
