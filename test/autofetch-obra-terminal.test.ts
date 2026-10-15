// Fase 2 — desfechos TERMINAIS do teto por obra: dead/stalled libera a vaga
// (`forgetObraHash`), ready continua contando pela janela, pack usa identidade
// de temporada e a fila carrega a evidência rara do pool seeds. Sem rede real.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import * as cache from '../src/utils/cache.js';
import { accountScope } from '../src/utils/request-key.js';
import { enqueueAutofetch, drainNext } from '../src/providers/autofetch-runner.js';
import { toQueueCandidate } from '../src/providers/autofetch-fallback.js';
import {
  reserveObra, commitObra, forgetObraHash, obraRecord, obraKey, resetObraForTest,
} from '../src/providers/autofetch-obra.js';
import { makeDrainHarness, flush } from './helpers/autofetch-fixtures.js';
import type { DebridAdapter } from '../types/domain.js';

const PM = 'premiumize';
const pmAdapter = debrid.BY_ID.get(PM) as DebridAdapter;
const originalEnqueue = pmAdapter.enqueue;
const originalStatus = pmAdapter.accountStatus;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
const brStream = (h: string, title = 'Coringa (2019) Dublado 1080p') => ({ infoHash: h, name: title, title, _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 });
const anyStream = (h: string) => ({ infoHash: h, name: 'Movie Dual 1080p', title: 'Movie (2019) Dual 1080p', _br: false, _dubbed: true, _quality: '1080p', _seeders: 3 });

function enq(apiKey: string, stream: { infoHash: string }, o: { pool?: string; imdbId?: string | null; season?: number | null; episode?: number | null; searchKey?: string }): boolean {
  return runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: PM, debridApiKey: apiKey, debridCachedOnly: true, dubbedOnly: false, autoFetchBr: true },
      encoded: `cfg-${apiKey}`,
    },
    () => enqueueAutofetch(
      { stream: stream as never, account: accountScope(apiKey), pool: o.pool ?? 'br' },
      {
        cached: new Set<string>(), season: o.season ?? null, episode: o.episode ?? null,
        imdbId: o.imdbId ?? null, searchKey: o.searchKey ?? `sk-${stream.infoHash.slice(0, 6)}`,
      },
    ),
  ) === true;
}

before(() => {
  autofetchLive.reset();
  pmAdapter.enqueue = async () => true;
  pmAdapter.accountStatus = async () => ({ magnets: 0 });
  autofetch.resetAccountGate();
});
after(() => {
  pmAdapter.enqueue = originalEnqueue;
  pmAdapter.accountStatus = originalStatus;
  autofetch.resetAccountGate();
  autofetch.resetBudget();
  autofetchLive.reset();
  resetObraForTest();
  for (const key of trash) cache.forget(key);
});

test('forgetObraHash remove só o hash terminal e preserva outros hashes/pools', () => {
  const apiKey = 'chave-obra-forget';
  const imdbId = 'tt7100001';
  autofetchLive.set({ autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId });
  const brA = hx('a1'); const brB = hx('b2'); const seed = hx('c3');
  const id = identity(apiKey, { imdbId });
  try {
    const l1 = reserveObra({ ...id, pool: 'br', hash: brA });
    const l2 = reserveObra({ ...id, pool: 'br', hash: brB });
    const l3 = reserveObra({ ...id, pool: 'seeds', hash: seed });
    commitObra(l1, { hash: brA, pool: 'br' });
    commitObra(l2, { hash: brB, pool: 'br' });
    commitObra(l3, { hash: seed, pool: 'seeds' });
    assert.equal(obraRecord(id).length, 3);

    assert.equal(forgetObraHash({ ...id, hash: brA }), true);
    const rec = obraRecord(id);
    assert.equal(rec.length, 2, 'removeu um só');
    assert.ok(rec.some((e) => e.hash === brB && e.pool === 'br'), 'outro hash br preservado');
    assert.ok(rec.some((e) => e.hash === seed && e.pool === 'seeds'), 'outro pool preservado');
    assert.equal(forgetObraHash({ ...id, hash: hx('be') }), false, 'hash ausente não conta');

    assert.equal(forgetObraHash({ ...id, hash: brB }), true);
    assert.equal(forgetObraHash({ ...id, hash: seed }), true);
    assert.equal(obraRecord(id).length, 0);
    assert.ok(!cache.peek(obraKey(id)), 'registro que esvazia tem a chave esquecida');
  } finally {
    forgetHashes(apiKey, [brA, brB, seed]);
  }
});

