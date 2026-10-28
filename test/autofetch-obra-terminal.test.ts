// Desfechos TERMINAIS do teto por obra (F2): dead/stalled libera a vaga
// (`forgetObraHash`), o registro continua contando pela janela, pack usa
// identidade de temporada e a fila v3 carrega a evidência rara do pool seeds.
//
// `autofetch-obra.ts` / `autofetch-obra-summary.ts` FICAM (leva B4); o corpo do
// runner saiu, então aqui só entram peças vivas — sem enqueue, sem dreno, sem
// rede. O teto do worker é `adom-autofetch/src/v3/obra_reservation.rs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import * as cache from '../src/utils/cache.js';
import { kvForget, kvPeek, kvSet } from '../src/utils/native-kv.js';
import { accountScope } from '../src/utils/request-key.js';
import {
  reserveObra, commitObra, forgetObraHash, obraRecord, obraKey, resetObraForTest,
} from '../src/providers/autofetch-obra.js';
import { obraSummaries } from '../src/providers/autofetch-obra-summary.js';

const PM = 'premiumize';
const hx = (seed: string) => seed.repeat(40).slice(0, 40);
const trash: string[] = [];

type IdentityOpts = {
  imdbId?: string | null; season?: number | null; episode?: number | null;
  isPack?: boolean; searchKey?: string | null;
};
function identity(apiKey: string, o: IdentityOpts = {}) {
  return {
    adapterId: PM, account: accountScope(apiKey),
    imdbId: o.imdbId ?? null, season: o.season ?? null, episode: o.episode ?? null,
    ...(o.isPack ? { isPack: true } : {}), searchKey: o.searchKey ?? null,
  };
}
function trackKey(apiKey: string, o: IdentityOpts = {}) {
  const key = obraKey(identity(apiKey, o));
  trash.push(key);
  return key;
}
function forgetHashes(apiKey: string, hashes: string[]) {
  const account = accountScope(apiKey);
  for (const h of hashes) {
    kvForget(autofetch.markerKey(PM, account, h));
    held.release(h, account);
  }
  autofetch.resetBudget(PM, account);
}

before(() => {
  autofetchLive.reset();
  resetObraForTest();
});
after(() => {
  autofetch.resetBudget();
  autofetchLive.reset();
  resetObraForTest();
  // `o:` é RUST_OWNED: a limpeza do registro é da ponte.
  for (const key of trash) { kvForget(key); cache.forget(key); }
});

// `o:` é RUST_OWNED (dono ÚNICO = KV nativo): a semente no L1 não é lida, nem
// sobra no painel. Quem prova a leitura é a ponte (`kvSet`), o MESMO caminho do
// commit real (`commitObraRecordNative`).
test('obraRecord lê o registro pela ponte e ignora a semente no L1', () => {
  const id = identity('legado-l1', { imdbId: 'tt7100999', season: 1, episode: 2 });
  const key = obraKey(id), hash = hx('f3');
  const digest = key.slice(key.lastIndexOf(':') + 1, key.lastIndexOf(':') + 13);
  kvForget(key);
  cache.set(key, { entries: [{ hash, pool: 'br', acceptedAt: Date.now(), br: true, dubbed: true }] }, 3600);
  try {
    assert.equal(cache.get(key), null, 'L1 não é fonte de `o:` (nem visualiza a escrita)');
    assert.deepEqual(obraRecord(id), [], 'semente no L1 não vira registro');
    assert.ok(!obraSummaries().some((item) => item.digest === digest), 'o painel não inventa obra');
    kvSet(key, { entries: [{ hash, pool: 'br', acceptedAt: Date.now(), br: true, dubbed: true }] }, 3600);
    assert.equal(obraRecord(id)[0]?.hash, hash, 'a ponte é a fonte da leitura');
    assert.ok(obraSummaries().some((item) => item.digest === digest), 'o painel enumera pela ponte');
  } finally {
    kvForget(key);
    cache.forget(key);
  }
});

