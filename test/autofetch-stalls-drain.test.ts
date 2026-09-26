import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope, streamsCacheKey } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid, findStreams } from '../src/providers/index.js';
import { recheckLots, runRecheck } from '../src/providers/autofetch-recheck.js';
import { drainNext } from '../src/providers/autofetch-runner.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import type { DebridAdapter } from '../types/domain.js';
import { flush, brDubCandidate, autofetchUserOpts, makeDrainHarness, H1, H2, sleep, premiumizeRunCtx } from './helpers/autofetch-fixtures.js';

function clearDead(adapterId: string, account: string, hashes: string[]) {
  for (const h of hashes) cache.forget(autofetch.deadKey(adapterId, account, h));
}

test('stall colapsa e drainNext sobe o 2º da mesma faixa (fila surplus)', async () => {
  autofetchLive.reset();
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-drain-x');
  const h1080 = 'bf1080a1bf1080a1bf1080a1bf1080a1bf1080a1';
  const h1080b = 'bf1080b2bf1080b2bf1080b2bf1080b2bf1080b2';
  const h720 = 'bf0720a3bf0720a3bf0720a3bf0720a3bf0720a3';
  const h4k = 'bf2160a4bf2160a4bf2160a4bf2160a4bf2160a4';
  const searchKey = 'busca-stall-drain-x';
  const userOpts = autofetchUserOpts('chave-stall-drain-x');
  const enqueued: string[] = [];

  try {
    clearDead('premiumize', account, [h1080, h1080b, h720, h4k]);
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 2;
    pmAdapter.enqueue = async (_apiKey, infoHash) => {
      enqueued.push(infoHash);
      return true;
    };
    pmAdapter.torrentStatus = async () => ({
      [h1080]: { state: 'downloading', stalled: true, id: 11 },
      [h720]: { state: 'downloading', id: 12 },
      [h4k]: { state: 'downloading', id: 13 },
    });
    pmAdapter.removeTorrent = async () => true;
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-drain-x' }, () =>
      applyDebrid([
        brDubCandidate(h4k, { _quality: '2160p', _seeders: 9 }),
        brDubCandidate(h720, { _quality: '720p', _seeders: 50 }),
        brDubCandidate(h1080b, { _quality: '1080p', _seeders: 1 }),
        brDubCandidate(h1080, { _quality: '1080p', _seeders: 5 }),
      ], { searchKey } as any),
    );
    await flush();

    assert.deepEqual(enqueued, [h1080, h720, h4k], '3 imediatos por faixa');
    assert.equal(autofetch.readQueue(searchKey).length, 1, 'surplus 1080 na fila');
    assert.equal(String(autofetch.readQueue(searchKey)[0].infoHash).toLowerCase(), h1080b);

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h1080), false);
    assert.equal(enqueued.length, 3, '1ª observação de stall não drena');

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h1080), true, 'colapso blacklist o 1080 primário');
    // Fase 2: o hash TERMINAL sai do registro da obra ANTES do dreno (dead
    // libera a vaga na hora; só ready continua contando pela janela), então o
    // surplus SAME POOL da fila volta a caber e sobe na reposição.
    assert.ok(enqueued.includes(h1080b), 'drainNext sobe o 2º 1080 da fila');
    assert.equal(autofetch.readQueue(searchKey).length, 0, 'cabeça consumida');
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    cache.forget(searchKey);
    clearDead('premiumize', account, [h1080, h1080b, h720, h4k]);
    for (const h of [h1080, h1080b, h720, h4k]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// --- Reposição por pool inferior (br → any → seeds) ---
// O caso comum esgota os poucos candidatos BR no immediate e a fila nascia
// vazia. O global fortão fica na fila marcado com o PRÓPRIO pool (seeds) e sobe
// no colapso COMPROVADO do primário: dead/stalled NATIVO do adaptador ou
// parada DERIVADA por progresso (Fase 3, AllDebrid). O settle — com ou sem
// progresso — nunca drena: a política conservadora da Fase 0 segue valendo.
const seedsCandidate = (h: string, seeds: number) => ({
  infoHash: h, name: 'Coringa 1080p BluRay', title: 'Coringa 1080p BluRay',
  _br: false, _dubbed: false, _quality: '1080p', _seeders: seeds,
  // Política seeds da Fase 1: tamanho dentro do teto (desconhecido é recusado).
  _size: 2 * 1024 ** 3,
});

test('BR imediato + global forte: global não dispara agora, fica na fila com pool seeds', async () => {
  autofetchLive.reset();
  const h = makeDrainHarness('fallback-queue-x');
  const hBr = 'd1'.repeat(20);
  const hSeed = 'd2'.repeat(20);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    await h.run([seedsCandidate(hSeed, 500), brDubCandidate(hBr, { _quality: '1080p', _seeders: 5 })]);
    assert.deepEqual(h.enqueued, [hBr], 'só o BR primário dispara imediatamente');
    const queue = autofetch.readQueue(h.searchKey);
    assert.equal(queue.length, 1, 'global forte preservado na fila');
    assert.equal(String(queue[0].infoHash).toLowerCase(), hSeed);
    assert.equal(queue[0].pool, 'seeds', 'a entrada carrega o pool real para o dreno');
  } finally {
    mock.timers.reset();
    h.cleanup([hBr, hSeed]);
  }
});

