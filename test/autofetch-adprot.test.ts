import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';

const adprotAccount = (key: string) => accountScope(key);

test('adprot: protectBr só cria no AllDebrid e com o kill switch ligado', () => {
  const account = adprotAccount('conta-adprot-kill');
  const h = 'a0'.repeat(20);
  const originalProtect = config.debrid.autoFetchProtectBr;
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    // Fora do AllDebrid: nenhum registro.
    held.protectBr('premiumize', account, h);
    assert.equal(held.isDurablyProtected('premiumize', account, h), false, 'só o AllDebrid recebe a proteção');
    assert.equal(held.isDurablyProtected('alldebrid', account, h), false);

    // Kill switch desligado: nem o AllDebrid cria.
    config.debrid.autoFetchProtectBr = false;
    held.protectBr('alldebrid', account, h);
    assert.equal(held.isDurablyProtected('alldebrid', account, h), false, 'com o switch desligado nada é retido');
    assert.equal((metrics.snapshot().counters['adprot.set'] || 0), 0);

    // Religado: o aceite cria de verdade.
    config.debrid.autoFetchProtectBr = true;
    held.protectBr('alldebrid', account, h);
    assert.equal(held.isDurablyProtected('alldebrid', account, h), true);
    assert.equal(metrics.snapshot().counters['adprot.set'], 1);
  } finally {
    config.debrid.autoFetchProtectBr = originalProtect;
    held.unprotect('alldebrid', account, h);
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot: a proteção é por adapter, por conta e por hash (com hash case-insensitive)', () => {
  const a1 = adprotAccount('conta-adprot-isola-a');
  const a2 = adprotAccount('conta-adprot-isola-b');
  const h1 = 'b1'.repeat(20);
  const h2 = 'b2'.repeat(20);
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    held.protectBr('alldebrid', a1, h1);
    assert.equal(held.isDurablyProtected('alldebrid', a1, h1), true);
    assert.equal(held.isDurablyProtected('alldebrid', a1, h2), false, 'hash vizinho não herda a retenção');
    assert.equal(held.isDurablyProtected('alldebrid', a2, h1), false, 'outra conta não enxerga o registro');
    assert.equal(held.isDurablyProtected('premiumize', a1, h1), false, 'outro adapter não enxerga o registro');
    // A AllDebrid devolve o hash em MAIÚSCULO; o registro é normalizado.
    assert.equal(held.isDurablyProtected('alldebrid', a1, h1.toUpperCase()), true);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot: a proteção dura além do hold volátil — "restart" não a derruba', () => {
  const account = adprotAccount('conta-adprot-restart');
  const h = 'c0'.repeat(20);
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    held.protectBr('alldebrid', account, h);
    // Sem hold: é o esqueleto que o restart deixa (o Map volátil some).
    held.release(h, account);
    assert.equal(held.isHeld(h, account), false, 'hold volátil liberado');
    assert.equal(held.isDurablyProtected('alldebrid', account, h), true, 'o registro persistido sobrevive ao restart');
    assert.equal(held.isCleanupProtected(h, account, 'alldebrid'), true, 'sem hold, o durável sozinho já poupa a limpeza');

    // Re-submeter o mesmo hash não reinicia a janela do pruneMissing (idempotente).
    held.protectBr('alldebrid', account, h);
    assert.equal(metrics.snapshot().counters['adprot.set'], 1, 'aceite repetido não regrava o acceptedAt');
  } finally {
    held.unprotect('alldebrid', account, h);
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot: noteReady assenta o ready só na transição e não regrava a cada leitura', () => {
  const account = adprotAccount('conta-adprot-ready');
  const h = 'd0'.repeat(20);
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    held.protectBr('alldebrid', account, h);
    held.noteReady('alldebrid', account, h);
    let snap = metrics.snapshot();
    assert.equal(snap.counters['adprot.set'], 1, 'um aceite');
    assert.equal(snap.counters['adprot.ready'], 1, 'a transição para pronto conta uma vez');

    // Ready já conhecido e registro longe de expirar: a leitura não reescreve.
    held.noteReady('alldebrid', account, h);
    snap = metrics.snapshot();
    assert.equal(snap.counters['adprot.ready'], 1, 'ready repetido não conta de novo');
    assert.equal(snap.counters['adprot.renewed'] || 0, 0, 'renovação só quando metade do TTL vence');

    // Fora do AllDebrid ou sem registro, é no-op silencioso.
    held.noteReady('premiumize', account, h);
    held.noteReady('alldebrid', account, 'e0'.repeat(20));
    snap = metrics.snapshot();
    assert.equal(snap.counters['adprot.ready'], 1);
    assert.equal(snap.counters['adprot.set'], 1);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot: unprotect remove a retenção de forma idempotente', () => {
  const account = adprotAccount('conta-adprot-unprotect');
  const h = 'f0'.repeat(20);
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    held.protectBr('alldebrid', account, h);
    assert.equal(held.isDurablyProtected('alldebrid', account, h), true);
    held.unprotect('alldebrid', account, h);
    assert.equal(held.isDurablyProtected('alldebrid', account, h), false, 'unprotect derruba o registro');
    assert.equal(metrics.snapshot().counters['adprot.cleared'], 1);
    held.unprotect('alldebrid', account, h);
    assert.equal(metrics.snapshot().counters['adprot.cleared'], 1, 'sem registro, unprotect não conta nem quebra');
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot: pruneMissing respeita presente, graça e hold; só o ausente envelhecido sai', () => {
  const account = adprotAccount('conta-adprot-prune');
  const hPresent = 'aa'.repeat(20);
  const hGrace = 'ab'.repeat(20);
  const hHold = 'ac'.repeat(20);
  const hFora = 'ad'.repeat(20);
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    held.protectBr('alldebrid', account, hPresent);
    held.protectBr('alldebrid', account, hGrace);
    held.protectBr('alldebrid', account, hHold);
    held.protectBr('alldebrid', account, hFora);

    assert.equal(held.pruneMissing('alldebrid', account, [hPresent, hGrace, hHold, hFora], 0), 0);

    assert.equal(held.pruneMissing('alldebrid', account, [hPresent], 3600_000), 0);
    assert.equal(held.isDurablyProtected('alldebrid', account, hGrace), true);
    assert.equal(held.isDurablyProtected('alldebrid', account, hFora), true);

    held.hold(hHold, 60, account);
    assert.equal(held.pruneMissing('alldebrid', account, [hPresent], 0), 2);
    assert.equal(held.isDurablyProtected('alldebrid', account, hGrace), false);
    assert.equal(held.isDurablyProtected('alldebrid', account, hFora), false);
    assert.equal(held.isDurablyProtected('alldebrid', account, hHold), true, 'hold adia a poda');
    assert.equal(held.isDurablyProtected('alldebrid', account, hPresent), true, 'o presente sobrevive à passada');
    held.release(hHold, account);

    assert.equal(held.pruneMissing('alldebrid', account, [hPresent], 0), 1);
    assert.equal(held.isDurablyProtected('alldebrid', account, hHold), false);
  } finally {
    held.release(hHold, account);
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot: reset por cache.clearNamespace(adprot) derruba a retenção inteira', () => {
  const a1 = adprotAccount('conta-adprot-reset-a');
  const a2 = adprotAccount('conta-adprot-reset-b');
  const h1 = 'ba'.repeat(20);
  const h2 = 'bb'.repeat(20);
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    held.protectBr('alldebrid', a1, h1);
    held.protectBr('alldebrid', a2, h2);
    assert.equal(held.isDurablyProtected('alldebrid', a1, h1), true);
    assert.equal(held.isDurablyProtected('alldebrid', a2, h2), true);
    const cleared = cache.clearNamespace('adprot');
    assert.equal(cleared, 2, 'a limpeza seletiva devolve quantos registros removeu');
    assert.equal(held.isDurablyProtected('alldebrid', a1, h1), false);
    assert.equal(held.isDurablyProtected('alldebrid', a2, h2), false);
    assert.equal(held.pruneMissing('alldebrid', a1, [], 0), 0, 'namespace resetado não tem o que podar');
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot integrado: aceite do pool BR no AllDebrid cria a proteção durável', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalProtect = config.debrid.autoFetchProtectBr;
  const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalEnqueue = adAdapter.enqueue;
  const apiKey = 'chave-adprot-br';
  const account = accountScope(apiKey);
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h = 'c1'.repeat(20);
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const enqueued: string[] = [];
  cache.clearNamespace('adprot');
  metrics.reset();

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchProtectBr = true;
    adAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid',
      debridApiKey: apiKey,
      debridCachedOnly: true,
      autoFetchBr: true,
    };
    await runtime.run({ opts: userOpts, encoded: 'cfg-adprot-br' }, () =>
      applyDebrid([brDub], { searchKey: 'busca-adprot-br' } as any),
    );
    await sleep(30);

    assert.deepEqual(enqueued, [h], 'o BR dublado do pool br é enfileirado no AllDebrid');
    assert.equal(held.isDurablyProtected('alldebrid', account, h), true, 'aceite do pool br cria a retenção');
    assert.equal(metrics.snapshot().counters['adprot.set'], 1);
    held.release(h, account);
    assert.equal(held.isDurablyProtected('alldebrid', account, h), true, 'sem hold volátil, o durável segue de pé');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchProtectBr = originalProtect;
    adAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch('busca-adprot-br');
    cache.forget(autofetch.markerKey('alldebrid', account, h));
    held.release(h, account);
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot integrado: pools any/seeds e o BR mentiroso (_lied) não criam proteção', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalAny = config.debrid.autoFetchAnyDubbed;
  const originalTopSeeds = config.debrid.autoFetchTopSeeds;
  const originalProtect = config.debrid.autoFetchProtectBr;
  const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalEnqueue = adAdapter.enqueue;
  const apiKey = 'chave-adprot-negativos';
  const account = accountScope(apiKey);
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const hAny = 'd1'.repeat(20);
  const hSeeds = 'd2'.repeat(20);
  const hLied = 'd3'.repeat(20);
  const enqueued: string[] = [];
  cache.clearNamespace('adprot');
  metrics.reset();

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchProtectBr = true;
    config.debrid.autoFetchAnyDubbed = true;
    config.debrid.autoFetchTopSeeds = true;
    adAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid',
      debridApiKey: apiKey,
      debridCachedOnly: true,
      autoFetchBr: true,
    };
    const run = (streams: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfg-adprot-neg' }, () =>
      applyDebrid(streams, { searchKey } as any),
    );

    await run([{ infoHash: hAny, name: 'Movie Dual', _br: false, _dubbed: true, _quality: '1080p', _seeders: 3 }], 'busca-adprot-any');
    await sleep(30);
    assert.deepEqual(enqueued, [hAny], 'pool any enfileira a dublada global');
    assert.equal(held.isDurablyProtected('alldebrid', account, hAny), false, 'pool any não cria proteção');

    await run([{ infoHash: hSeeds, name: 'Filme 1080p', _br: false, _dubbed: false, _quality: '1080p', _seeders: 400 }], 'busca-adprot-seeds');
    await sleep(30);
    assert.deepEqual(enqueued, [hAny, hSeeds], 'pool seeds enfileira o melhor swarm');
    assert.equal(held.isDurablyProtected('alldebrid', account, hSeeds), false, 'pool seeds não cria proteção');

    await run([{ infoHash: hLied, name: 'Coringa Dublado', _br: true, _dubbed: true, _lied: true, _quality: '1080p', _seeders: 1 }], 'busca-adprot-lied');
    await sleep(30);
    assert.deepEqual(enqueued, [hAny, hSeeds], 'release _lied é cortada antes do autofetch');
    assert.equal(held.isHeld(hLied, account), false, 'sem candidato, nem hold é criado');
    assert.equal(held.isDurablyProtected('alldebrid', account, hLied), false, '_lied nunca entra no acervo retido');

    assert.equal(metrics.snapshot().counters['adprot.set'] || 0, 0, 'nenhum dos três pools criou retenção');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchAnyDubbed = originalAny;
    config.debrid.autoFetchTopSeeds = originalTopSeeds;
    config.debrid.autoFetchProtectBr = originalProtect;
    adAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch('busca-adprot-any');
    autofetch.releaseSearch('busca-adprot-seeds');
    autofetch.releaseSearch('busca-adprot-lied');
    for (const h of [hAny, hSeeds, hLied]) {
      cache.forget(autofetch.markerKey('alldebrid', account, h));
      held.release(h, account);
    }
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});

