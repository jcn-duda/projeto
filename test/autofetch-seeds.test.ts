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

// Filme sem dublagem NENHUMA (o caso Beyond Re-Animator): o pool BR volta
// vazio, o global dublado também, e antes o terceiro nível era pulado porque
// exigia season != null. Resultado: nada baixado, e com somente já em
// cache ligado o usuário via zero opção em toda busca, para sempre.
test('terceiro nível: filme sem dublado nenhum enfileira os melhores por seeders', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-seeds-filme');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const h3 = '3'.repeat(40);
  const cam = '4'.repeat(40);
  const morto = '5'.repeat(40);
  const leg = (h: any, name: any, seeds: any) => ({
    infoHash: h, name, title: name, _br: false, _dubbed: false, _seeders: seeds,
  });
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-seeds-filme',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-seeds-filme';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-seeds-filme' }, () =>
      applyDebrid(
        [
          leg(h1, 'Beyond Re-Animator 2003 1080p BluRay', 47),
          leg(h3, 'Beyond Re-Animator 2003 720p WEB-DL', 5),
          leg(h2, 'Beyond Re-Animator 2003 1080p WEBRip', 59),
          // CAM não entra nem com o maior swarm da lista.
          leg(cam, 'Beyond Re-Animator 2003 HDCAM', 900),
          // Abaixo do piso de seeders: morre na fila do debrid.
          leg(morto, 'Beyond Re-Animator 2003 DVDRip', 1),
        ],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    // Teto de 2 (autoFetchTopSeedsMax), na ordem do swarm: 59 e depois 47.
    assert.deepEqual(enqueued, [h2, h1], 'os dois maiores swarms saudáveis são enfileirados');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2, h3, cam, morto]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// O gate do terceiro nível é NADA toca: um único stream pronto já entrega
// play, e gastar a conta baixando outro não melhora nada para o usuário.
test('terceiro nível não dispara quando já existe qualquer fonte tocável', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-seeds-gate');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const pronto = 'a'.repeat(40);
  const outro = 'b'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-seeds-gate',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-seeds-gate';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([pronto]), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-seeds-gate' }, () =>
      applyDebrid(
        [
          { infoHash: pronto, name: 'Filme 720p', title: 'Filme 720p', _seeders: 4 },
          { infoHash: outro, name: 'Filme 1080p', title: 'Filme 1080p', _seeders: 400 },
        ],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [], 'com algo tocável, o terceiro nível fica quieto');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [pronto, outro]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// ANY off não pode abortar a cascata: com dublada global presente e o
// operador recusando DEBRID_AUTO_FETCH_ANY, o terceiro nível (swarm) ainda
// precisa disparar — o return [] antigo engolia o seeds justamente aí.
test('ANY off + topSeeds: enfileira o maior swarm, não a dublada global', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalAny = config.debrid.autoFetchAnyDubbed;
  const originalTopSeeds = config.debrid.autoFetchTopSeeds;
  const originalTopMax = config.debrid.autoFetchTopSeedsMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-any-off-seeds');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const hDub = 'c'.repeat(40);
  const hSwarm = 'd'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-any-off-seeds',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-any-off-seeds';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchAnyDubbed = false;
    config.debrid.autoFetchTopSeeds = true;
    // Um só: prova que o escolhido é o swarm, não a dublada do pool any.
    config.debrid.autoFetchTopSeedsMax = 1;
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-any-off-seeds' }, () =>
      applyDebrid(
        [
          // Dual sem sinal PT no título: entra no pool any via _dubbed, mas
          // no seeds não ganha preferência PT — o swarm maior vence.
          {
            infoHash: hDub, name: 'Cult Film 2010 Dual', title: 'Cult Film 2010 Dual',
            _br: false, _dubbed: true, _seeders: 20,
          },
          {
            infoHash: hSwarm, name: 'Cult Film 2010 BluRay', title: 'Cult Film 2010 BluRay',
            _br: false, _dubbed: false, _seeders: 80,
          },
        ],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [hSwarm], 'com ANY off o candidato é o maior swarm, não a dublada');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchAnyDubbed = originalAny;
    config.debrid.autoFetchTopSeeds = originalTopSeeds;
    config.debrid.autoFetchTopSeedsMax = originalTopMax;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [hDub, hSwarm]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// A vaga do enqueue usa o teto do pool: seeds respeita autoFetchTopSeedsMax,
// não o autoFetchMax do BR/any — senão Max=1 engolia o segundo swarm saudável.
test('pool seeds: vaga usa autoFetchTopSeedsMax, não autoFetchMax', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalMax = config.debrid.autoFetchMax;
  const originalTopSeeds = config.debrid.autoFetchTopSeeds;
  const originalTopMax = config.debrid.autoFetchTopSeedsMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-seeds-slot');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h1 = 'e'.repeat(40);
  const h2 = 'f'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-seeds-slot',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-seeds-slot';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchMax = 1;
    config.debrid.autoFetchTopSeeds = true;
    config.debrid.autoFetchTopSeedsMax = 2;
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-seeds-slot' }, () =>
      applyDebrid(
        [
          { infoHash: h1, name: 'Obscure 1999 1080p', title: 'Obscure 1999 1080p', _seeders: 40 },
          { infoHash: h2, name: 'Obscure 1999 720p', title: 'Obscure 1999 720p', _seeders: 55 },
        ],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [h2, h1], 'TopSeedsMax=2 enfileira os dois swarms mesmo com Max=1');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchMax = originalMax;
    config.debrid.autoFetchTopSeeds = originalTopSeeds;
    config.debrid.autoFetchTopSeedsMax = originalTopMax;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});
