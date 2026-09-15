// P1.2 da auditoria adversarial: `expired-unready` só apaga direto com posse
// PROVADA (marker/adsub) e snapshot de pré-existentes carregado sem o hash.
// Sem prova, snapshot ausente ou preexistente do usuário, o hash é REPRESADO
// (`autofetch-suppressed`), nunca apagado. Sem rede real: fetch/adapters dublês.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import { runRecheck, recheckLots } from '../src/providers/autofetch-recheck.js';
import { accountScope } from '../src/utils/request-key.js';
import { preexisting, rememberSubmitted, resetSubmittedForTests } from '../src/debrid/alldebrid-inventory.js';
import type { DebridAdapter } from '../types/domain.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hx = (seed: string) => seed.repeat(20);

type ProbeSetup = { snapshot?: Set<string> | null; marker?: boolean; adsub?: boolean };

async function expireProbe(via: 'hash' | 'id', removeById: boolean, sc: ProbeSetup) {
  const originalFetch = globalThis.fetch;
  const originalCheck = debrid.checkCached;
  const originalTtl = config.debrid.autoFetchTtl;
  const originalRemoveById = config.debrid.removeById;
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalStatus = ad.torrentStatus;
  const originalRemove = ad.removeTorrent;
  const chave = `chave-own-${via}-${sc.snapshot === null ? 'cold' : sc.snapshot ? 'user' : 'ours'}-${sc.marker}/${sc.adsub}`;
  const account = accountScope(chave);
  const searchKey = `busca-own-${via}-${Date.now()}-${Math.random()}`;
  const h = hx('f2');
  let removals = 0;
  let suppressedCount = 0;
  try {
    config.debrid.autoFetchTtl = 1;
    config.debrid.removeById = removeById;
    // Sem rede real em NENHUM caso: `knownBefore` só usa fetch quando o
    // snapshot não está pré-carregado (caso frio) — aí a resposta falha e o
    // fail-safe fecha.
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
    ad.torrentStatus = async () => ({ [h]: { state: 'downloading', id: 777, via } });
    ad.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    if (sc.snapshot === undefined) preexisting.set(account, { hashes: null, loadedAt: 0 });
    else if (sc.snapshot === null) preexisting.set(account, { hashes: null, loadedAt: 0 });
    else preexisting.set(account, { hashes: sc.snapshot, loadedAt: Date.now() });
    if (sc.marker) cache.set(autofetch.markerKey('alldebrid', account, h), 1, 3600);
    if (sc.adsub) rememberSubmitted(account, h);

    recheckLots.set(searchKey, {
      hashes: new Set([h]), attempts: 9, timer: null, inFlight: false,
      ctx: { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: chave }, encoded: 'cfg-own' },
      deadStreak: new Map(), stallStreak: new Map(), seasonHints: new Map(),
      createdAt: Date.now() - 5000, isSettle: true, refusals: 0, adapterId: 'alldebrid',
    });
    runRecheck(searchKey);
    await sleep(30);
    suppressedCount = suppressed.listSuppressed('alldebrid', account).length;
  } finally {
    globalThis.fetch = originalFetch;
    config.debrid.autoFetchTtl = originalTtl;
    config.debrid.removeById = originalRemoveById;
    debrid.checkCached = originalCheck;
    ad.torrentStatus = originalStatus;
    ad.removeTorrent = originalRemove;
    const lote = recheckLots.get(searchKey);
    if (lote?.timer) clearTimeout(lote.timer);
    recheckLots.delete(searchKey);
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    preexisting.delete(account);
    resetSubmittedForTests();
    cache.forget(autofetch.markerKey('alldebrid', account, h));
    cache.forget(autofetch.deadKey('alldebrid', account, h));
    held.release(h, account);
    held.unprotect('alldebrid', account, h);
    suppressed.forgetSuppressed('alldebrid', account, h);
  }
  return { removals, suppressed: suppressedCount };
}

test('expired-unready: preexistente do usuário NÃO é apagado (vai para represados)', async () => {
  const h = hx('f2');
  const r = await expireProbe('hash', false, { snapshot: new Set([h]), marker: true, adsub: true });
  assert.equal(r.removals, 0, 'hash que estava na conta antes do addon nunca é removido direto');
  assert.equal(r.suppressed, 1, 'e sim represado para a limpeza terminal/painel');
});

test('expired-unready: snapshot ausente fecha o fail-safe (não remove)', async () => {
  const r = await expireProbe('hash', false, { snapshot: null, marker: true, adsub: true });
  assert.equal(r.removals, 0, 'sem autoridade de inventário, não apaga');
  assert.equal(r.suppressed, 1, 'represa em vez de apagar');
});

test('expired-unready: sem marker nem adsub não remove (posse não provada)', async () => {
  const r = await expireProbe('hash', false, { snapshot: new Set(), marker: false, adsub: false });
  assert.equal(r.removals, 0, 'não há prova de que o addon subiu');
  assert.equal(r.suppressed, 1);
});

test('expired-unready: adsub+marker, snapshot carregado sem o hash e sem proteção → remove', async () => {
  const r = await expireProbe('hash', false, { snapshot: new Set(), marker: true, adsub: true });
  assert.equal(r.removals, 1, 'posse provada autoriza a remoção direta');
  assert.equal(r.suppressed, 0, 'nada represado quando remove');
});
