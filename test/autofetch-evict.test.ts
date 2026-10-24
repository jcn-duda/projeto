// Fase 6 do Chupim 2.0 — POLÍTICA da evicção dirigida de fallbacks.
//
// Quando um BR dublado aceito pelo Chupim fica ready, remove da conta AllDebrid
// os fallbacks any/seeds da MESMA obra cuja posse/identidade estejam provadas.
// DESTRUTIVA e default OFF. Este arquivo fixa o veredito de POLÍTICA: knob off
// sem rede/execução; só any/seeds da mesma obra; overflow do C11 intocável;
// marker legado/ausente/digest-de-outra-obra e falta de adsub bloqueiam;
// held/adprot bloqueiam; idade mínima; ready sem prova de pool br+dubbed é no-op.
// O EXECUTOR (anti-re-add, status/id/filename, gate) e as ORDENS de ready vivem
// em `autofetch-evict-executor.test.ts`. Zero rede real: fetch dublado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as held from '../src/debrid/protected.js';
import { markerKey } from '../src/providers/autofetch-marker.js';
import { obraRecord } from '../src/providers/autofetch-obra.js';
import { maybeEvictFallbacks } from '../src/providers/autofetch-evict.js';
import { mockAd, mag, counter, withDebrid, assenta, adrmKey } from './helpers/alldebrid-mock.js';
import {
  KEY, ACCOUNT, identity, READY, F_ANY, F_SEEDS, F_OTHER_POOL, F_LEGACY, F_NO_MARKER,
  F_NO_ADSUB, F_HELD, F_PROT, F_YOUNG, F_NO_DATE, F_OUTRA, adapter, limpa, entry, putRecord,
  readyEntry, setMarker, own, hint,
} from './helpers/autofetch-evict-harness.js';

// O backoff do delete usa `wait` com timer unref: sem algo segurando o event
// loop, o node:test cancelaria promessas pendentes.
let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));

test('F6: knob OFF não lê a conta nem chama o executor', async () => {
  limpa();
  const api = mockAd({ account: [mag(1, F_SEEDS, 'Foreign.Movie.2019.1080p', 500)] });
  const original = adapter.evictFallbacks;
  let chamado = 0;
  adapter.evictFallbacks = (async () => { chamado += 1; return { removed: [], skipped: [] }; }) as typeof adapter.evictFallbacks;
  putRecord([readyEntry(), entry(F_SEEDS, 'seeds')]);
  setMarker(F_SEEDS, 'seeds');
  own(F_SEEDS);
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    assert.equal(chamado, 0, 'OFF: executor nunca é chamado');
    assert.equal(api.statusCalls, 0, 'OFF: zero leitura da conta');
    assert.ok(cache.peek(markerKey('alldebrid', ACCOUNT, F_SEEDS)), 'OFF: nada é esquecido');
    assert.equal(cache.keysMatching(`${prefix('autofetch')}er:`).length, 0, 'OFF: prova BR ready nem é escrita');
  } finally {
    adapter.evictFallbacks = original;
    api.restore();
  }
});

