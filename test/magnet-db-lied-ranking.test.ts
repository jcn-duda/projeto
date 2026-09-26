// Desempate e corte dos _lied na listagem: prepareCandidateStreams,
// sortAndLimit e dedupeByHash — o mentiroso nunca reconquista a lista.
// Extraído de test/magnet-db-ranking.test.ts (teto 400 linhas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { dedupeByHash, sortAndLimit } from '../src/utils/format.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';

const runWith = (patch: { opts: any; encoded: string }, fn: () => any) => runtime.run(patch, fn);

// Adaptador fake `cacheCheck: true` no registry real (mesmo padrão do
// arquivo de origem). Por padrão nada está em cache.
function makeFake(handler?: (apiKey: string, infoHashes: string[]) => any) {
  const calls: string[][] = [];
  const adapter = {
    id: 'premiumize',
    label: 'Premiumize fake',
    short: 'pm',
    cacheCheck: true,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[]) {
      calls.push([...infoHashes]);
      return handler ? handler(_apiKey, infoHashes) : { cached: new Set(), complete: true };
    },
    async resolveLink() {
      return null;
    },
  };
  return { adapter, calls };
}

function userOpts(apiKey: string) {
  return {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
    // O default do operador pode nascer com d:1; estes testes medem ranking/
    // magnetdb, não o filtro claim|proven.
    dubbedOnly: false,
  };
}

test('prepareCandidateStreams: stream _lied some da lista (nunca listado)', () => {
  const liedHash = '1'.repeat(40);
  const cleanHash = '2'.repeat(40);
  const raw = [
    { title: 'Filme Dublado DUAL 1080p', infoHash: liedHash, lied: true, seeders: 100 },
    { title: 'Filme Legendado 1080p', infoHash: cleanHash, seeders: 10 },
  ];
  const res = runWith({ opts: { ...userOpts('k1'), dubbedOnly: false }, encoded: 'seg' }, () =>
    prepareCandidateStreams(raw as any, {})
  );
  assert.equal(res.streams.find((s: any) => s.infoHash === liedHash), undefined, '_lied nunca entra na lista');
  assert.equal(res.streams[0].infoHash, cleanHash);
});

test('sortAndLimit: _lied é removido da lista sempre', () => {
  const hClean = '3'.repeat(40);
  const hLied = '4'.repeat(40);
  const streams = [
    { infoHash: hLied, name: 'Filme Lied', title: 'Filme 1080p', _quality: '1080p', _seeders: 50, _lied: true },
    { infoHash: hClean, name: 'Filme Clean', title: 'Filme 1080p', _quality: '1080p', _seeders: 50, _lied: false },
  ];
  const out = sortAndLimit(streams as any, { preferDubbed: true });
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).infoHash, hClean, 'stream limpo sobrevive; lied some');
});

test('dedupeByHash: favorece release honesta sobre clone lied e limpa _dubbed', () => {
  const hash = '5'.repeat(40);
  const cloneLied = { infoHash: hash, name: 'Lied Clone DUAL\n👤 80', title: 'Filme DUAL 1080p', _seeders: 80, _lied: true, _dubbed: true, _dubClaim: true, _quality: '1080p' };
  const cloneClean = { infoHash: hash, name: 'Clean EN\n👤 20', title: 'Filme EN 1080p', _seeders: 20, _lied: false, _dubbed: false, _dubClaim: false, _quality: '1080p' };
  const out1 = dedupeByHash([cloneLied, cloneClean]);
  assert.equal(out1.length, 1);
  assert.equal(out1[0]._lied, true, 'marca de mentira preservada');
  assert.equal(out1[0]._dubbed, false, 'dublado anulado na fusão com lied');
  assert.equal(out1[0]._dubClaim, false, 'claim anulado na fusão com lied');
  assert.match(String(out1[0].name), /Clean EN/, 'clone limpo escolhido como winner');

  const out2 = dedupeByHash([cloneClean, cloneLied]);
  assert.equal(out2.length, 1);
  assert.equal(out2[0]._lied, true);
  assert.equal(out2[0]._dubbed, false);
  assert.match(String(out2[0].name), /Clean EN/);
});

test('prepareCandidateStreams: hashes em magnetdb.isLie são excluídos da lista', () => {
  const apiKey = 'test-key-lie-instant';
  const liedAliveHash = '6'.repeat(40);
  const cleanHash = '7'.repeat(40);
  const { adapter } = makeFake();
  const origAdapter = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  magnetdb.markAlive('premiumize', apiKey, [liedAliveHash]);
  magnetdb.markLie('premiumize', apiKey, liedAliveHash);
  try {
    const raw = [
      { title: 'Filme 1 1080p', infoHash: liedAliveHash, seeders: 5 },
      { title: 'Filme 2 1080p', infoHash: cleanHash, seeders: 10 },
    ];
    const res = runWith({ opts: { ...userOpts(apiKey), dubbedOnly: false }, encoded: 'seg' }, () =>
      prepareCandidateStreams(raw as any, {})
    );
    assert.equal(res.streams.find((s: any) => s.infoHash === liedAliveHash), undefined, 'isLie some da lista');
    assert.equal(res.streams[0].infoHash, cleanHash);
  } finally {
    debrid.BY_ID.set('premiumize', origAdapter as any);
  }
});

