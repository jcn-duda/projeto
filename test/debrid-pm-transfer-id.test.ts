// Ponte hash -> id da transferência no Premiumize.
//
// A listagem do Premiumize não publica hash: o `src` volta como
// `/api/job/src?id=…` e não existe campo `hash`. Medido na conta do operador:
// de 60 transferências, 58 não casavam por nenhuma via da cascata, então o
// recheck só enxergava as 2 cujo NOME por acaso era o hash cru — e nada do que
// o autofetch submetia voltava a ser observável. O id que o `/transfer/create`
// devolve é a única âncora; estes testes cobrem guardá-lo, usá-lo, e o gate
// que impede a visão nova de virar remoção automática no mesmo deploy.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as premiumize from '../src/debrid/premiumize.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import { applyDebrid } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';
import { flush, brDubCandidate, autofetchUserOpts } from './helpers/autofetch-fixtures.js';

/** Dublê de fetch com corpo fixo; o AbortSignal.timeout vira no-op. */
function stubFetch(body: unknown) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

// Shape REAL de uma transferência do Premiumize, como veio da conta medida:
// nove campos, nenhum deles com o hash. O `src` é uma URL de job.
const TRANSFER_SEM_HASH = {
  id: 'vJ15-ynT0V4dyb4SuFw',
  name: 'COMANDOTORRENTS.ORG - Parasita 2020 [1080p-FULL] [DUAL]',
  message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left',
  status: 'running',
  progress: 0,
  folder_id: null,
  file_id: null,
  other_cloud_id: null,
  src: 'https://www.premiumize.me/api/job/src?id=vJ15-ynT0V4dyb4SuFw',
};

const HASH = 'a'.repeat(40);

test('enqueue devolve o ID da transferência, não um booleano', async () => {
  const restore = stubFetch({ status: 'success', id: 'vJ15-ynT0V4dyb4SuFw' });
  try {
    const out = await premiumize.enqueue('chave-de-teste', HASH);
    assert.equal(out, 'vJ15-ynT0V4dyb4SuFw', 'o id vira o valor de aceite');
  } finally {
    restore();
  }
});

test('enqueue sem id continua sendo recusa', async () => {
  const restore = stubFetch({ status: 'success' });
  try {
    assert.equal(await premiumize.enqueue('chave-de-teste', HASH), false);
  } finally {
    restore();
  }
});

test('torrentStatus casa pelo id registrado e marca via=id', async () => {
  const restore = stubFetch({ transfers: [TRANSFER_SEM_HASH] });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [HASH], {
      [HASH]: 'vJ15-ynT0V4dyb4SuFw',
    });
    assert.ok(out[HASH], 'a transferência sem hash volta indexada pelo hash do enqueue');
    assert.equal(out[HASH].state, 'downloading');
    assert.equal(out[HASH].stalled, true, 'a mensagem de 0 peers ainda denuncia parada');
    assert.equal(out[HASH].via, 'id', 'a via fica registrada para o gate decidir');
  } finally {
    restore();
  }
});

test('sem o mapa de ids a mesma transferência segue invisível', async () => {
  const restore = stubFetch({ transfers: [TRANSFER_SEM_HASH] });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [HASH]);
    assert.deepEqual(Object.keys(out), [], 'era exatamente este o buraco medido em produção');
  } finally {
    restore();
  }
});

test('transferência que publica o hash mantém via=hash', async () => {
  const h = 'b'.repeat(40);
  const restore = stubFetch({
    transfers: [{ id: 7, name: h, status: 'finished', src: '', message: '' }],
  });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [h], { [h]: 7 });
    assert.equal(out[h].state, 'ready');
    assert.equal(out[h].via, 'hash', 'a cascata histórica tem precedência sobre o id');
  } finally {
    restore();
  }
});

test('markerValue guarda o id e markerTransferId o devolve', () => {
  const account = accountScope('chave-marker');
  const key = autofetch.markerKey('premiumize', account, HASH);
  try {
    cache.set(key, autofetch.markerValue('id-abc'), 60);
    assert.equal(autofetch.markerTransferId('premiumize', account, HASH), 'id-abc');
    // Aceite sem id (os outros adapters) segue gravando o `1` histórico, e os
    // leitores por truthiness não notam diferença.
    cache.set(key, autofetch.markerValue(true), 60);
    assert.equal(cache.get(key), 1);
    assert.equal(autofetch.markerTransferId('premiumize', account, HASH), null);
  } finally {
    cache.forget(key);
  }
});

/**
 * Gate da remoção. Roda o colapso de "parado" duas vezes com a MESMA montagem,
 * mudando só o knob: é a diferença entre as duas execuções que prova que o
 * knob governa a destruição, e não outra coisa do caminho.
 */
async function colapsaParado({ removeById, via }: { removeById: boolean; via: 'hash' | 'id' }) {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRemoveById = config.debrid.removeById;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const chave = `chave-gate-${via}-${removeById}`;
  const account = accountScope(chave);
  const h = (via === 'id' ? '4' : '5').repeat(40);
  const searchKey = `busca-gate-${via}-${removeById}`;
  const supKey = 'autofetch.stalled.suppressed';
  const supBefore = metrics.snapshot().counters[supKey] || 0;
  let removals = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 1;
    config.debrid.removeById = removeById;
    pmAdapter.enqueue = async () => 'id-da-transferencia';
    pmAdapter.torrentStatus = async () => ({
      [h]: { state: 'downloading', stalled: true, id: 99, via },
    });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: autofetchUserOpts(chave), encoded: `cfg-${searchKey}` }, () =>
      applyDebrid([brDubCandidate(h)], { searchKey } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    return {
      removals,
      blacklisted: autofetch.isDead('premiumize', account, h),
      soltou: !held.isHeld(h, account),
      suppressed: (metrics.snapshot().counters[supKey] || 0) - supBefore,
    };
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.removeById = originalRemoveById;
    config.debrid.publicUrl = originalPublicUrl;
    debrid.checkCached = originalCheck;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
}

test('via=id com removeById desligado: blacklista e drena, mas NÃO apaga na conta', async () => {
  const r = await colapsaParado({ removeById: false, via: 'id' });
  assert.equal(r.removals, 0, 'nada é removido da conta do usuário');
  assert.equal(r.suppressed, 1, 'o que teria sido apagado vira contador');
  assert.equal(r.blacklisted, true, 'a fila para de reenfileirar o mesmo hash');
  assert.equal(r.soltou, true, 'o hold é liberado do mesmo jeito');
});

test('via=id com removeById ligado: o knob devolve a remoção', async () => {
  const r = await colapsaParado({ removeById: true, via: 'id' });
  assert.equal(r.removals, 1, 'ligado, remove');
  assert.equal(r.suppressed, 0);
});

test('via=hash não é afetada pelo knob: a remoção histórica segue igual', async () => {
  const r = await colapsaParado({ removeById: false, via: 'hash' });
  assert.equal(r.removals, 1, 'quem o serviço identifica por hash nunca dependeu do knob');
  assert.equal(r.suppressed, 0);
});
