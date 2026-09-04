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

test('matriz integrada: 4 BR uncached enfileiram 1 por qualidade-alvo (1080+720+4K)', async () => {
  autofetchLive.reset();
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalResolveUncached = config.debrid.resolveUncached;
  config.debrid.resolveUncached = false;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-quatro-surplus');
  // Hashes únicos — evita colisão com blacklist/dead de outros testes no mesmo processo.
  const h1 = 'aa11111111111111111111111111111111111111';
  const h2 = 'aa22222222222222222222222222222222222222';
  const h3 = 'aa33333333333333333333333333333333333333';
  const h4 = 'aa44444444444444444444444444444444444444';
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-quatro-surplus', false);
  const searchKey = 'busca-quatro-br-surplus';

  try {
    clearDead('premiumize', account, [h1, h2, h3, h4]);
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const out = await runtime.run({ opts: userOpts, encoded: 'cfg4s' }, () =>
      applyDebrid([brDub(h4, '2160p', 999), brDub(h3, '720p', 100), brDub(h2, '1080p', 5), brDub(h1, '1080p', 1)], { searchKey } as any),
    ) as Stream[];
    await sleep(20);

    // Ordem do pool: 1080 → 720 → 2160; só 1 por faixa no immediate (h1 perde pro h2).
    assert.deepEqual(enqueued, [h2, h3, h4], '1×1080 + 1×720 + 1×4K');
    assert.equal(out.length, 4, 'dc=false mantém os 4 BR na lista');
    assert.ok(out.every((s) => s.infoHash), 'lista sai como torrent puro, sem selo ⚡');
    // Surplus: 2º 1080 (h1) vai pra fila — reposição se o primário não carregar.
    const queued = autofetch.readQueue(searchKey);
    assert.equal(queued.length, 1, 'fila BR não vazia com 2º magnet na mesma faixa');
    assert.equal(String(queued[0].infoHash).toLowerCase(), h1);
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolveUncached;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    clearDead('premiumize', account, [h1, h2, h3, h4]);
    for (const h of [h1, h2, h3, h4]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('matriz integrada: dc=false com mesma qualidade já em cache não enfileira', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-sete');
  const h = '7'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-sete', false);
  const searchKey = 'busca-dc-false-cached';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([h]), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfg7' }, () => applyDebrid([brDub(h)], { searchKey } as any));
    await sleep(20);

    assert.deepEqual(enqueued, [], 'mesma faixa já tocável encerra o autofetch mesmo com dc=false');
    assert.equal(held.isHeld(h, account), false, 'sem download a proteger, o hold é liberado na hora');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('matriz integrada: 720 Dual ⚡ não bloqueia upgrade 1080/4K', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalResolveUncached = config.debrid.resolveUncached;
  config.debrid.resolveUncached = false;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-upgrade');
  const h720 = 'a'.repeat(40);
  const h1080 = 'b'.repeat(40);
  const h4k = 'c'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-upgrade', false);
  const searchKey = 'busca-upgrade-q';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([h720]), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfgu' }, () =>
      applyDebrid([
        brDub(h720, '720p', 50),
        brDub(h1080, '1080p', 10),
        brDub(h4k, '2160p', 5),
      ], { searchKey } as any),
    );
    await sleep(20);

    assert.deepEqual(enqueued, [h1080, h4k], '720 cacheado libera upgrade 1080 e 4K');
    assert.equal(held.isHeld(h720, account), false, 'hold do 720 coberto é liberado');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolveUncached;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h720, h1080, h4k]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('fallback global: sem BR dublado na busca, as melhores dubladas globais são enfileiradas', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-any');
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const h3 = '3'.repeat(40);
  const globalDub = (h: any, q: any, seeds: any) => ({
    infoHash: h, name: 'Movie Dual', _br: false, _dubbed: true, _quality: q, _seeders: seeds,
  });
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-any', true);
  const searchKey = 'busca-any-global';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-any' }, () =>
      applyDebrid([globalDub(h3, '720p', 100), globalDub(h2, '1080p', 9), globalDub(h1, '1080p', 1)], { searchKey } as any),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [h2, h1, h3], 'sem BR na busca, as dubladas globais são enfileiradas');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2, h3]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('fallback global respeita os gates: stream tocável, BR presente e toggle off não baixam global', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalAny = config.debrid.autoFetchAnyDubbed;
  const originalTopSeeds = config.debrid.autoFetchTopSeeds;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-any-gates');
  const g = 'g'.repeat(40);
  const other = 'h'.repeat(40);
  const br = 'i'.repeat(40);
  const globalDub = { infoHash: g, name: 'Movie Dual', _br: false, _dubbed: true, _quality: '1080p', _seeders: 3 };
  const globalLeg = { infoHash: other, name: 'Movie 1080p', _br: false, _dubbed: false, _quality: '1080p', _seeders: 3 };
  const brDubCandidate = { infoHash: br, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '480p', _seeders: 1 };
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = baseOpts('chave-any-gates', true);
  const run = (streams: any, searchKey: any, cached = [] as string[]) => {
    debrid.checkCached = async () => ({ cached: new Set(cached), known: true });
    return runtime.run({ opts: userOpts, encoded: 'cfg-gates' }, () => applyDebrid(streams, { searchKey } as any));
  };

  try {
    config.debrid.publicUrl = 'http://addon.test';

    await run([globalDub, globalLeg], 'busca-any-tocavel', [other]);
    await sleep(20);
    assert.deepEqual(enqueued, [], 'stream tocável (mesmo legendado) barra o fallback global');

    await run([globalDub, brDubCandidate], 'busca-any-com-br');
    await sleep(20);
    assert.deepEqual(enqueued, [br], 'com fonte BR na busca, o candidato é o BR');

    // Isola o gate do ANY: sem topSeeds a cascata para em no-candidate.
    config.debrid.autoFetchAnyDubbed = false;
    config.debrid.autoFetchTopSeeds = false;
    await run([globalDub], 'busca-any-off');
    await sleep(20);
    assert.deepEqual(enqueued, [br], 'DEBRID_AUTO_FETCH_ANY=false não enfileira pelo pool any');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchAnyDubbed = originalAny;
    config.debrid.autoFetchTopSeeds = originalTopSeeds;
    pmAdapter.enqueue = originalEnqueue;
    for (const key of ['busca-any-tocavel', 'busca-any-com-br', 'busca-any-off']) {
      autofetch.releaseSearch(key);
    }
    for (const h of [g, other, br]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

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