test('forgetObraHash remove só o hash terminal e preserva outros hashes/pools', () => {
  const apiKey = 'chave-obra-forget';
  const imdbId = 'tt7100001';
  const id = identity(apiKey, { imdbId });
  autofetchLive.set({ autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId });
  const brA = hx('a1'); const brB = hx('b2'); const seed = hx('c3');
  try {
    const l1 = reserveObra({ ...id, pool: 'br', hash: brA });
    const l2 = reserveObra({ ...id, pool: 'br', hash: brB });
    const l3 = reserveObra({ ...id, pool: 'seeds', hash: seed });
    commitObra(l1, { hash: brA, pool: 'br' });
    commitObra(l2, { hash: brB, pool: 'br' });
    commitObra(l3, { hash: seed, pool: 'seeds' });
    assert.equal(obraRecord(id).length, 3);

    assert.equal(forgetObraHash({ ...id, hash: brA }), true);
    const rec = obraRecord(id);
    assert.equal(rec.length, 2, 'removeu um só');
    assert.ok(rec.some((e) => e.hash === brB && e.pool === 'br'), 'outro hash br preservado');
    assert.ok(rec.some((e) => e.hash === seed && e.pool === 'seeds'), 'outro pool preservado');
    assert.equal(forgetObraHash({ ...id, hash: hx('be') }), false, 'hash ausente não conta');

    assert.equal(forgetObraHash({ ...id, hash: brB }), true);
    assert.equal(forgetObraHash({ ...id, hash: seed }), true);
    assert.equal(obraRecord(id).length, 0);
    // `o:` é do KV nativo: o registro que esvazia é esquecido pela PONTE (o
    // `cache.peek` do L1 devolveria null de qualquer jeito e não provaria nada).
    assert.equal(kvPeek(obraKey(id)), null, 'registro que esvazia tem a chave esquecida');
  } finally {
    forgetHashes(apiKey, [brA, brB, seed]);
  }
});

