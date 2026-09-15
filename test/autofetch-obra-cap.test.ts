// Fase 2 do Chupim 2.0 — teto por OBRA (autofetch-obra): dispatch imediato +
// dreno. Sem rede: enqueue/accountStatus do Premiumize são stubs. Cada teste
// usa conta/chave própria (o registro persiste por identidade).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import { enqueueAutofetch, drainNext } from '../src/providers/autofetch-runner.js';
import { classifyEnqueue, ENQUEUE_ROLLBACK } from '../src/providers/autofetch-gates.js';
import {
  reserveObra, commitObra, releaseObra, obraRecord, obraKey, obraStatus, resetObraForTest,
} from '../src/providers/autofetch-obra.js';
import type { DebridAdapter } from '../types/domain.js';

const PM = 'premiumize';
const pmAdapter = debrid.BY_ID.get(PM) as DebridAdapter;
const originalEnqueue = pmAdapter.enqueue;
const originalStatus = pmAdapter.accountStatus;
const originalPauseAt = config.debrid.autoFetchPauseAt;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const hx = (seed: string) => seed.repeat(40).slice(0, 40);
const trash: string[] = [];

function identity(apiKey: string, o: { imdbId?: string | null; season?: number | null; episode?: number | null; searchKey?: string | null } = {}) {
  return {
    adapterId: PM, account: accountScope(apiKey),
    imdbId: o.imdbId ?? null, season: o.season ?? null, episode: o.episode ?? null, searchKey: o.searchKey ?? null,
  };
}
function trackKey(apiKey: string, o: Parameters<typeof identity>[1] = {}) {
  const key = obraKey(identity(apiKey, o));
  trash.push(key);
  return key;
}
function forgetHashes(apiKey: string, hashes: string[]) {
  const account = accountScope(apiKey);
  for (const h of hashes) {
    cache.forget(autofetch.markerKey(PM, account, h));
    held.release(h, account);
  }
  autofetch.resetBudget(PM, account);
}
function skipDelta(reason: string) {
  const field = `autofetch.skip.${reason}`;
  const before = metrics.snapshot().counters[field] || 0;
  return () => (metrics.snapshot().counters[field] || 0) - before;
}
const brStream = (h: string) => ({ infoHash: h, name: 'Coringa Dublado 1080p', title: 'Coringa (2019) Dublado 1080p', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 });
const anyStream = (h: string) => ({ infoHash: h, name: 'Movie Dual 1080p', title: 'Movie (2019) Dual 1080p', _br: false, _dubbed: true, _quality: '1080p', _seeders: 3 });
const seedsStream = (h: string) => ({ infoHash: h, name: 'Movie 1080p BluRay', title: 'Movie 1080p BluRay', _br: false, _dubbed: false, _quality: '1080p', _seeders: 20 });

type EnqOpts = {
  apiKey: string; stream: { infoHash: string }; pool?: string; imdbId?: string | null;
  season?: number | null; episode?: number | null; searchKey?: string;
  rare?: boolean; slotLimit?: number; cached?: string[];
};
/** Dispara um candidato pelo caminho do runner (fire-and-forget). */
function enq(o: EnqOpts): boolean {
  const h = String(o.stream.infoHash);
  return runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: PM, debridApiKey: o.apiKey, debridCachedOnly: true, dubbedOnly: false, autoFetchBr: true },
      encoded: `cfg-${o.apiKey}`,
    },
    () => enqueueAutofetch(
      {
        stream: o.stream as never, account: accountScope(o.apiKey), pool: o.pool ?? 'br',
        ...(o.rare ? { rare: true } : {}), ...(o.slotLimit != null ? { slotLimit: o.slotLimit } : {}),
      },
      {
        cached: new Set(o.cached || []), season: o.season ?? null, episode: o.episode ?? null,
        imdbId: o.imdbId ?? null, searchKey: o.searchKey ?? `sk-${h.slice(0, 6)}`,
      },
    ),
  ) === true;
}

before(() => {
  autofetchLive.reset();
  pmAdapter.enqueue = async () => true;
  pmAdapter.accountStatus = async () => ({ magnets: 0 }); // sem isto o gate buscaria a conta real
  autofetch.resetAccountGate();
});
after(() => {
  pmAdapter.enqueue = originalEnqueue;
  pmAdapter.accountStatus = originalStatus;
  config.debrid.autoFetchPauseAt = originalPauseAt;
  autofetch.resetAccountGate();
  autofetch.resetBudget();
  autofetchLive.reset();
  resetObraForTest();
  for (const key of trash) cache.forget(key);
});