test('F6: BR ready remove só fallbacks any/seeds da MESMA obra, pelo gate e com adrm', async () => {
  limpa();
  const api = mockAd({
    account: [
      mag(21, F_ANY, 'Some.Global.Dub.1080p', 500),
      mag(22, F_SEEDS, 'Some.Swarm.1080p', 500),
      mag(23, F_OTHER_POOL, 'Another.Br.Sibling.1080p', 500),
      mag(24, F_OUTRA, 'Other.Work.1080p', 500),
    ],
  });
  const originalRemove = adapter.removeTorrent;
  let removeCalls = 0;
  adapter.removeTorrent = (async () => { removeCalls += 1; return true; }) as typeof adapter.removeTorrent;
  putRecord([readyEntry(), entry(F_ANY, 'any'), entry(F_SEEDS, 'seeds'), entry(F_OTHER_POOL, 'br')]);
  setMarker(F_ANY, 'any');
  setMarker(F_SEEDS, 'seeds');
  setMarker(F_OTHER_POOL, 'br');
  // outra obra: registro e marker próprios; nunca entra na seleção da obra alvo
  cache.set(markerKey('alldebrid', ACCOUNT, F_OUTRA), { obra: 'deadbeef', pool: 'seeds' }, 3600);
  for (const h of [F_ANY, F_SEEDS, F_OTHER_POOL, F_OUTRA]) own(h);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.deepEqual([...api.deleted].sort((a, b) => Number(a) - Number(b)), [21, 22], 'só any/seeds saem pelo /magnet/delete');
    assert.equal(removeCalls, 0, 'PROIBIDO chamar removeTorrent direto');
    assert.equal(counter('autofetch.evict.removed'), 2);
    for (const h of [F_ANY, F_SEEDS]) {
      assert.equal(cache.peek(markerKey('alldebrid', ACCOUNT, h)), null, 'marker esquecido no sucesso');
      const adrm = cache.peek(adrmKey(ACCOUNT, h)) as { name?: string } | null;
      assert.ok(adrm, 'adrm gravado no sucesso');
      assert.match(String(adrm?.name || ''), /1080p/, 'adrm carrega o filename REAL');
    }
    const record = obraRecord(identity);
    assert.equal(record.some((e) => e.hash === F_ANY || e.hash === F_SEEDS), false, 'registro da obra limpo');
    assert.equal(record.some((e) => e.hash === F_OTHER_POOL), true, 'irmão de pool br permanece');
    assert.ok(cache.peek(markerKey('alldebrid', ACCOUNT, F_OTHER_POOL)), 'irmão br intocado');
    assert.ok(cache.peek(markerKey('alldebrid', ACCOUNT, F_OUTRA)), 'outra obra intocada');
    assert.equal(api.deleted.includes(24), false, 'hash de outra obra não é removido');
  } finally {
    restaura();
    adapter.removeTorrent = originalRemove;
    api.restore();
  }
});