test('sortAndLimit: dubbedOnly descarta streams _lied antecipadamente', () => {
  const hClean = '8'.repeat(40);
  const hLied = '9'.repeat(40);
  const streams = [
    { infoHash: hLied, name: 'Filme Lied', title: 'Filme 1080p', _quality: '1080p', _seeders: 100, _lied: true, _dubClaim: true },
    { infoHash: hClean, name: 'Filme Clean', title: 'Filme 1080p', _quality: '1080p', _seeders: 50, _lied: false, _dubClaim: true },
  ];
  const out = sortAndLimit(streams as any, { dubbedOnly: true });
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).infoHash, hClean, 'stream _lied foi expurgado pelo dubbedOnly');
});

test('sortAndLimit: preferDubbed — _lied some; EN limpo sobra sozinho', () => {
  const hCleanEn = 'e'.repeat(40);
  const hLied = 'f'.repeat(40);
  const streams = [
    { infoHash: hLied, name: 'Filme Lied DUAL\n👤 5000', title: 'Filme 1080p DUAL', _quality: '1080p', _seeders: 5000, _lied: true, _dubbed: true },
    { infoHash: hCleanEn, name: 'Filme Clean EN\n👤 1', title: 'Filme 1080p EN', _quality: '1080p', _seeders: 1, _lied: false, _dubbed: false },
  ];
  const out = sortAndLimit(streams as any, { preferDubbed: true });
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).infoHash, hCleanEn, 'lied some; EN limpo permanece');
});

test('sortAndLimit: d:1 mantém claim, proven E global EN; só _lied some', () => {
  const hClaim = 'b'.repeat(40);
  const hEn = 'c'.repeat(40);
  const hProven = 'd'.repeat(40);
  const hLied = 'e'.repeat(40);
  const streams = [
    { infoHash: hClaim, name: 'Claim', title: 'Filme Dublado 1080p', _quality: '1080p', _seeders: 10, _dubClaim: true, _dubbed: false },
    { infoHash: hEn, name: 'EN', title: 'Filme EN 1080p', _quality: '1080p', _seeders: 50, _dubClaim: false, _dubbed: false },
    { infoHash: hProven, name: 'Proven', title: 'Filme Dual 1080p', _quality: '1080p', _seeders: 5, _dubClaim: true, _dubbed: true },
    { infoHash: hLied, name: 'Lied', title: 'Filme Dublado 1080p', _quality: '1080p', _seeders: 100, _dubClaim: true, _dubbed: false, _lied: true },
  ];
  const out = sortAndLimit(streams as any, { dubbedOnly: true, preferDubbed: true });
  const hashes = out.map((s: any) => s.infoHash);
  assert.ok(hashes.includes(hClaim), 'claim lista sob d:1');
  assert.ok(hashes.includes(hProven), 'proven lista sob d:1');
  assert.ok(hashes.includes(hEn), 'global EN lista sob d:1 (swarm global)');
  assert.ok(!hashes.includes(hLied), 'mentiroso nunca lista');
  assert.equal(hashes[0], hProven, 'preferDubbed sobe prova antes do EN');
});

test('dedupeByHash: permutações de 3 clones preservam título honesto e 500 seeders do enxame', () => {
  const hash = 'a'.repeat(40);
  const clean = { infoHash: hash, name: 'Honest YTS EN\n👤 50', title: 'Honest YTS EN', _seeders: 50, _lied: false, _dubbed: false, _quality: '1080p' };
  const fake1 = { infoHash: hash, name: 'Fake BluDV DUAL\n👤 500', title: 'Fake BluDV DUAL', _seeders: 500, _lied: true, _dubbed: true, _quality: '1080p' };
  const fake2 = { infoHash: hash, name: 'Fake Comando DUAL\n👤 200', title: 'Fake Comando DUAL', _seeders: 200, _lied: true, _dubbed: true, _quality: '1080p' };
  const perms = [
    [clean, fake1, fake2], [clean, fake2, fake1],
    [fake1, clean, fake2], [fake2, clean, fake1],
    [fake1, fake2, clean], [fake2, fake1, clean],
  ];
  for (const p of perms) {
    const out = dedupeByHash(p);
    assert.equal(out.length, 1);
    assert.match(String(out[0].name), /Honest YTS EN/, 'título limpo preservado em todas as permutações');
    assert.equal(out[0]._seeders, 500, 'max seeders do enxame preservado');
    assert.equal(out[0]._lied, true);
    assert.equal(out[0]._dubbed, false);
  }
});

test('prepareCandidateStreams: release com lied: true em raw é excluída do instantSet mesmo marcada alive', () => {
  const apiKey = 'test-raw-lie-instant';
  const liedAliveHash = 'c'.repeat(40);
  const cleanHash = 'd'.repeat(40);
  const { adapter } = makeFake();
  const origAdapter = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  magnetdb.markAlive('premiumize', apiKey, [liedAliveHash]);
  try {
    const raw = [
      { title: 'Filme Fake 1080p', infoHash: liedAliveHash, lied: true, seeders: 1 },
      { title: 'Filme Clean 1080p', infoHash: cleanHash, lied: false, seeders: 100 },
    ];
    const res = runWith({ opts: { ...userOpts(apiKey), dubbedOnly: false }, encoded: 'seg' }, () =>
      prepareCandidateStreams(raw as any, {})
    );
    assert.equal(res.streams.length, 1, '_lied some da lista');
    assert.equal(res.streams[0].infoHash, cleanHash, 'só o clean sobrevive');
  } finally {
    debrid.BY_ID.set('premiumize', origAdapter as any);
  }
});
