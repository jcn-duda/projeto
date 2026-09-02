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