test('vaga br liberada pelo terminal aceita reposição SAME POOL', async () => {
  const apiKey = 'chave-obra-repor-br';
  const imdbId = 'tt7100002';
  autofetchLive.set({ autoFetchMax: 1 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('d4'); const h2 = hx('e5');
  const id = identity(apiKey, { imdbId });
  try {
    const lease = reserveObra({ ...id, pool: 'br', hash: h1 });
    commitObra(lease, { hash: h1, pool: 'br' });
    assert.equal(enq(apiKey, brStream(h2), { imdbId, searchKey: 'rep-br-2' }), false, 'teto cheio antes do terminal');
    assert.equal(forgetObraHash({ ...id, hash: h1 }), true);
    assert.equal(enq(apiKey, brStream(h2), { imdbId, searchKey: 'rep-br-2' }), true, 'terminal libera e a reposição br cabe');
    await sleep(10);
  } finally {
    forgetHashes(apiKey, [h1, h2]);
  }
});

test('vaga any (cap=1) liberada pelo terminal aceita reposição', async () => {
  const apiKey = 'chave-obra-repor-any';
  const imdbId = 'tt7100003';
  autofetchLive.set({ autoFetchMax: 3 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('f6'); const h2 = hx('a7');
  const id = identity(apiKey, { imdbId });
  try {
    const lease = reserveObra({ ...id, pool: 'any', hash: h1 });
    commitObra(lease, { hash: h1, pool: 'any' });
    assert.equal(enq(apiKey, anyStream(h2), { pool: 'any', imdbId, searchKey: 'rep-any-2' }), false, 'any=1/obra segue como decisão');
    assert.equal(forgetObraHash({ ...id, hash: h1 }), true);
    assert.equal(enq(apiKey, anyStream(h2), { pool: 'any', imdbId, searchKey: 'rep-any-3' }), true, 'reposição any volta após liberar o terminal');
    await sleep(10);
  } finally {
    forgetHashes(apiKey, [h1, h2]);
  }
});

test('packs da mesma temporada dividem o teto; episódios avulsos ficam separados', async () => {
  const apiKey = 'chave-obra-pack';
  const imdbId = 'tt7100004';
  autofetchLive.set({ autoFetchMax: 1, autoFetchSeasonFill: true });
  trackKey(apiKey, { imdbId, season: 1, episode: null });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 2 });
  const pack1 = hx('b8'); const pack2 = hx('c9');
  const ep1 = hx('d0'); const ep2 = hx('e1');
  try {
    assert.equal(enq(apiKey, brStream(pack1, 'Show S01 Dual 1080p'), { imdbId, season: 1, episode: 1, searchKey: 'pack-e1' }), true);
    await sleep(10);
    assert.equal(
      enq(apiKey, brStream(pack2, 'Show S01 Dual 1080p'), { imdbId, season: 1, episode: 2, searchKey: 'pack-e2' }),
      false,
      'packs da mesma temporada (E01/E02) compartilham a vaga',
    );
    assert.equal(enq(apiKey, brStream(ep1, 'Show S01E01 Dual 1080p'), { imdbId, season: 1, episode: 1, searchKey: 'ep-1' }), true);
    assert.equal(enq(apiKey, brStream(ep2, 'Show S01E02 Dual 1080p'), { imdbId, season: 1, episode: 2, searchKey: 'ep-2' }), true);
    await sleep(10);
    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: null })).length, 1, 'chave do pack é a temporada');
    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: 1 })).length, 1, 'S01E01 separado');
    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: 2 })).length, 1, 'S01E02 separado');
  } finally {
    forgetHashes(apiKey, [pack1, pack2, ep1, ep2]);
  }
});

