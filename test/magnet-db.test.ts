// Banco de magnets (namespace `mag:`): memória durável por hash, escopada por
// serviço+conta. Só evidência medida entra — o positivo vem da checagem de
// cache do debrid ou do /resolve; o negativo, de falha determinística do play.
// Estes testes cobrem o módulo e os dois pontos de consumo da listagem:
// o descarte em `applyDebrid` e o desempate em `sortAndLimit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import debrid from '../src/debrid/index.js';
import { applyDebrid } from '../src/providers/index.js';
import * as autofetch from '../src/providers/autofetch.js';
import { accountScope } from '../src/utils/request-key.js';
import { sortAndLimit } from '../src/utils/format.js';

const runWith = (patch: { opts: any; encoded: string }, fn: () => any) => runtime.run(patch, fn);

// Adaptador fake `cacheCheck: true` no registry real (mesmo padrão do
// debrid-avail). Por padrão nada está em cache: a lista passa inteira como
// torrent puro e o que decide o teste é o descarte PRÉ-checagem.
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

test('alive/bad: leitura escopada por serviço e conta', () => {
  const hash = 'a'.repeat(40);
  magnetdb.markAlive('premiumize', 'conta-mag-x', [hash]);
  magnetdb.markBad('premiumize', 'conta-mag-x', hash);
  assert.equal(magnetdb.isAlive('premiumize', 'conta-mag-x', hash), true);
  assert.equal(magnetdb.isBad('premiumize', 'conta-mag-x', hash), true);
  // Outra conta e outro serviço não veem o histórico — cache do debrid
  // pertence à conta, e "morto" num serviço não vale para outro.
  assert.equal(magnetdb.isAlive('premiumize', 'conta-mag-y', hash), false);
  assert.equal(magnetdb.isBad('torbox', 'conta-mag-x', hash), false);
  // Hash é normalizado: marcar em maiúsculas e ler em minúsculas casa.
  magnetdb.markAlive('premiumize', 'conta-mag-x', ['B'.repeat(40)]);
  assert.equal(magnetdb.isAlive('premiumize', 'conta-mag-x', 'b'.repeat(40)), true);
});

test('checkCached com positivo confirmado grava o histórico alive', async () => {
  const { adapter } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-confirm';
  try {
    await runWith({ opts: userOpts(key), encoded: '' }, () => debrid.checkCached(['c1'.repeat(20)]));
    assert.equal(
      magnetdb.isAlive('premiumize', key, 'c1'.repeat(20)),
      true,
      'positivo medido vira histórico durável, independente do TTL curto do davail',
    );
  } finally {
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid descarta hash ruim no banco e morto no autofetch, antes da checagem', async () => {
  const { adapter, calls } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-drop';
  const badHash = 'd'.repeat(40);
  const deadHash = 'e'.repeat(40);
  const goodHash = 'f'.repeat(40);
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
    assert.deepEqual(calls[0], [goodHash]);
    assert.equal((metrics.snapshot() as any).counters['magnetdb.dropped'], 2);
  } finally {
    metrics.reset();
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

test('sortAndLimit: histórico instantâneo desempata acima dos seeders', () => {
  const hot = '3'.repeat(40);
  const proven = '4'.repeat(40);
  const mk = (hash: string, seeders: number) => ({
    name: `filme ${hash}`,
    title: 'Filme Teste 1080p',
    infoHash: hash,
    _seeders: seeders,
    _quality: '1080p',
  });
  const semHistorico = sortAndLimit([mk(hot, 50), mk(proven, 5)] as any, {});
  assert.equal((semHistorico[0] as any).infoHash, hot, 'sem registro, seeders decidem');
  const comHistorico = sortAndLimit([mk(hot, 50), mk(proven, 5)] as any, {
    instant: (h: string) => h === proven,
  } as any);
  assert.equal((comHistorico[0] as any).infoHash, proven, 'magnet que já provou tocar na hora vence a aposta de seeders');
});