test('BR fica ready: a fila do fallback é descartada e o global não baixa', async () => {
  autofetchLive.reset();
  const h = makeDrainHarness('fallback-ready-x');
  const hBr = 'd3'.repeat(20);
  const hSeed = 'd4'.repeat(20);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    h.setTorrentStatus(async () => ({ [hBr]: { state: 'ready', id: 31 } }));
    await h.run([seedsCandidate(hSeed, 500), brDubCandidate(hBr, { _quality: '1080p', _seeders: 5 })]);
    assert.equal(autofetch.readQueue(h.searchKey).length, 1, 'fallback plantado antes do ready');
    mock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.readQueue(h.searchKey).length, 0, 'lote assentou: fila descartada');
    assert.deepEqual(h.enqueued, [hBr], 'global de fallback nunca baixou');
  } finally {
    mock.timers.reset();
    h.cleanup([hBr, hSeed]);
  }
});

test('BR dead/stalled: drainNext sobe o global de fallback automaticamente', async () => {
  autofetchLive.reset();
  const h = makeDrainHarness('fallback-drain-x', { stallStreak: 2 });
  const hBr = 'd5'.repeat(20);
  const hSeed = 'd6'.repeat(20);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    h.setTorrentStatus(async () => ({ [hBr]: { state: 'downloading', stalled: true, id: 41 } }));
    h.pmAdapter.removeTorrent = async () => true;
    await h.run([seedsCandidate(hSeed, 500), brDubCandidate(hBr, { _quality: '1080p', _seeders: 5 })]);
    assert.equal(autofetch.readQueue(h.searchKey).length, 1, 'global de fallback na fila');
    mock.timers.tick(120_000);
    await flush();
    assert.equal(h.enqueued.length, 1, '1ª observação de stall não drena');
    mock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', h.account, hBr), true, 'stall colapsa blacklist o BR');
    assert.ok(h.enqueued.includes(hSeed), 'drainNext sobe o global de fallback');
    assert.equal(autofetch.readQueue(h.searchKey).length, 0, 'cabeça do fallback consumida');
  } finally {
    mock.timers.reset();
    h.cleanup([hBr, hSeed]);
  }
});

