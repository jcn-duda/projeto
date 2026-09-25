// Mico Leão Dublado V2: fonte SÓ do colhedor. Parse do `title`, fail-open,
// breaker local, id inválido e a garantia de que o lixo de outra obra morre no
// filtro de relevância do colhedor antes do índice. Nada aqui toca rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
config.seed.enabled = false;
import * as mico from '../src/providers/mico.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { stubFetch } from './helpers/stub.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const ok = (streams: unknown[]) => ({ ok: true, status: 200, json: async () => ({ streams }) });

async function withMico<T>(fn: () => Promise<T>): Promise<T> {
  const saved = config.mico.harvest;
  config.mico.harvest = true;
  mico._resetBreaker();
  try {
    return await fn();
  } finally {
    config.mico.harvest = saved;
    mico._resetBreaker();
  }
}

test('parse: título limpo, seeders do 👥, tamanho, isBr por (brazilian', async () => {
  await withMico(async () => {
    const stub = stubFetch((url) => {
      assert.match(url, /\/stream\/movie\/tt7286456\.json$/);
      return ok([
        { name: 'Mico', title: 'Coringa.2019.1080p.BluRay (brazilian, eng) 👥 12\n💾 2.5 GB', infoHash: H1.toUpperCase() },
        { name: 'Mico', title: 'Joker.2019.2160p.WEB-DL\n💾 29.0 GB', infoHash: H2 },
        { name: 'Mico', title: 'sem hash', infoHash: 'xyz' },
        { name: 'Mico', title: 'Interstelar.2014.1080p.DUAL-RICKSZ (brazili…', infoHash: 'c'.repeat(40) },
      ]);
    });
    try {
      const out = await mico.search({ type: 'movie', imdbId: 'tt7286456' });
      assert.equal(out.length, 3);
      assert.equal(out[2].title, 'Interstelar.2014.1080p.DUAL-RICKSZ', 'sufixo truncado pelo Mico sai');
      assert.equal(out[2].isBr, true, '(brazili… truncado ainda é BR');
      assert.equal(out[0].title, 'Coringa.2019.1080p.BluRay');
      assert.equal(out[0].infoHash, H1);
      assert.equal(out[0].seeders, 12);
      assert.equal(out[0].size, Math.round(2.5 * 1024 ** 3));
      assert.equal(out[0].isBr, true);
      assert.equal(out[0].indexer, 'mico');
      assert.equal(out[1].title, 'Joker.2019.2160p.WEB-DL');
      assert.equal(out[1].seeders, 1, 'sem 👥 vale o neutro 1');
      assert.equal(out[1].isBr, false);
    } finally {
      stub.restore();
    }
  });
});

test('série monta <id>:<S>:<E>; id inválido e série sem episódio não fazem fetch', async () => {
  await withMico(async () => {
    const stub = stubFetch(() => ok([]));
    try {
      await mico.search({ type: 'series', imdbId: 'tt0944947', season: 2, episode: 3 });
      assert.match(stub.calls[0].url, /\/stream\/series\/tt0944947:2:3\.json$/);
      assert.deepEqual(await mico.search({ type: 'movie', imdbId: '../etc' }), []);
      assert.deepEqual(await mico.search({ type: 'series', imdbId: 'tt0944947', season: 2, episode: null }), []);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
});

test('fail-open em HTTP 500 e erro de rede; breaker abre após N falhas', async () => {
  await withMico(async () => {
    let n = 0;
    const stub = stubFetch(() => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { ok: false, status: 500, json: async () => ({}) };
    });
    try {
      for (let i = 0; i < config.mico.breakerFailures; i += 1) {
        assert.deepEqual(await mico.search({ type: 'movie', imdbId: 'tt0000001' }), []);
      }
      const calls = stub.calls.length;
      assert.deepEqual(await mico.search({ type: 'movie', imdbId: 'tt0000001' }), []);
      assert.equal(stub.calls.length, calls, 'circuito aberto não consulta');
    } finally {
      stub.restore();
    }
  });
});

test('MICO_HARVEST=false: nenhum fetch', async () => {
  const saved = config.mico.harvest;
  config.mico.harvest = false;
  const stub = stubFetch(() => ok([]));
  try {
    assert.deepEqual(await mico.search({ type: 'movie', imdbId: 'tt7286456' }), []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    config.mico.harvest = saved;
  }
});

test('colhedor: item do Mico da obra entra no índice, lixo de outra obra é cortado', async () => {
  const saved = { indexers: config.jackett.indexers, tmdb: config.tmdb.apiKey, bludv: config.bludv.enabled };
  config.jackett.indexers = [];
  config.tmdb.apiKey = '';
  config.bludv.enabled = false;
  cache.set('meta:movie:tt9600001', { name: 'Coringa', year: '2019', type: 'movie' }, 3600);
  await withMico(async () => {
    const stub = stubFetch((url) => {
      if (url.includes('mico-leao')) {
        return ok([
          { title: 'Coringa 2019 1080p Dublado (brazilian) 👥 5', infoHash: H1 },
          { title: 'Harley Quinn S01E01 1080p (brazilian) 👥 9', infoHash: H2 },
        ]);
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    try {
      await harvestWorker.harvestOne({ imdbId: 'tt9600001', type: 'movie', reason: `mico-${Date.now()}` } as any);
      const hashes = releaseIndex.lookupQuiet('tt9600001', {}).map((r: any) => r.hash);
      assert.ok(hashes.includes(H1), 'release da obra entrou');
      assert.ok(!hashes.includes(H2), 'lixo de outra obra cortado pelo filtro');
    } finally {
      stub.restore();
      config.jackett.indexers = saved.indexers;
      config.tmdb.apiKey = saved.tmdb;
      config.bludv.enabled = saved.bludv;
    }
  });
});