test('ordem dos portões: obra-cap entre slot e account-gate; rollback devolve a reserva', () => {
  const calls: string[] = [];
  const reason = classifyEnqueue({
    isPaused: () => { calls.push('paused'); return false; },
    isDead: () => { calls.push('dead'); return false; },
    isCached: () => { calls.push('cached'); return false; },
    markerActive: () => { calls.push('marker'); return false; },
    tryLock: () => { calls.push('lock'); return true; },
    trySlot: () => { calls.push('slot'); return true; },
    tryObraCap: () => { calls.push('obra'); return true; },
    accountBlocked: () => { calls.push('account'); return false; },
    tryBudget: () => { calls.push('budget'); return true; },
  });
  assert.equal(reason, null);
  assert.deepEqual(calls, ['paused', 'dead', 'cached', 'marker', 'lock', 'slot', 'obra', 'account', 'budget']);
  assert.deepEqual(ENQUEUE_ROLLBACK['obra-cap'], ['lock', 'slot', 'hold']);
  assert.ok(ENQUEUE_ROLLBACK['account-gate'].includes('obra'), 'reserva devolvida no account-gate');
  assert.ok(ENQUEUE_ROLLBACK.budget.includes('obra'), 'reserva devolvida no budget');
});

test('4 searchKeys da MESMA obra aceitam no máximo 2 seeds', async () => {
  const apiKey = 'chave-obra-seeds';
  const imdbId = 'tt7000001';
  autofetchLive.set({ autoFetchTopSeedsMax: 2, autoFetchRareMax: 4 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  const hashes = ['a1', 'b2', 'c3', 'd4'].map(hx);
  const d = skipDelta('obra-cap');
  try {
    const oks: boolean[] = [];
    for (let i = 0; i < hashes.length; i += 1) {
      oks.push(enq({ apiKey, stream: seedsStream(hashes[i]), pool: 'seeds', imdbId, season: 1, episode: 1, searchKey: `seeds-busca-${i}` }));
      await sleep(10);
    }
    assert.deepEqual(oks, [true, true, false, false], 'o teto da obra vale para os 4 searchKeys');
    assert.equal(d(), 2, 'dois candidatos contabilizados como obra-cap');
    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: 1 })).filter((e) => e.pool === 'seeds').length, 2);
  } finally {
    forgetHashes(apiKey, hashes);
  }
});

test('reserva síncrona barra a segunda busca antes do aceite resolver', async () => {
  const apiKey = 'chave-obra-conc';
  const imdbId = 'tt7000002';
  const h1 = hx('e5'); const h2 = hx('f6'); const h3 = hx('a7');
  trackKey(apiKey, { imdbId });
  let resolveEnqueue: ((v: boolean) => void) | null = null;
  let calls = 0;
  pmAdapter.enqueue = () => { calls += 1; return new Promise<boolean>((resolve) => { resolveEnqueue = resolve; }); };
  const d = skipDelta('obra-cap');
  try {
    assert.equal(enq({ apiKey, stream: anyStream(h1), pool: 'any', imdbId, searchKey: 'conc-1' }), true);
    assert.equal(enq({ apiKey, stream: anyStream(h2), pool: 'any', imdbId, searchKey: 'conc-2' }), false, 'enxerga a reserva em voo');
    assert.equal(calls, 1, 'só uma chamada chega ao adapter');
    assert.equal(d(), 1);
    resolveEnqueue!(true);
    await flush();
    assert.equal(enq({ apiKey, stream: anyStream(h3), pool: 'any', imdbId, searchKey: 'conc-3' }), false, 'após o aceite a vaga segue ocupada');
  } finally {
    pmAdapter.enqueue = async () => true;
    forgetHashes(apiKey, [h1, h2, h3]);
  }
});

