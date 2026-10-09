// Limite de fome da descoberta na rotação serial (crawl-site-select.ts).
// Extraído de crawl-multisite.test.ts pelo teto de 400 linhas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteRuntime } from '../src/providers/crawl-site-runtime.js';
import { selectNext } from '../src/providers/crawl-site-select.js';

const EMPTY = {
  pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0,
};
const runtimes = (a: ReturnType<typeof createSiteRuntime>, b: ReturnType<typeof createSiteRuntime>) => (id: string) => (id === 'b' ? b : a);
const cfg = { enabled: true, dryRun: true, delayMs: 0, maxPerHour: 10 } as never;
const queue = (total: number, pending: number) => ({ total, byStatus: { ...EMPTY, pending } });

test('fome: descoberta que nunca rodou (ou passou do intervalo) fura a fila de item', () => {
  // VPS (2026-09-30): Apache/HDR/Vaca/Nerd com lastActiveAt 0 nunca pegavam
  // a vez atrás da fila do Comando/TorrentDosFilmes.
  const now = Date.now();
  const a = createSiteRuntime('a');
  const b = createSiteRuntime('b');
  a.openRunId = 1; a.lastActiveAt = now;
  const deps = {
    counters: (id: string) => (id === 'a' ? queue(5, 5) : queue(0, 0)),
    probeOpen: () => true, globalCapHit: () => false,
  };
  const conf = { ...(cfg as object), incrementalIntervalMin: 60 } as never;
  b.lastActiveAt = 0;
  assert.equal(selectNext(['a', 'b'], runtimes(a, b), () => conf, deps, now).chosen?.id, 'b', 'nunca rodou');
  b.lastActiveAt = now - 61 * 60_000;
  assert.equal(selectNext(['a', 'b'], runtimes(a, b), () => conf, deps, now).chosen?.id, 'b', 'passou do intervalo');
  b.lastActiveAt = now - 30 * 60_000;
  assert.equal(selectNext(['a', 'b'], runtimes(a, b), () => conf, deps, now).chosen?.id, 'a', 'dentro do intervalo');
});