test('F6: reserva de overflow do C11 não é evictada; fallback comum é', async () => {
  limpa();
  const OVER = 'e1'.repeat(20);
  const COMUM = 'e2'.repeat(20);
  const api = mockAd({
    account: [
      mag(96, OVER, 'Upgrade.2160p.Seeds', 500),
      mag(97, COMUM, 'Comum.Seeds.1080p', 500),
    ],
  });
  putRecord([
    readyEntry(),
    entry(OVER, 'seeds', { quality: '2160p', overflow: true }),
    entry(COMUM, 'any'),
  ]);
  setMarker(OVER, 'seeds');
  setMarker(COMUM, 'any');
  own(OVER);
  own(COMUM);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.deepEqual(api.deleted, [97], 'só o fallback comum sai; overflow fica');
    assert.equal(counter('autofetch.evict.skipped.overflow'), 1);
    assert.equal(counter('autofetch.evict.removed'), 1);
    assert.equal(obraRecord(identity).some((e) => e.hash === OVER), true, 'overflow mantido no registro');
    assert.ok(cache.peek(markerKey('alldebrid', ACCOUNT, OVER)), 'marker do overflow mantido');
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: marker legado, marker ausente, digest de OUTRA obra e falta de adsub bloqueiam', async () => {
  limpa();
  const DIGEST_OUTRA = 'f0'.repeat(20);
  const api = mockAd({
    account: [
      mag(31, F_LEGACY, 'Legacy.Movie.2019.1080p', 500),
      mag(32, F_NO_ADSUB, 'NoSub.Movie.2019.1080p', 500),
      mag(33, F_NO_MARKER, 'NoMarker.Movie.2019.1080p', 500),
      mag(34, DIGEST_OUTRA, 'OtherDigest.Movie.2019.1080p', 500),
    ],
  });
  putRecord([
    readyEntry(), entry(F_LEGACY, 'seeds'), entry(F_NO_ADSUB, 'any'),
    entry(F_NO_MARKER, 'seeds'), entry(DIGEST_OUTRA, 'seeds'),
  ]);
  cache.set(markerKey('alldebrid', ACCOUNT, F_LEGACY), { id: 'legacy-id' }, 3600); // legado
  setMarker(F_NO_ADSUB, 'any'); // marker novo, mas sem posse durável
  // F_NO_MARKER: sem marker nenhum
  cache.set(markerKey('alldebrid', ACCOUNT, DIGEST_OUTRA), { obra: 'f'.repeat(64), pool: 'seeds' }, 3600);
  own(F_NO_MARKER);
  own(DIGEST_OUTRA);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.equal(api.deleted.length, 0, 'nada é apagado');
    assert.equal(counter('autofetch.evict.skipped.marker-missing'), 3, 'legado + ausente + digest alheio');
    assert.equal(counter('autofetch.evict.skipped.no-ownership'), 1, 'sem adsub pulado');
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: held volátil e adprot durável barram a remoção', async () => {
  limpa();
  const api = mockAd({
    account: [
      mag(41, F_HELD, 'Held.Movie.2019.1080p', 500),
      mag(42, F_PROT, 'Prot.Movie.2019.1080p', 500),
    ],
  });
  putRecord([readyEntry(), entry(F_HELD, 'seeds'), entry(F_PROT, 'seeds')]);
  for (const h of [F_HELD, F_PROT]) { setMarker(h, 'seeds'); own(h); }
  held.hold(F_HELD, 60, ACCOUNT);
  held.protectBr('alldebrid', ACCOUNT, F_PROT);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.equal(api.deleted.length, 0);
    assert.equal(counter('autofetch.evict.skipped.held'), 1);
    assert.equal(counter('autofetch.evict.skipped.protected'), 1);
  } finally {
    held.release(F_HELD, ACCOUNT);
    held.unprotect('alldebrid', ACCOUNT, F_PROT);
    restaura();
    api.restore();
  }
});

test('F6: idade mínima e ausência de data bloqueiam', async () => {
  limpa();
  const api = mockAd({
    account: [
      mag(51, F_YOUNG, 'Young.Movie.2019.1080p', 500),
      mag(52, F_NO_DATE, 'NoDate.Movie.2019.1080p', 500),
    ],
  });
  putRecord([
    readyEntry(),
    entry(F_YOUNG, 'seeds', { acceptedAt: Date.now() - 60_000 }),
    entry(F_NO_DATE, 'any', { acceptedAt: 0 }),
  ]);
  for (const h of [F_YOUNG, F_NO_DATE]) { setMarker(h, 'seeds'); own(h); }
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 1_800_000 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.equal(api.deleted.length, 0, 'jovem e sem data ficam');
    assert.equal(counter('autofetch.evict.skipped.too-young'), 2);
  } finally {
    restaura();
    api.restore();
  }
});

test('F6: ready sem prova de pool br+dubbed é no-op', async () => {
  limpa();
  const api = mockAd({ account: [mag(91, F_SEEDS, 'Swarm.Movie.2019.1080p', 500)] });
  putRecord([entry(READY, 'seeds', { dubbed: false }), entry(F_SEEDS, 'seeds')]);
  setMarker(F_SEEDS, 'seeds');
  own(F_SEEDS);
  const restaura = withDebrid({ autoFetchEvictFallback: true, autoFetchEvictFallbackMinAgeMs: 0 });
  try {
    await maybeEvictFallbacks({ adapter, account: ACCOUNT, apiKey: KEY, hash: READY, hint });
    await assenta();
    assert.equal(api.statusCalls, 0, 'nem lê a conta');
    assert.equal(counter('autofetch.evict.skipped.ready-not-br'), 1);
  } finally {
    restaura();
    api.restore();
  }
});
