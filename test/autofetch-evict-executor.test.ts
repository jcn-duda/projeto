// Fase 6 do Chupim 2.0 — EXECUTOR AllDebrid e ORDEM de ready.
//
// Complementa `autofetch-evict.test.ts` (política). Aqui ficam a última milha
// destrutiva e a coordenação temporal: anti-re-add por `uploadDate`×`adsub`,
// filename/id/status autoritativos, falha de status/delete preservando provas,
// o gate global, as DUAS ordens de ready (BR antes de fallback held e fallback
// antes de BR) e o coalescing (mesma obra junta, obras distintas não). Zero
// rede real: o fetch é dublado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import { markerKey } from '../src/providers/autofetch-marker.js';
import { obraRecord, obraKey } from '../src/providers/autofetch-obra.js';
import { maybeEvictFallbacks } from '../src/providers/autofetch-evict.js';
import { evictFallbacks } from '../src/debrid/alldebrid-fallback-evict.js';
import { hasDurableOwnership } from '../src/debrid/alldebrid-inventory.js';
import { mockAd, mag, counter, withDebrid, assenta, gate, adrmKey } from './helpers/alldebrid-mock.js';
import {
  KEY, ACCOUNT, identity, READY, adapter, limpa, entry, putRecord, readyEntry, setMarker, own, hint,
} from './helpers/autofetch-evict-harness.js';

// O backoff do delete usa `wait` com timer unref: sem algo segurando o event
// loop, o node:test cancelaria as promessas pendentes do teste de falha.
let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));

test('F6: executor exige filename real sem sinal BR, id e status autoritativos', async () => {
  limpa();
  const BR_H = 'a1'.repeat(20);
  const NOID_H = 'a2'.repeat(20);
  const NOFILE_H = 'a3'.repeat(20);
  const MISSING_H = 'a4'.repeat(20);
  const api = mockAd({
    account: [
      mag(61, BR_H, '[WWW.BLUDV.TV] Filme Dublado 1080p', 500),
      // id vazio passa pelo magnetList (que só descarta id null/undefined):
      // é o caminho real do motivo `no-id`.
      { hash: NOID_H, id: '', filename: 'NoId.Movie.2019.1080p', status: 'Ready', uploadDate: 500 } as unknown as {
        id: number; hash: string; filename: string; status: string; uploadDate: number;
      },
      mag(63, NOFILE_H, '', 500),
    ],
  });
  try {
    const r = await evictFallbacks(KEY, [BR_H, NOID_H, NOFILE_H, MISSING_H], { delays: [0, 0, 0] });
    assert.deepEqual(r.removed, [], 'nenhum removido');
    assert.deepEqual(api.deleted, [], 'nada saiu da conta');
    const reasons = new Map(r.skipped.map((s) => [s.hash, s.reason]));
    assert.equal(reasons.get(BR_H), 'br-name');
    assert.equal(reasons.get(NOID_H), 'no-id');
    assert.equal(reasons.get(NOFILE_H), 'no-filename');
    assert.equal(reasons.get(MISSING_H), 'not-in-account');
  } finally {
    api.restore();
  }
});

test('F6: anti-re-add — uploadDate posterior à etiqueta bloqueia, anterior permite', async () => {
  limpa();
  const VELHO = 'f1'.repeat(20);
  const READD = 'f2'.repeat(20);
  const SEM_DATA = 'f3'.repeat(20);
  const agoraSeg = Math.floor(Date.now() / 1000);
  const api = mockAd({
    account: [
      mag(101, VELHO, 'Old.Movie.2019.1080p', agoraSeg - 7200), // 2h antes da etiqueta
      mag(102, READD, 'Readd.Movie.2019.1080p', agoraSeg + 3600), // 1h depois → re-add
      mag(103, SEM_DATA, 'NoDate2.Movie.2019.1080p', 0), // uploadDate ausente
    ],
  });
  putRecord([readyEntry(), entry(VELHO, 'seeds'), entry(READD, 'any'), entry(SEM_DATA, 'seeds')]);
  for (const h of [VELHO, READD, SEM_DATA]) { setMarker(h, 'seeds'); own(h); }
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.deepEqual(api.deleted, [101], 'só o magnet ANTERIOR à etiqueta sai');
    assert.equal(counter('autofetch.evict.skipped.readded'), 1, 'uploadDate posterior à etiqueta bloqueia');
    assert.equal(counter('autofetch.evict.skipped.no-upload-date'), 1, 'sem uploadDate bloqueia');
    assert.equal(obraRecord(identity).some((e) => e.hash === READD), true, 're-add permanece no registro');
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: falha de status fecha a rodada sem apagar', async () => {
  limpa();
  const h = 'b1'.repeat(20);
  const api = mockAd({ account: [mag(71, h, 'Foreign.Movie.2019.1080p', 500)], failStatus: true });
  try {
    const r = await evictFallbacks(KEY, [h], { delays: [0, 0, 0] });
    assert.deepEqual(r.removed, []);
    assert.equal(r.skipped[0]?.reason, 'status-error');
    assert.equal(api.deleted.length, 0);
    assert.equal(counter('debrid.evictFallback.statusFailed'), 1);
  } finally {
    api.restore();
  }
});