test('adprot integrado: recusa e falha do enqueue não criam proteção', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalProtect = config.debrid.autoFetchProtectBr;
  const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalEnqueue = adAdapter.enqueue;
  const apiKey = 'chave-adprot-recusa';
  const account = accountScope(apiKey);
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const hRecusa = 'e1'.repeat(20);
  const hFalha = 'e2'.repeat(20);
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });
  cache.clearNamespace('adprot');
  metrics.reset();

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchProtectBr = true;
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid',
      debridApiKey: apiKey,
      debridCachedOnly: true,
      autoFetchBr: true,
    };
    const run = (hash: string, searchKey: string) => runtime.run({ opts: userOpts, encoded: 'cfg-adprot-rec' }, () =>
      applyDebrid([brDub(hash)], { searchKey } as any),
    );

    adAdapter.enqueue = async () => false;
    await run(hRecusa, 'busca-adprot-recusa');
    await sleep(30);
    assert.equal(held.isDurablyProtected('alldebrid', account, hRecusa), false, 'recusa não cria proteção');
    assert.equal(cache.get(autofetch.markerKey('alldebrid', account, hRecusa)), null, 'recusa também não grava marker');

    adAdapter.enqueue = async () => { throw new Error('falha simulada'); };
    await run(hFalha, 'busca-adprot-falha');
    await sleep(30);
    assert.equal(held.isDurablyProtected('alldebrid', account, hFalha), false);
    assert.equal(held.isHeld(hFalha, account), false, 'falha libera o hold do candidato');
    assert.equal(metrics.snapshot().counters['adprot.set'] || 0, 0, 'nem recusa nem falha retêm nada');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchProtectBr = originalProtect;
    adAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch('busca-adprot-recusa');
    autofetch.releaseSearch('busca-adprot-falha');
    cache.forget(autofetch.markerKey('alldebrid', account, hRecusa));
    cache.forget(autofetch.markerKey('alldebrid', account, hFalha));
    held.release(hRecusa, account);
    held.release(hFalha, account);
    cache.clearNamespace('adprot');
    metrics.reset();
  }
});
