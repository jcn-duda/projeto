// Correções A1–A3 da auditoria de regressões: o terminal medido da AllDebrid
// (frase exata "Download took more than 3 days", statusCode 10 medido) precisa
// ser reconhecido pelo predicado compartilhado (torrentStatus E sweepDead) sem
// condenar por `statusCode` isolado, e o status da listagem autoritativa volta a
// `via:'hash'`, restaurando a remoção direta de dead nativo e expired-unready
// mesmo com DEBRID_REMOVE_BY_ID=false (a posse do expired-unready tem guarda
// própria — ver autofetch-expired-ownership). O ramo progress-stalled continua
// sem remoção direta (coberto em autofetch-progress). Sem rede real: só
// `fetch`/`torrentStatus`/`removeTorrent` são dublês.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import { runRecheck, recheckLots } from '../src/providers/autofetch-recheck.js';
import { accountScope } from '../src/utils/request-key.js';
import { isDeadMagnet, DEAD } from '../src/debrid/alldebrid-api.js';
import { sweepDead } from '../src/debrid/alldebrid-cleanup.js';
import type { DebridAdapter } from '../types/domain.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hx = (seed: string) => seed.repeat(20);

function stubFetchJson(payload: unknown) {
  return (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof globalThis.fetch;
}

test('DEAD reconhece a mensagem exata e ignora statusCode isolado', () => {
  assert.equal(DEAD.test('Download took more than 3 days'), true);
  assert.equal(isDeadMagnet('Download took more than 3 days'), true);
  assert.equal(isDeadMagnet(undefined, 10), false, 'código 10 sozinho NÃO condena: o texto é a autoridade');
  assert.equal(isDeadMagnet('Downloading', 10), false, '10 com texto Downloading ainda baixa');
  assert.equal(isDeadMagnet('Downloading'), false);
  assert.equal(isDeadMagnet('Ready'), false);
  assert.equal(isDeadMagnet('queued', 1), false);
  assert.equal(isDeadMagnet('Ready', 4), false);
});

test('AllDebrid torrentStatus: frase terminal vira dead com via=hash; statusCode 10 não condena', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const hMsg = hx('d1');
  const hCode = hx('d2');
  const hReady = hx('d3');
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = stubFetchJson({
      status: 'success',
      data: { magnets: [
        { id: 1, hash: hMsg, status: 'Download took more than 3 days' },
        { id: 2, hash: hCode, status: 'Downloading', statusCode: 10 },
        { id: 3, hash: hReady, status: 'Ready', statusCode: 4 },
      ] },
    });
    const out = await ad.torrentStatus!('chave-de-teste', [hMsg, hCode, hReady]);
    assert.equal(out[hMsg].state, 'dead', 'frase exata é terminal');
    assert.equal(out[hCode].state, 'downloading', 'statusCode 10 com texto Downloading NÃO é dead');
    assert.equal(out[hReady].state, 'ready');
    assert.equal(out[hMsg].via, 'hash', 'listagem autoritativa por hash');
    assert.equal(out[hCode].via, 'hash');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('AllDebrid sweepDead remove o terminal (frase) e poupa Ready/Downloading mesmo com statusCode 10', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const apiKey = 'chave-sweep-dead';
  const hDead = hx('e1');
  const hCode = hx('e2');
  const hReady = hx('e3');
  const hReadyCode = hx('e5');
  const hAct = hx('e4');
  const deleted: string[] = [];
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/magnet/delete')) {
        deleted.push(String(new URL(u).searchParams.get('id')));
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: { magnets: [
            { id: 11, hash: hDead, status: 'Download took more than 3 days', uploadDate: 1 },
            { id: 12, hash: hCode, status: 'Downloading', statusCode: 10, uploadDate: 1 },
            { id: 13, hash: hReady, status: 'Ready', uploadDate: 1 },
            { id: 14, hash: hAct, status: 'Downloading', uploadDate: 1 },
            { id: 15, hash: hReadyCode, status: 'Ready', statusCode: 10, uploadDate: 1 },
          ] },
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const r = await sweepDead(apiKey);
    assert.equal(r.varridos, 1, 'só o terminal por TEXTO sai');
    assert.deepEqual(deleted, ['11']);
    assert.ok(!deleted.includes('12'), 'statusCode 10 não condena sem a frase');
    assert.ok(!deleted.includes('13'), 'Ready é acervo');
    assert.ok(!deleted.includes('14'), 'download ativo não é lixo');
    assert.ok(!deleted.includes('15'), 'ready vence o DEAD: item pronto nunca é varrido');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('recheck dead nativo remove pelo hash com removeById=false (conta da instalação)', async () => {
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalCheck = debrid.checkCached;
  const originalStatus = ad.torrentStatus;
  const originalRemove = ad.removeTorrent;
  const originalRemoveById = config.debrid.removeById;
  const chave = 'chave-byo-dead';
  const account = accountScope(chave);
  const searchKey = 'busca-byo-dead';
  const h = hx('f1');
  let removals = 0;
  try {
    config.debrid.removeById = false;
    // A listagem já vem `via:'hash'` do adaptador (correção A1).
    ad.torrentStatus = async () => ({ [h]: { state: 'dead', id: 42, via: 'hash' } });
    ad.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    recheckLots.set(searchKey, {
      hashes: new Set([h]), attempts: 1, timer: null, inFlight: false,
      ctx: { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: chave }, encoded: 'cfg-byo-dead' },
      deadStreak: new Map([[h, 1]]), stallStreak: new Map(), seasonHints: new Map(),
      createdAt: Date.now() - 1000, isSettle: false, refusals: 0, adapterId: 'alldebrid',
    });
    runRecheck(searchKey);
    await sleep(40);
    assert.equal(removals, 1, 'dead nativo via hash remove direto sem DEBRID_REMOVE_BY_ID');
    assert.equal(suppressed.listSuppressed('alldebrid', account).length, 0, 'nada represado quando a remoção acontece');
    assert.equal(recheckLots.has(searchKey), false, 'lote colapsado é descartado');
  } finally {
    config.debrid.removeById = originalRemoveById;
    debrid.checkCached = originalCheck;
    ad.torrentStatus = originalStatus;
    ad.removeTorrent = originalRemove;
    const lote = recheckLots.get(searchKey);
    if (lote?.timer) clearTimeout(lote.timer);
    recheckLots.delete(searchKey);
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    cache.forget(autofetch.markerKey('alldebrid', account, h));
    cache.forget(autofetch.deadKey('alldebrid', account, h));
    held.release(h, account);
    suppressed.forgetSuppressed('alldebrid', account, h);
  }
});