test('vaga br liberada pelo terminal aceita reposição SAME POOL', () => {
  const apiKey = 'chave-obra-repor-br';
  const imdbId = 'tt7100002';
  const id = identity(apiKey, { imdbId });
  autofetchLive.set({ autoFetchMax: 1, autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('d4'); const h2 = hx('e5');
  try {
    const lease = reserveObra({ ...id, pool: 'br', hash: h1 });
    commitObra(lease, { hash: h1, pool: 'br' });
    assert.equal(reserveObra({ ...id, pool: 'br', hash: h2 }), null, 'teto cheio antes do terminal');
    assert.equal(forgetObraHash({ ...id, hash: h1 }), true);
    assert.ok(reserveObra({ ...id, pool: 'br', hash: h2 }), 'terminal libera e a reposição br cabe');
  } finally {
    forgetHashes(apiKey, [h1, h2]);
  }
});

test('vaga any (cap=1) liberada pelo terminal aceita reposição', () => {
  const apiKey = 'chave-obra-repor-any';
  const imdbId = 'tt7100003';
  const id = identity(apiKey, { imdbId });
  autofetchLive.set({ autoFetchMax: 3, autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('f6'); const h2 = hx('a7');
  try {
    const lease = reserveObra({ ...id, pool: 'any', hash: h1 });
    commitObra(lease, { hash: h1, pool: 'any' });
    assert.equal(reserveObra({ ...id, pool: 'any', hash: h2 }), null, 'any=1/obra segue como decisão');
    assert.equal(forgetObraHash({ ...id, hash: h1 }), true);
    assert.ok(reserveObra({ ...id, pool: 'any', hash: h2 }), 'reposição any volta após liberar o terminal');
  } finally {
    forgetHashes(apiKey, [h1, h2]);
  }
});

test('packs da mesma temporada dividem o teto; episódios avulsos ficam separados', () => {
  const apiKey = 'chave-obra-pack';
  const imdbId = 'tt7100004';
  autofetchLive.set({ autoFetchMax: 1, autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId, season: 1, episode: null });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 2 });
  const pack1 = hx('b8'); const pack2 = hx('c9');
  const ep1 = hx('d0'); const ep2 = hx('e1');
  try {
    // Pack anunciado na busca do E01 e na do E02: as duas caem na TEMPORADA.
    const p1 = reserveObra({ ...identity(apiKey, { imdbId, season: 1, episode: 1 }), pool: 'br', hash: pack1, isPack: true });
    assert.ok(p1, 'primeiro pack entra');
    commitObra(p1, { hash: pack1, pool: 'br' });
    assert.equal(
      reserveObra({ ...identity(apiKey, { imdbId, season: 1, episode: 2 }), pool: 'br', hash: pack2, isPack: true }),
      null,
      'packs da mesma temporada (E01/E02) compartilham a vaga',
    );

    // Episódios avulsos têm identidade própria — e por isso vaga própria.
    // `reserveObra` é VOLÁTIL (só o `commitObra` grava o registro), então a
    // separação se prova pelo aceite, não pela reserva.
    const epLease1 = reserveObra({ ...identity(apiKey, { imdbId, season: 1, episode: 1 }), pool: 'br', hash: ep1 });
    const epLease2 = reserveObra({ ...identity(apiKey, { imdbId, season: 1, episode: 2 }), pool: 'br', hash: ep2 });
    assert.ok(epLease1, 'S01E01 tem vaga própria');
    assert.ok(epLease2, 'S01E02 tem vaga própria');
    commitObra(epLease1, { hash: ep1, pool: 'br' });
    commitObra(epLease2, { hash: ep2, pool: 'br' });

    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: null })).length, 1, 'chave do pack é a temporada');
    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: 1 })).length, 1, 'S01E01 separado');
    assert.equal(obraRecord(identity(apiKey, { imdbId, season: 1, episode: 2 })).length, 1, 'S01E02 separado');
  } finally {
    forgetHashes(apiKey, [pack1, pack2, ep1, ep2]);
  }
});

test('fila v3 preserva rare/slotLimit/episódio; o teto aceita o slot raro', () => {
  const apiKey = 'chave-obra-rare-queue';
  const imdbId = 'tt7100005';
  const searchKey = 'rare-queue-search';
  const account = accountScope(apiKey);
  autofetchLive.set({ autoFetchTopSeedsMax: 2, autoFetchRareMax: 4, autoFetchQueueDepth: 2, autoFetchTtl: 3600 });
  const hRare = hx('c8');
  const id = identity(apiKey, { imdbId, season: 1, episode: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  try {
    autofetch.writeQueue(searchKey, [
      {
        infoHash: hRare, pool: 'seeds', rare: true, slotLimit: 4, imdbId, season: 1, episode: 2,
        title: 'Movie 1080p BluRay', br: false, dubbed: false, quality: '1080p', size: 2 * 1024 ** 3,
      },
    ], 3600, PM, account);

    const fila = autofetch.readQueue(searchKey);
    assert.equal(fila.length, 1);
    assert.equal(fila[0].rare, true, 'evidência rara persistida');
    assert.equal(fila[0].slotLimit, 4, 'slotLimit persistido');
    assert.equal(fila[0].season, 1);
    assert.equal(fila[0].episode, 2, 'episódio não-pack preservado');
    assert.equal(fila[0].pool, 'seeds');

    // O slot raro da fila abre o teto da obra quando o candidato sobe.
    const lease = reserveObra({ ...id, pool: 'seeds', hash: hRare, rare: true, slotLimit: 4 });
    assert.ok(lease, 'slot raro cabe no teto elevado');
    commitObra(lease, { hash: hRare, pool: 'seeds' });
    assert.equal(obraRecord(id).length, 1);
  } finally {
    autofetch.dropQueue(searchKey);
    forgetHashes(apiKey, [hRare]);
  }
});
