// Descarte pré-checagem no applyDebrid: hash `bad` do banco e `dead` da
// blacklist do autofetch saem da lista antes de gastar lote — e sem
// histórico nada sai (controle).
// Extraído de test/magnet-db.test.ts (teto 400 linhas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import debrid from '../src/debrid/index.js';
import { applyDebrid } from '../src/providers/index.js';
import * as autofetch from '../src/providers/autofetch.js';
import { accountScope } from '../src/utils/request-key.js';

const runWith = (patch: { opts: any; encoded: string }, fn: () => any) => runtime.run(patch, fn);

// Adaptador fake `cacheCheck: true` no registry real (mesmo padrão do
// arquivo de origem). Por padrão nada está em cache.
function makeFake(handler?: (apiKey: string, infoHashes: string[]) => any) {
  const calls: string[][] = [];
  const adapter = {
    id: 'premiumize',
    label: 'Premiumize fake',
    short: 'pm',
    cacheCheck: true,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[]) {
      calls.push([...infoHashes]);
      return handler ? handler(_apiKey, infoHashes) : { cached: new Set(), complete: true };
    },
    async resolveLink() {
      return null;
    },
  };
  return { adapter, calls };
}

function userOpts(apiKey: string) {
  return {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
  };
}

const stream = (hash: string) => ({ name: `filme ${hash}`, title: `Filme Teste ${hash}`, infoHash: hash });

test('applyDebrid descarta hash ruim no banco e morto no autofetch, antes da checagem', async () => {
  const { adapter, calls } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-drop';
  const badHash = 'd'.repeat(40);
  const deadHash = 'e'.repeat(40);
  const goodHash = 'f'.repeat(40);
  magnetdb.forgetBad('premiumize', key, badHash);
  magnetdb.markBad('premiumize', key, badHash);
  autofetch.blacklist('premiumize', accountScope(key), deadHash);
  metrics.reset();
  try {
    const out = await runWith({ opts: userOpts(key), encoded: '' }, () =>
      applyDebrid([stream(badHash), stream(deadHash), stream(goodHash)] as any, {
        season: null,
        episode: null,
        imdbId: 'tt0000001',
        searchKey: 'magnet-db-drop',
        deadlineAt: Date.now() + 8000,
        onCacheResult: null,
        workHint: null,
      } as any),
    );
    assert.equal(out.length, 1, 'só o hash sem histórico sobrevive');
    // O sobrevivente é identificável por hash na URL de /resolve ou no
    // infoHash puro (depende de DEBRID_RESOLVE_UNCACHED); o que importa é o
    // conjunto: o bom fica, os ruins somem.
    const dump = JSON.stringify(out);
    assert.ok(dump.includes(goodHash), 'o hash limpo permanece na lista');
    assert.ok(!dump.includes(badHash), 'o hash ruim no banco saiu da lista');
    assert.ok(!dump.includes(deadHash), 'o hash morto no autofetch saiu da lista');
    // O lote enviado ao debrid não carrega o lixo: não se gasta checagem
    // (nem upload, na AllDebrid) com o que já provou estar quebrado.
    // davail L1 pode servir o bom sem rede — se houve lote, só o bom entra.
    for (const batch of calls) {
      assert.deepEqual(batch, [goodHash]);
    }
    assert.equal((metrics.snapshot() as any).counters['magnetdb.dropped'], 2);
  } finally {
    metrics.reset();
    magnetdb.forgetBad('premiumize', key, badHash);
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid descarta hash bad mesmo em item fromFallback (via instantânea)', async () => {
  // A reserva 📦 do magnet-bank entra com fromFallback; o corte é por
  // infoHash — origem não isenta. Sem isto o hash NoVideo voltava na lista.
  const { adapter, calls } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-fallback-bad';
  // Hashes dedicados (não colidem com atalho `7` nem com disk residual).
  const badHash = 'fb'.repeat(20);
  const goodHash = 'fd'.repeat(20);
  magnetdb.forgetBad('premiumize', key, badHash);
  magnetdb.markBad('premiumize', key, badHash);
  metrics.reset();
  try {
    const fallback = {
      ...stream(badHash),
      name: 'reserva 📦',
      _fromFallback: true,
    };
    const out = await runWith({ opts: userOpts(key), encoded: '' }, () =>
      applyDebrid([fallback, stream(goodHash)] as any, {
        season: null,
        episode: null,
        imdbId: 'tt0000002',
        searchKey: 'magnet-db-fallback-bad',
        deadlineAt: Date.now() + 8000,
        onCacheResult: null,
        workHint: null,
      } as any),
    );
    const dump = JSON.stringify(out);
    assert.ok(!dump.includes(badHash), 'fromFallback bad sai no pruneKnownBroken');
    assert.ok(dump.includes(goodHash), 'hash limpo permanece');
    // davail L1 pode servir o bom sem rede — o contrato é o prune, não a
    // chamada. Se houve lote, o bad NÃO pode estar nele.
    for (const batch of calls) {
      assert.ok(!batch.includes(badHash), 'bad não gasta checagem');
    }
    assert.equal((metrics.snapshot() as any).counters['magnetdb.dropped.bad'], 1);
  } finally {
    metrics.reset();
    magnetdb.forgetBad('premiumize', key, badHash);
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid sem histórico não descarta nada (controle)', async () => {
  const { adapter } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  try {
    const out = await runWith({ opts: userOpts('chave-mag-controle'), encoded: '' }, () =>
      applyDebrid([stream('1'.repeat(40)), stream('2'.repeat(40))] as any, {
        season: null,
        episode: null,
        imdbId: 'tt0000001',
        searchKey: 'magnet-db-controle',
        deadlineAt: Date.now() + 8000,
        onCacheResult: null,
        workHint: null,
      } as any),
    );
    assert.equal(out.length, 2, 'sem evidência, nada sai da lista');
  } finally {
    debrid.BY_ID.set('premiumize', original as any);
  }
});