test('dead/stalled no ciclo da transição para settle: o dreno com evidência continua', async () => {
  autofetchLive.reset();
  const h = makeDrainHarness('fallback-settle-coincide-x', { stallStreak: 2, recheckMax: 2 });
  const hBr1080 = 'db'.repeat(20);
  const hBr720 = 'dc'.repeat(20);
  const seed1 = 'dd'.repeat(20);
  const seed2 = 'de'.repeat(20);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    // O 1080p stallado (NATIVO) no ciclo da transição; o 720p segue baixando e
    // mantém o lote vivo — é o que permite a passagem chegar ao settle. O lote
    // não publica progresso: o settle NÃO drena por conta própria.
    h.setTorrentStatus(async () => ({
      [hBr1080]: { state: 'downloading', stalled: true, id: 71 },
      [hBr720]: { state: 'downloading', id: 72 },
    }));
    h.pmAdapter.removeTorrent = async () => true;
    await h.run([
      seedsCandidate(seed1, 500), seedsCandidate(seed2, 400),
      brDubCandidate(hBr1080, { _quality: '1080p', _seeders: 5 }),
      brDubCandidate(hBr720, { _quality: '720p', _seeders: 9 }),
    ]);
    assert.deepEqual(h.enqueued, [hBr1080, hBr720], 'só os BR imediatos na abertura');
    assert.equal(autofetch.readQueue(h.searchKey).length, 2, 'dois fallbacks na fila');

    mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(h.enqueued, [hBr1080, hBr720], 'pré-threshold não drena');

    // attempts=2: o stall colapsa E o lote entra em settle na MESMA passagem.
    // O dreno é do ramo morto/parado (evidência); o settle em si não drena.
    mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(h.enqueued, [hBr1080, hBr720, seed1], 'o ramo morto/parado drena uma cabeça');
    assert.equal(autofetch.readQueue(h.searchKey).length, 1, 'a outra cabeça fica retida');
    assert.equal(String(autofetch.readQueue(h.searchKey)[0].infoHash).toLowerCase(), seed2, 'seed2 preservado');

    // Settle seguinte, SEM nova evidência: mais nada drena.
    mock.timers.tick(900_000);
    await flush();
    assert.deepEqual(h.enqueued, [hBr1080, hBr720, seed1], 'settle sem evidência não drena o restante');
    assert.equal(autofetch.readQueue(h.searchKey).length, 1, 'fila preservada no settle');
  } finally {
    mock.timers.reset();
    h.cleanup([hBr1080, hBr720, seed1, seed2]);
  }
});

