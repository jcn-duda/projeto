import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid } from '../src/providers/index.js';
import type { Stream, DebridAdapter } from '../types/domain.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const brDub = (h: string, q = '1080p', seeds = 1) => ({
  infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: q, _seeders: seeds,
});
const baseOpts = (key: string, cachedOnly = true) => ({
  ...runtime.defaults(), debridService: 'premiumize', debridApiKey: key, debridCachedOnly: cachedOnly, autoFetchBr: true,
});

function clearDead(adapterId: string, account: string, hashes: string[]) {
  for (const h of hashes) cache.forget(autofetch.deadKey(adapterId, account, h));
}

test('autofetch de série enfileira o pack em vez do episódio avulso', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-pack');
  const ep = '1'.repeat(40);
  const pack = '2'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-pack', true);
  const searchKey = 'busca-pack-serie';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfg-pack' }, () =>
      applyDebrid(
        [
          { infoHash: ep, name: 'Show S01E05 Dual 1080p', _br: false, _dubbed: true, _quality: '1080p', _seeders: 80 },
          { infoHash: pack, name: 'Show S01 Dual 480p', _br: false, _dubbed: true, _quality: '480p', _seeders: 1 },
        ],
        { searchKey, season: 1, episode: 5 } as any,
      ),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [pack, ep], 'série: o pack é enfileirado antes do episódio');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [ep, pack]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('BR dublado em cache trava o autofetch mesmo com o infoHash em MAIÚSCULO', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-caixa');
  const lower = 'abcdef0123456789abcdef0123456789abcdef01';
  const upper = lower.toUpperCase();
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-caixa', false);
  const searchKey = 'busca-caixa-hash';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([lower]), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfg-caixa' }, () => applyDebrid([brDub(upper)], { searchKey } as any));
    await sleep(20);

    assert.deepEqual(enqueued, [], 'cacheado em minúsculo casa com o candidato em maiúsculo');
    assert.equal(held.isHeld(upper, account), false, 'sem download a proteger, o hold é liberado');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, upper));
    held.release(upper, account);
  }
});

test('marker pré-existente pula apenas o hash marcado; um candidato diferente ainda enfileira', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-marker');
  const x = 'x'.repeat(40);
  const y = 'y'.repeat(40);
  const markerX = autofetch.markerKey('premiumize', account, x);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-marker', true);
  const run = (h: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfgm' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(markerX, 1, 3600);

    await run(x, 'busca-marker-x');
    await sleep(20);
    assert.deepEqual(enqueued, [], 'hash com marker confirmado não reenfileira');

    await run(y, 'busca-marker-y');
    await sleep(20);
    assert.deepEqual(enqueued, [y], 'hash sem marker continua enfileirando');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, y)), 1, 'o aceite de Y grava o marker dele');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch('busca-marker-x');
    autofetch.releaseSearch('busca-marker-y');
    cache.forget(markerX);
    cache.forget(autofetch.markerKey('premiumize', account, y));
    held.release(x, account);
    held.release(y, account);
  }
});

test('passe parcial e tardio no MESMO searchKey compartilham teto de três enqueues', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-dupla');
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const h3 = '3'.repeat(40);
  const h4 = '4'.repeat(40);
  const h5 = '5'.repeat(40);
  const h6 = '6'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-dupla', true);
  const searchKey = 'busca-dupla-passe';
  const run = (h: any) => runtime.run({ opts: userOpts, encoded: 'cfgd' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    await run(h1);
    await sleep(20);
    assert.deepEqual(enqueued, [h1], 'primeiro passe enfileira o candidato parcial');

    await run(h1);
    await sleep(20);
    assert.equal(enqueued.length, 1, 'repetição do mesmo passe é barrada pelo marker');

    await run(h2);
    await run(h3);
    await run(h4);
    await run(h5);
    await run(h6);
    await sleep(20);
    assert.deepEqual(enqueued, [h1, h2, h3], 'o teto compartilhado barra o quarto candidato');
    assert.equal(held.isHeld(h4, account), false, 'o quarto candidato é liberado do hold');
    assert.equal(held.isHeld(h5, account), false, 'o quinto candidato é liberado do hold');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h1));
    for (const hash of [h1, h2, h3, h4, h5, h6]) {
      cache.forget(autofetch.markerKey('premiumize', account, hash));
      held.release(hash, account);
    }
  }
});
