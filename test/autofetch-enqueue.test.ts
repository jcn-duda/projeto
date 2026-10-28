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
import { kvForget, kvPeek } from '../src/utils/native-kv.js';
import { applyDebrid } from './helpers/pipeline-oracle/index.js';
import type { Stream, DebridAdapter } from '../types/domain.js';
import { createApp } from '../src/app.js';
import { createTestServer, encodeConfig, withMockFetch } from './e2e/e2e-harness.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const brDub = (h: string, q = '1080p', seeds = 1) => ({
  infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: q, _seeders: seeds,
});
const baseOpts = (key: string, cachedOnly = true) => ({
  ...runtime.defaults(), debridService: 'premiumize', debridApiKey: key, debridCachedOnly: cachedOnly, autoFetchBr: true,
});

function clearDead(adapterId: string, account: string, hashes: string[]) {
  for (const h of hashes) kvForget(autofetch.deadKey(adapterId, account, h));
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
    // Surplus: o 2º 1080 (h1) sai no `pick.queue` do `decideAutofetch` — mesmo
    // contrato do excedente provado em `autofetch-seeds-rare.test.ts:141` —, mas o
    // escritor único de `autofetch:v3:q:` é o worker nativo: o oráculo devolve a
    // escolha e NÃO grava o KV (leva B4).
    assert.deepEqual(autofetch.readQueue(searchKey), [], 'oráculo não escreve a fila');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolveUncached;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    clearDead('premiumize', account, [h1, h2, h3, h4]);
    for (const h of [h1, h2, h3, h4]) {
      kvForget(autofetch.markerKey('premiumize', account, h));
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
    kvForget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('autofetch aceito grava o marker e a busca repetida reconhece o cache', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const key = 'chave-ciclo-indice';
  const account = accountScope(key);
  const hash = 'e1'.repeat(20);
  const imdbId = 'tt9000199';
  const searchKey = 'busca-ciclo-indice';
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    await runtime.run({ opts: baseOpts(key, false), encoded: 'cfg-ciclo' }, () =>
      applyDebrid([brDub(hash)], { searchKey, imdbId } as any));
    await sleep(20);
    assert.deepEqual(enqueued, [hash], 'o BR frio sai para a conta uma vez');
    // O registro durável do aceite pós-B4 é o MARKER (o nativo grava a mesma
    // forma). `recordAutofetchRelease` morreu com o runner e o worker não o
    // substituiu: o índice da obra não recebe mais a release do autofetch — a
    // cobertura segue sem declarar nada (a régua é `idxPoolCovered`/`br_gap`).
    assert.equal(kvPeek(autofetch.markerKey('premiumize', account, hash)), 1, 'o aceite grava o marker');

    debrid.checkCached = async () => ({ cached: new Set([hash]), known: true });
    await runtime.run({ opts: baseOpts(key, false), encoded: 'cfg-ciclo' }, () =>
      applyDebrid([brDub(hash)], { searchKey: `${searchKey}-2`, imdbId } as any));
    await sleep(20);
    assert.deepEqual(enqueued, [hash], 'o hash pronto não volta para a conta');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    for (const sk of [searchKey, `${searchKey}-2`]) autofetch.releaseSearch(sk);
    kvForget(autofetch.markerKey('premiumize', account, hash));
    held.release(hash, account);
    cache.clearNamespace('idx');
  }
});