test('ready de um hash NÃO zera a fila enquanto o lote ainda tem hashes vivos', async () => {
  autofetchLive.reset();
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-ready-keepq-x');
  const h1080 = 'ce1080a1ce1080a1ce1080a1ce1080a1ce1080a1';
  const h1080b = 'ce1080b2ce1080b2ce1080b2ce1080b2ce1080b2';
  const h720 = 'ce0720a3ce0720a3ce0720a3ce0720a3ce0720a3';
  const h4k = 'ce2160a4ce2160a4ce2160a4ce2160a4ce2160a4';
  const searchKey = 'busca-ready-keepq-x';
  const userOpts = autofetchUserOpts('chave-ready-keepq-x');

  try {
    clearDead('premiumize', account, [h1080, h1080b, h720, h4k]);
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({
      [h1080]: { state: 'downloading', id: 21 },
      [h720]: { state: 'ready', id: 22 },
      [h4k]: { state: 'downloading', id: 23 },
    });
    debrid.checkCached = async () => ({ cached: new Set([h720]), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-ready-keepq-x' }, () =>
      applyDebrid([
        brDubCandidate(h4k, { _quality: '2160p', _seeders: 9 }),
        brDubCandidate(h720, { _quality: '720p', _seeders: 50 }),
        brDubCandidate(h1080b, { _quality: '1080p', _seeders: 1 }),
        brDubCandidate(h1080, { _quality: '1080p', _seeders: 5 }),
      ], { searchKey } as any),
    );
    await flush();

    assert.equal(autofetch.readQueue(searchKey).length, 1, 'fila plantada com surplus');

    testMock.timers.tick(120_000);
    await flush();

    assert.equal(
      autofetch.readQueue(searchKey).length,
      1,
      '720p ready não dropQueue enquanto 1080/4K ainda no lote',
    );
    assert.equal(String(autofetch.readQueue(searchKey)[0].infoHash).toLowerCase(), h1080b);
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    cache.forget(searchKey);
    clearDead('premiumize', account, [h1080, h1080b, h720, h4k]);
    for (const h of [h1080, h1080b, h720, h4k]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('drainNext: cabeca apenas em hold e adiada, nao purgada; o segundo sobe', async () => {
  autofetchLive.reset();
  const apiKey = 'chave-drain-defer';
  const account = accountScope(apiKey);
  const searchKey = 'streams:v6:movie:ttDrainDefer';
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const enqueued: string[] = [];

  try {
    autofetch.dropQueue(searchKey);
    autofetch.resetBudget('premiumize', account);
    // Marcadores de execucoes anteriores podem sobreviver no L2 do cache
    // (os imports ESM sobem config antes do env de teste) - limpa antes.
    for (const h of [H1, H2]) cache.forget(autofetch.markerKey('premiumize', account, h));
    pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
    // H1 esta em hold transitorio (candidato imediato ainda em voo em outra
    // passagem): o dreno nao pode apaga-lo da fila, so pular na escolha.
    held.hold(H1, 3600, account);
    autofetch.writeQueue(searchKey, [
      { infoHash: H1, title: 'A (held)' },
      { infoHash: H2, title: 'B' },
    ], 3600);

    await runtime.run(premiumizeRunCtx(apiKey, 'cfg-drain-defer'), async () => {
      drainNext(searchKey, { refusals: 0, hashes: new Set<string>(), seasonHints: new Map() });
    });
    await sleep(10);

    assert.deepEqual(enqueued, [H2], 'o dreno sobe o segundo candidato');
    const fila = autofetch.readQueue(searchKey);
    assert.deepEqual(fila.map((c) => c.infoHash), [H1], 'A (held) permanece na fila para drenar depois');
  } finally {
    held.release(H1, account);
    pmAdapter.enqueue = originalEnqueue;
    autofetch.dropQueue(searchKey);
    autofetch.resetBudget('premiumize', account);
  }
});

// --- AllDebrid com progress (Fase 3) ----------------------------------------

test('AllDebrid com progress: adapter só anexa progresso em Downloading com campos numéricos', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const ok = 'c3'.repeat(20);
  const nullo = 'c4'.repeat(20);
  const fila = 'c5'.repeat(20);
  const completo = 'c6'.repeat(20);
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: { magnets: [
        { id: 9, hash: ok, status: 'Downloading', size: 1000, downloaded: 250, downloadSpeed: 0, seeders: 0 },
        // null/ausente NÃO viram zero: sem os QUATRO campos numéricos não há progresso.
        { id: 10, hash: nullo, status: 'Downloading', size: 1000, downloaded: null, downloadSpeed: 0, seeders: 0 },
        // queued/processing não são Downloading: sem progresso (o state vira downloading).
        { id: 11, hash: fila, status: 'queued', size: 1000, downloaded: 250, downloadSpeed: 5, seeders: 3 },
        // bytes >= total (completo/limítrofe) também não publica progresso.
        { id: 12, hash: completo, status: 'Downloading', size: 1000, downloaded: 1000, downloadSpeed: 0, seeders: 0 },
      ] } }),
    })) as unknown as typeof globalThis.fetch;
    const out = await ad.torrentStatus!('chave-de-teste', [ok, nullo, fila, completo]);
    assert.equal(out[ok].state, 'downloading');
    assert.equal(out[ok].via, 'hash', 'listagem por hash: remoção terminal fora do gate removeById');
    assert.deepEqual(out[ok].progress, { bytes: 250, total: 1000, speed: 0, seeders: 0 });
    assert.equal(out[ok].stalled, undefined, 'o adaptador NÃO deriva stalled');
    assert.equal(out[nullo].progress, undefined, 'campo cru null não vira zero');
    assert.equal(out[fila].state, 'downloading');
    assert.equal(out[fila].progress, undefined, 'queued não publica progresso');
    assert.equal(out[completo].progress, undefined, 'bytes >= total não publica progresso');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