test('enqueue false e throw liberam a reserva da obra', async () => {
  const apiKey = 'chave-obra-rollback';
  const imdbId = 'tt7000003';
  autofetchLive.set({ autoFetchMax: 1 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('11'); const h2 = hx('22'); const h3 = hx('33');
  try {
    pmAdapter.enqueue = async () => false;
    assert.equal(enq({ apiKey, stream: brStream(h1), imdbId, searchKey: 'rb-false-1' }), true);
    await sleep(10);
    assert.equal(enq({ apiKey, stream: brStream(h2), imdbId, searchKey: 'rb-false-2' }), true, 'recusa devolve a vaga');
    await sleep(10);
    pmAdapter.enqueue = async () => { throw new Error('boom'); };
    assert.equal(enq({ apiKey, stream: brStream(h3), imdbId, searchKey: 'rb-throw-1' }), true);
    await sleep(10);
    const lease = reserveObra({ ...identity(apiKey, { imdbId }), pool: 'br', hash: hx('44') });
    assert.ok(lease, 'erro no enqueue também devolve a reserva');
    releaseObra(lease);
  } finally {
    pmAdapter.enqueue = async () => true;
    forgetHashes(apiKey, [h1, h2, h3]);
  }
});

test('account-gate posterior ao teto devolve a reserva', async () => {
  const apiKey = 'chave-obra-gate';
  const imdbId = 'tt7000004';
  autofetchLive.set({ autoFetchMax: 1 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('55');
  try {
    config.debrid.autoFetchPauseAt = 2;
    autofetch.resetAccountGate();
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    assert.equal(autofetch.accountGateBlocked(pmAdapter, apiKey), false, 'memo frio é fail-open');
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(pmAdapter, apiKey), true, 'memo quente bloqueia');
    const before = obraStatus().reserved;
    assert.equal(enq({ apiKey, stream: brStream(h1), imdbId, searchKey: 'gate-1' }), false);
    assert.equal(obraStatus().reserved, before, 'a reserva não pode ficar presa');
    const lease = reserveObra({ ...identity(apiKey, { imdbId }), pool: 'br', hash: hx('66') });
    assert.ok(lease, 'vaga devolvida permite reservar de novo');
    releaseObra(lease);
  } finally {
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.accountStatus = async () => ({ magnets: 0 });
    autofetch.resetAccountGate();
    forgetHashes(apiKey, [h1]);
  }
});

test('registro persistido sobrevive ao reset volátil do módulo', async () => {
  const apiKey = 'chave-obra-persist';
  const imdbId = 'tt7000005';
  autofetchLive.set({ autoFetchMax: 1 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('77');
  try {
    assert.equal(enq({ apiKey, stream: brStream(h1), imdbId, searchKey: 'persist-1' }), true);
    await sleep(10);
    assert.equal(obraRecord(identity(apiKey, { imdbId })).length, 1, 'aceite grave o registro');
    resetObraForTest();
    assert.equal(obraStatus().reserved, 0, 'reset limpa SÓ o volátil');
    assert.equal(obraRecord(identity(apiKey, { imdbId })).length, 1, 'registro persistido sobrevive');
    assert.equal(reserveObra({ ...identity(apiKey, { imdbId }), pool: 'br', hash: hx('88') }), null, 'o registro que sobreviveu ainda conta contra o teto');
  } finally {
    forgetHashes(apiKey, [h1]);
  }
});

test('episódios diferentes têm teto independente', async () => {
  const apiKey = 'chave-obra-ep';
  const imdbId = 'tt7000006';
  autofetchLive.set({ autoFetchMax: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 2 });
  const h1 = hx('99'); const h2 = hx('aa'); const h3 = hx('bb');
  try {
    assert.equal(enq({ apiKey, stream: brStream(h1), imdbId, season: 1, episode: 1, searchKey: 'ep1-a' }), true);
    assert.equal(enq({ apiKey, stream: brStream(h2), imdbId, season: 1, episode: 2, searchKey: 'ep2-a' }), true);
    assert.equal(enq({ apiKey, stream: brStream(h3), imdbId, season: 1, episode: 1, searchKey: 'ep1-b' }), false, 'S1E1 saturado; S1E2 intacto');
  } finally {
    forgetHashes(apiKey, [h1, h2, h3]);
  }
});

test('pools br/any/seeds têm contadores separados', async () => {
  const apiKey = 'chave-obra-pools';
  const imdbId = 'tt7000007';
  autofetchLive.set({ autoFetchMax: 1, autoFetchTopSeedsMax: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  const hashes = ['cc', 'dd', 'ee', 'ff', 'a0', 'b0'].map(hx);
  try {
    const [br1, any1, seeds1, br2, any2, seeds2] = hashes;
    const o = { imdbId, season: 1, episode: 1 };
    assert.equal(enq({ apiKey, stream: brStream(br1), pool: 'br', ...o, searchKey: 'p-br-1' }), true);
    assert.equal(enq({ apiKey, stream: anyStream(any1), pool: 'any', ...o, searchKey: 'p-any-1' }), true);
    assert.equal(enq({ apiKey, stream: seedsStream(seeds1), pool: 'seeds', ...o, searchKey: 'p-seed-1' }), true);
    assert.equal(enq({ apiKey, stream: brStream(br2), pool: 'br', ...o, searchKey: 'p-br-2' }), false);
    assert.equal(enq({ apiKey, stream: anyStream(any2), pool: 'any', ...o, searchKey: 'p-any-2' }), false);
    assert.equal(enq({ apiKey, stream: seedsStream(seeds2), pool: 'seeds', ...o, searchKey: 'p-seed-2' }), false);
    await sleep(10);
    const rec = obraRecord(identity(apiKey, o));
    assert.equal(rec.filter((e) => e.pool === 'br').length, 1);
    assert.equal(rec.filter((e) => e.pool === 'any').length, 1);
    assert.equal(rec.filter((e) => e.pool === 'seeds').length, 1);
  } finally {
    forgetHashes(apiKey, hashes);
  }
});

test('seeds raro usa autoFetchRareMax como teto explícito', async () => {
  const apiKey = 'chave-obra-rare';
  const imdbId = 'tt7000008';
  autofetchLive.set({ autoFetchTopSeedsMax: 2, autoFetchRareMax: 4 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  const hashes = ['c0', 'd0', 'e0', 'f0', 'a1'].map(hx);
  const d = skipDelta('obra-cap');
  try {
    const oks: boolean[] = [];
    for (let i = 0; i < hashes.length; i += 1) {
      oks.push(enq({ apiKey, stream: seedsStream(hashes[i]), pool: 'seeds', rare: true, slotLimit: 4, imdbId, season: 1, episode: 1, searchKey: `rare-${i}` }));
      await sleep(10);
    }
    assert.deepEqual(oks, [true, true, true, true, false], 'raro sobe o teto para 4');
    assert.equal(d(), 1);
  } finally {
    forgetHashes(apiKey, hashes);
  }
});

test('drainNext descarta o candidato bloqueado pelo teto e sobe o próximo elegível', async () => {
  const apiKey = 'chave-obra-drain';
  const imdbId = 'tt7000009';
  const searchKey = 'obra-drain-search';
  autofetchLive.set({ autoFetchMax: 1, autoFetchQueueDepth: 4 });
  const account = accountScope(apiKey);
  const hCapped = hx('0a');
  const hSeed = hx('0b');
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  const enqueued: string[] = [];
  const d = skipDelta('obra-cap');
  try {
    const lease = reserveObra({ ...identity(apiKey, { imdbId, season: 1, episode: 1 }), pool: 'br', hash: hCapped });
    assert.ok(lease);
    commitObra(lease, { hash: hCapped, pool: 'br', title: 'BR no teto', br: true, dubbed: true });
    autofetch.writeQueue(searchKey, [
      { infoHash: hCapped, pool: 'br', imdbId, season: 1, episode: 1, title: 'BR no teto', br: true, dubbed: true },
      { infoHash: hSeed, pool: 'seeds', imdbId, season: 1, episode: 1, title: 'Movie 1080p BluRay', br: false, dubbed: false, quality: '1080p', size: 2 * 1024 ** 3 },
    ], 3600, PM, account);
    pmAdapter.enqueue = async (_key, h) => { enqueued.push(String(h)); return true; };
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: PM, debridApiKey: apiKey, debridCachedOnly: true, dubbedOnly: false }, encoded: 'cfg-obra-drain' },
      () => drainNext(searchKey, { refusals: 0, hashes: new Set<string>(), seasonHints: new Map() }),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [hSeed], 'o br no teto é descartado; o seeds elegível sobe');
    assert.equal(d(), 1, 'descarte contabilizado como obra-cap');
    assert.equal(autofetch.readQueue(searchKey).length, 0, 'fila consumida/dispensada');
  } finally {
    pmAdapter.enqueue = async () => true;
    autofetch.dropQueue(searchKey);
    forgetHashes(apiKey, [hCapped, hSeed]);
  }
});