test('F4: a abertura seguinte oferece a release do autofetch já pronta e não repete o download', async () => {
  const adapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = adapter.enqueue;
  const originalCheck = debrid.checkCached;
  const originalInventory = adapter.inventory;
  const saved = {
    publicUrl: config.debrid.publicUrl,
    resolveSecret: config.debrid.resolveSecret,
  };
  const hash = 'e7'.repeat(20);
  const alternateHash = 'e8'.repeat(20);
  const imdbId = 'tt0119081';
  const apiKey = 'f4-ciclo-chave';
  const searchKey = 'f4-autofetch-index-cycle';
  let ready = false;
  let enqueueCount = 0;
  try {
    config.debrid.publicUrl = 'https://addon.teste';
    config.debrid.resolveSecret = '';
    adapter.enqueue = async () => {
      enqueueCount += 1;
      ready = true;
      return true;
    };
    adapter.inventory = async () => [];
    debrid.checkCached = async () => ({
      cached: new Set(ready ? [hash] : []),
      known: true,
    });
    const userOpts = {
      ...runtime.defaults(), providers: ['jackett'], debridService: 'premiumize',
      debridApiKey: apiKey, debridCachedOnly: true, autoFetchBr: true,
    };
    const candidate = {
      title: 'O Enigma do Horizonte 1997 1080p DUBLADO\n👤 1 ⚙️ hdrtorrent',
      name: 'PowerMovie BR', infoHash: hash,
      _br: true, _dubbed: true, _lied: false,
      _quality: '1080p', _seeders: 1, _indexer: 'hdrtorrent',
    } as Stream;
    // Outro release dublado da MESMA obra/faixa: a próxima abertura não pode
    // mandá-lo de novo para a conta enquanto o primeiro estiver pronto.
    const alternate = {
      ...candidate,
      infoHash: alternateHash,
      title: 'O Enigma do Horizonte 1997 1080p DUBLADO alternativa\n👤 99 ⚙️ hdrtorrent',
      _seeders: 99,
    } as Stream;

    const first = await runtime.run({ opts: userOpts, encoded: 'f4-cycle' }, () =>
      applyDebrid([candidate], { imdbId, searchKey } as any)) as Stream[];
    assert.equal(first.length, 0, 'cachedOnly oculta a BR ainda fria na primeira abertura');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(enqueueCount, 1);
    // Sem `recordAutofetchRelease` (saiu com o runner, sem dono nativo) o aceite
    // não escreve no índice da obra: a abertura seguinte é servida pelo cache do
    // serviço, não pelo índice — por isso aqui não se mede `idxPoolCovered`.

    // "Próxima abertura": o mesmo par (obra, faixa) já pronto e outro release
    // 1080p dublado da obra — o primeiro sai, o segundo NÃO volta para a conta.
    const second = await runtime.run({ opts: userOpts, encoded: 'f4-cycle' }, () =>
      applyDebrid([candidate, alternate], { imdbId, searchKey } as any)) as Stream[];
    assert.ok(JSON.stringify(second).toLowerCase().includes(hash));
    assert.equal(enqueueCount, 1, 'outro hash da mesma obra/faixa não volta para a conta');
  } finally {
    adapter.enqueue = originalEnqueue;
    adapter.inventory = originalInventory;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = saved.publicUrl;
    config.debrid.resolveSecret = saved.resolveSecret;
    autofetch.releaseSearch(searchKey);
    kvForget(autofetch.markerKey('premiumize', accountScope(apiKey), hash));
    held.release(hash, accountScope(apiKey));
    cache.clear();
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
      kvForget(autofetch.markerKey('premiumize', account, h));
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
    // O seletor ordena as dubladas globais (melhor primeiro) e o oráculo dispara
    // as três; o teto `any`=1 por OBRA é do worker (`adom-core::pool_cap` via
    // `reserveObra`), fora do alcance do oráculo desde a B4 — provado em
    // `autofetch-obra-terminal.test.ts` (vaga any cap=1).
    assert.deepEqual(enqueued, [h2, h1, h3], 'ordem do seletor: a melhor dublada global primeiro');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2, h3]) {
      kvForget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('fallback global respeita os gates: dublado ⚡, BR presente e toggle off não baixam global', async () => {
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
    assert.deepEqual(enqueued, [g], 'legendado ⚡ não barra dublada global uncached');

    enqueued.length = 0;
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
      kvForget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});