test('F6: delete falho mantém marker/adsub/obra e não grava adrm', async () => {
  limpa();
  const h = 'c1'.repeat(20);
  const api = mockAd({ account: [mag(81, h, 'Foreign.Movie.2019.1080p', 500)], failDeleteFor: [81] });
  putRecord([readyEntry(), entry(h, 'seeds')]);
  setMarker(h, 'seeds');
  own(h);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    assert.deepEqual(api.deleted, [], 'a conta recusou o delete');
    assert.ok(cache.peek(markerKey('alldebrid', ACCOUNT, h)), 'marker mantido na falha');
    assert.equal(hasDurableOwnership(ACCOUNT, h), true, 'posse mantida na falha');
    assert.equal(obraRecord(identity).some((e) => e.hash === h), true, 'registro mantido na falha');
    assert.equal(cache.peek(adrmKey(ACCOUNT, h)), null, 'sem adrm quando o delete falha');
    assert.equal(counter('autofetch.evict.removed'), 0);
    assert.equal(counter('autofetch.evict.skipped.delete-failed'), 1);
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: BR ready com fallback ainda held não remove; fallback ready depois remove', async () => {
  limpa();
  const FALL = 'c2'.repeat(20);
  const api = mockAd({ account: [mag(121, FALL, 'Fallback.Seeds.1080p', 500)] });
  putRecord([readyEntry(), entry(FALL, 'seeds')]);
  setMarker(FALL, 'seeds');
  own(FALL);
  held.hold(FALL, 60, ACCOUNT); // download do fallback ainda em voo
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    // Ordem 1: BR ready chega PRIMEIRO, com o fallback held → não remove.
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.deepEqual(api.deleted, [], 'held barra no primeiro ready');
    assert.equal(counter('autofetch.evict.skipped.held'), 1);
    assert.equal(counter('autofetch.evict.brReady'), 1, 'prova BR ready registrada');
    // Fallback fica pronto depois: o recheck libera o hold e reavalia.
    held.release(FALL, ACCOUNT);
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: FALL, hint });
    await assenta();
    assert.deepEqual(api.deleted, [121], 'fallback ready depois é removido pela prova BR ready');
    assert.equal(counter('autofetch.evict.removed'), 1);
  } finally {
    held.release(FALL, ACCOUNT);
    restaura();
    api.restore();
  }
});

test('F6: fallback ready primeiro não remove sem prova BR; BR ready depois remove', async () => {
  limpa();
  const FALL = 'c3'.repeat(20);
  const api = mockAd({ account: [mag(122, FALL, 'Fallback.Seeds.1080p', 500)] });
  putRecord([readyEntry(), entry(FALL, 'any')]);
  setMarker(FALL, 'any');
  own(FALL);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: FALL, hint });
    await assenta();
    assert.deepEqual(api.deleted, [], 'sem prova BR ready a obra não é tocada');
    assert.equal(counter('autofetch.evict.skipped.ready-not-br'), 1);
    // Ordem 2: BR fica pronto DEPOIS e remove o fallback já pronto.
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.deepEqual(api.deleted, [122], 'BR ready depois remove o fallback pronto');
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: obras distintas não coalescem entre si', async () => {
  limpa();
  const OUTRA_IMDB = 'tt9000002';
  const identityB = { adapterId: 'alldebrid', account: ACCOUNT, imdbId: OUTRA_IMDB, season: null, episode: null, isPack: false };
  const HA = 'd2'.repeat(20);
  const HB = 'd3'.repeat(20);
  const RB = 'e5'.repeat(20);
  const g = gate();
  const api = mockAd({
    account: [mag(131, HA, 'ObraA.Seeds.1080p', 500), mag(132, HB, 'ObraB.Seeds.1080p', 500)],
    statusGate: g,
  });
  putRecord([readyEntry(), entry(HA, 'seeds')]);
  cache.set(obraKey(identityB), { entries: [entry(RB, 'br', { dubbed: true }), entry(HB, 'seeds')] }, 3600);
  setMarker(HA, 'seeds');
  setMarker(HB, 'seeds', OUTRA_IMDB);
  own(HA);
  own(HB);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    const p1 = maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    const p2 = maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: RB, hint: { imdbId: OUTRA_IMDB } });
    await assenta();
    assert.equal(counter('autofetch.evict.coalesced'), 0, 'obras distintas não coalescem');
    g.liberar();
    await Promise.all([p1, p2]);
    assert.equal(api.statusCalls, 2, 'uma execução por obra');
    assert.deepEqual([...api.deleted].sort((a, b) => Number(a) - Number(b)), [131, 132]);
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: duas chamadas concorrentes da mesma obra coalescem', async () => {
  limpa();
  const h = 'd1'.repeat(20);
  const g = gate();
  const api = mockAd({ account: [mag(95, h, 'Foreign.Movie.2019.1080p', 500)], statusGate: g });
  putRecord([readyEntry(), entry(h, 'seeds')]);
  setMarker(h, 'seeds');
  own(h);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    const p1 = maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    const p2 = maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.equal(counter('autofetch.evict.coalesced'), 1, 'a segunda chamada coalesce');
    g.liberar();
    await Promise.all([p1, p2]);
    assert.equal(api.statusCalls, 1, 'uma única leitura de status');
    assert.deepEqual(api.deleted, [95]);
  } finally {
    restaura();
    api.restore();
  }
});
