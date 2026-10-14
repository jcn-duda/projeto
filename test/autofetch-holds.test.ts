import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';

test('applyDebrid responde sem esperar o enqueue lento (disparo é efeito colateral, não resposta)', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-lenta');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h = '5'.repeat(40);
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  let enqueueStarted = 0;
  pmAdapter.enqueue = async () => { enqueueStarted++; await sleep(300); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-lenta',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-enqueue-lento';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const started = Date.now();
    await runtime.run({ opts: userOpts, encoded: 'cfg5' }, () =>
      applyDebrid([brDub(h)], { searchKey } as any),
    );
    const elapsed = Date.now() - started;

    assert.equal(enqueueStarted, 1, 'o enqueue foi disparado');
    assert.ok(elapsed < 250, `applyDebrid não esperou o enqueue de 300ms (respondeu em ${elapsed}ms)`);
    // Deixa a cadeia do aceite terminar para o marker ser gravado e o estado
    // poder ser limpo de forma determinística.
    await sleep(350);
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h)), 1, 'aceite confirmado grava o marker');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('holds: protege antes da checagem, sobrevive ao aceite, e recusa/falha/known:false liberam', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalRegistryEnqueue = debrid.enqueue;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalAdapterEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-holds');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  const h1 = 'a'.repeat(40);
  const h2 = 'b'.repeat(40);
  const h3 = 'c'.repeat(40);
  const h4 = 'd'.repeat(40);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-holds',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (h: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfgh' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;

    // (1) O hold acontece ANTES da checagem de cache — é ele que impede o
    // dropUncached (um upload, na AllDebrid) de apagar o download no meio da
    // busca. A checagem é o momento crítico; se o hash estiver protegido ali,
    // a limpeza não o toca.
    let heldDuringCheck = false;
    debrid.checkCached = async () => {
      heldDuringCheck = held.isHeld(h1, account);
      return { cached: new Set(), known: true };
    };
    await run(h1, 'hold-aceite');
    assert.equal(heldDuringCheck, true, 'candidato já protegido quando a checagem roda');
    await sleep(20);
    assert.equal(held.isHeld(h1, account), true, 'após o aceite o hold sobrevive até o TTL');
    assert.equal(held.isHeld(h1, 'outra-conta'), false, 'o hold é isolado por conta');

    // (2) known:false libera o hold na hora: sem resposta confiável não há
    // download em andamento para proteger.
    debrid.checkCached = async () => ({ cached: new Set(), known: false });
    await run(h2, 'hold-known-false');
    assert.equal(held.isHeld(h2, account), false, 'known:false libera o candidato');

    // (3) Recusa do serviço (enqueue resolve false) libera o hold e não grava
    // marker — o download não aconteceu, não há o que deduplicar nem proteger.
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    pmAdapter.enqueue = async () => false;
    await run(h3, 'hold-recusa');
    await sleep(20);
    assert.equal(held.isHeld(h3, account), false, 'recusa libera o hold');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h3)), null, 'recusa não grava marker');

    // (4) Falha do enqueue (rejeição) também libera hold, marker e trava de busca.
    debrid.enqueue = async () => { throw new Error('falha simulada'); };
    await run(h4, 'hold-falha');
    await sleep(20);
    assert.equal(held.isHeld(h4, account), false, 'falha libera o hold');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h4)), null, 'falha não grava marker');
  } finally {
    debrid.checkCached = originalCheck;
    debrid.enqueue = originalRegistryEnqueue;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalAdapterEnqueue;
    for (const h of [h1, h2, h3, h4]) {
      held.release(h, account);
      cache.forget(autofetch.markerKey('premiumize', account, h));
    }
    autofetch.releaseSearch('hold-aceite');
    autofetch.releaseSearch('hold-known-false');
    autofetch.releaseSearch('hold-recusa');
    autofetch.releaseSearch('hold-falha');
  }
});

test('falha definitiva do enqueue não é retentada: libera hold e slot sem marker', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-definitiva');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h = '8'.repeat(40);
  const brDub = {
    infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-definitiva',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-falha-definitiva';
  const run = () => runtime.run({ opts: userOpts, encoded: 'cfg-df' }, () =>
    applyDebrid([brDub], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    // ECONNRESET não é cooldown: nada indica que repetir vai dar certo, então
    // o retry precisa ficar só no estado de cooldown.
    let calls = 0;
    pmAdapter.enqueue = async () => { calls += 1; throw new Error('ECONNRESET'); };
    await run();
    await sleep(50);
    assert.equal(calls, 1, 'falha definitiva não é retentada');
    assert.equal(held.isHeld(h, account), false, 'falha definitiva libera o hold');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h)), null, 'falha definitiva não grava marker');

    // O slot devolvido deixa uma nova busca no MESMO searchKey tentar de novo.
    pmAdapter.enqueue = async () => { calls += 1; return true; };
    await run();
    await sleep(50);
    assert.equal(calls, 2, 'o slot liberado permite o próximo enqueue');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h)), 1, 'a tentativa nova grava o marker');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('passe tardio não duplica o candidato do parcial enquanto o enqueue ainda roda', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-nao-duplica');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const brDub = (hash: any, q = '1080p') => ({
    infoHash: hash, name: `Coringa Dublado ${q}`, _br: true, _dubbed: true, _quality: q, _seeders: 1,
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-nao-duplica',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const searchKey = 'busca-nao-duplica';
  const run = (streams: any) => runtime.run({ opts: userOpts, encoded: 'cfg-nd' }, () =>
    applyDebrid(streams, { searchKey } as any),
  );

  let openEnqueue: (value?: any) => void = () => {};
  const gate = new Promise((resolve) => { openEnqueue = resolve; });
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => {
    enqueued.push(infoHash);
    await gate; // o primeiro enqueue fica em voo enquanto o passe tardio chega
    return true;
  };

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    // Passe parcial: enfileira h1 (1080) e o enqueue fica em voo.
    await run([brDub(h1)]);
    await sleep(10);

    // Passe tardio: mesmo h1 + h2 em OUTRA faixa (720). Com 1× por qualidade,
    // o 720 é candidato novo; h1 não duplica graças à trava em memória.
    await run([brDub(h1), brDub(h2, '720p')]);
    await sleep(20);
    assert.deepEqual(enqueued, [h1, h2], 'h1 não é duplicado pelo passe tardio');

    openEnqueue();
    await sleep(50);
    assert.equal(enqueued.length, 2, 'após a fila esvaziar o total continua o mesmo');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h1)), 1, 'o aceite do parcial grava o marker');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h2)), 1, 'o candidato novo do tardio também');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});