test('QueueCandidate preserva rare/slotLimit e o dreno usa o cap raro', async () => {
  const apiKey = 'chave-obra-rare-queue';
  const imdbId = 'tt7100005';
  const searchKey = 'rare-queue-search';
  autofetchLive.set({ autoFetchTopSeedsMax: 2, autoFetchRareMax: 4, autoFetchQueueDepth: 2 });
  const account = accountScope(apiKey);
  const seed1 = hx('a6'); const seed2 = hx('b7'); const hRare = hx('c8');
  const id = identity(apiKey, { imdbId, season: 1, episode: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  const enqueued: string[] = [];
  try {
    for (const h of [seed1, seed2]) {
      const lease = reserveObra({ ...id, pool: 'seeds', hash: h });
      commitObra(lease, { hash: h, pool: 'seeds' });
    }
    autofetch.writeQueue(searchKey, [
      {
        infoHash: hRare, pool: 'seeds', rare: true, slotLimit: 4, imdbId, season: 1, episode: 1,
        title: 'Movie 1080p BluRay', br: false, dubbed: false, quality: '1080p', size: 2 * 1024 ** 3,
      },
    ], 3600, PM, account);

    pmAdapter.enqueue = async (_key, h) => { enqueued.push(String(h)); return true; };
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: PM, debridApiKey: apiKey, debridCachedOnly: true, dubbedOnly: false }, encoded: 'cfg-rare-queue' },
      () => drainNext(searchKey, { refusals: 0, hashes: new Set<string>(), seasonHints: new Map() }),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [hRare], 'raro acima de topSeedsMax mas dentro de rareMax drena');

    const qc = toQueueCandidate(
      { infoHash: hx('a9'), name: 'Movie 1080p BluRay', title: 'Movie 1080p BluRay', _br: false, _dubbed: false, _quality: '1080p', _seeders: 20 } as never,
      'seeds',
      { season: 1, episode: 2, seasonFill: false, rare: true, slotLimit: 4 },
    );
    assert.equal(qc.rare, true, 'evidência rara persistida');
    assert.equal(qc.slotLimit, 4, 'slotLimit persistido');
    assert.equal(qc.episode, 2, 'episódio não-pack preservado');
  } finally {
    pmAdapter.enqueue = async () => true;
    autofetch.dropQueue(searchKey);
    forgetHashes(apiKey, [seed1, seed2, hRare]);
  }
});

test('morte do any primário libera a vaga e a fila SAME POOL sobe (recheck real)', async () => {
  autofetchLive.reset();
  autofetchLive.set({ autoFetchMax: 1, autoFetchQueueDepth: 2 });
  const h = makeDrainHarness('obra-any-death-x', { stallStreak: 2 });
  const primary = hx('da'); const surplus = hx('db');
  const globalDub = (hash: string, seeds: number) => ({
    infoHash: hash, name: 'Movie Dual 1080p', title: 'Movie Dual 1080p',
    _br: false, _dubbed: true, _quality: '1080p', _seeders: seeds,
  });
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    h.setTorrentStatus(async () => ({ [primary]: { state: 'downloading', stalled: true, id: 91 } }));
    h.pmAdapter.removeTorrent = async () => true;
    await h.run([globalDub(primary, 50), globalDub(surplus, 20)]);
    assert.deepEqual(h.enqueued, [primary], 'só o any primário dispara (any=1/obra)');
    assert.equal(autofetch.readQueue(h.searchKey).length, 1, 'any excedente na fila');

    mock.timers.tick(120_000);
    await flush();
    assert.equal(h.enqueued.length, 1, '1ª observação de stall não drena');
    mock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', h.account, primary), true, 'any primário colapsa');
    assert.ok(h.enqueued.includes(surplus), 'terminal libera a vaga e o any same-pool da fila sobe');
    assert.equal(autofetch.readQueue(h.searchKey).length, 0, 'cabeça consumida');
  } finally {
    mock.timers.reset();
    autofetchLive.reset();
    h.cleanup([primary, surplus]);
  }
});
