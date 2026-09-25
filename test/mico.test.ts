// Mico Leão Dublado V2: card virtual da /configure + fonte opcional do
// colhedor. Parse do `title`, fail-open, breaker local, id inválido, o card no
// catálogo, a separação do Jackett e a garantia de que o lixo de outra obra
// morre no filtro de relevância antes do índice. Nada aqui toca rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
config.seed.enabled = false;
import * as mico from '../src/providers/mico.js';
import jackett, { effectiveJackettIndexers } from '../src/providers/jackett.js';
import * as indexerStatus from '../src/providers/indexer-status.js';
import { collectRaw } from '../src/providers/search-orchestrator.js';
import * as runtime from '../src/runtime.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { stubFetch } from './helpers/stub.js';
import * as bank from '../src/utils/magnet-bank.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const ok = (streams: unknown[]) => ({ ok: true, status: 200, json: async () => ({ streams }) });

async function withMico<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { enabled: config.mico.enabled, harvest: config.mico.harvest };
  config.mico.enabled = true;
  config.mico.harvest = true;
  mico._resetBreaker();
  try {
    return await fn();
  } finally {
    config.mico.enabled = saved.enabled;
    config.mico.harvest = saved.harvest;
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

test('MICO_ENABLED=false: nenhum fetch e o card some do catálogo', async () => {
  const saved = config.mico.enabled;
  config.mico.enabled = false;
  const stub = stubFetch(() => ok([]));
  try {
    assert.deepEqual(await mico.search({ type: 'movie', imdbId: 'tt7286456' }), []);
    assert.equal(stub.calls.length, 0);
    assert.equal(mico.catalogEntry(), null);
  } finally {
    stub.restore();
    config.mico.enabled = saved;
  }
});

test('card: entra no catálogo como BR e nunca vira consulta ao Jackett', async () => {
  await withMico(async () => {
    assert.deepEqual(mico.catalogEntry(), { id: 'mico', label: 'Mico Leão Dublado', language: 'pt-BR', isBr: true, virtual: true });
    assert.deepEqual(mico.jackettOnly(['bludv-cardigann', 'MICO', 'yts']), ['bludv-cardigann', 'yts']);
    assert.deepEqual(effectiveJackettIndexers(['mico']), []);
    const savedKey = config.jackett.apiKey;
    config.jackett.apiKey = 'test-key';
    const stub = stubFetch(() => ok([]));
    try {
      // Lista explícita só com o card: nenhuma chamada ao Jackett (nem /all).
      assert.deepEqual(await jackett.search('Coringa', 'movie', ['mico']), []);
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
      config.jackett.apiKey = savedKey;
    }
  });
});

test('collectRaw: ji só com o card consulta o Mico e não o Jackett', async () => {
  await withMico(async () => {
    const savedKey = config.jackett.apiKey;
    const savedBludv = config.bludv.enabled;
    config.jackett.apiKey = 'test-key';
    config.bludv.enabled = false;
    const stub = stubFetch((url) => {
      assert.match(url, /mico-leao.*\/stream\/movie\/tt7286456\.json$/, 'só o Mico é consultado');
      return ok([{ title: 'Coringa 2019 1080p Dublado 👥 7', infoHash: H1 }]);
    });
    const requestOpts = {
      ...runtime.normalize(null),
      providers: ['jackett'],
      jackettIndexers: ['mico'],
      debridService: '',
      debridApiKey: '',
    };
    try {
      const result = await runtime.run({ opts: requestOpts, encoded: 'mico-card' }, () =>
        collectRaw(
          'Joker 2019',
          'movie',
          'tt7286456',
          'Coringa 2019',
          { names: ['Joker', 'Coringa'], year: 2019, isSeries: false, season: null, episode: null } as any,
          null,
          null,
          Date.now() + 3000,
        ));
      assert.equal(stub.calls.length, 1);
      assert.deepEqual(result.items.map((i: any) => i.indexer), ['mico']);
    } finally {
      stub.restore();
      config.jackett.apiKey = savedKey;
      config.bludv.enabled = savedBludv;
    }
  });
});

test('card: busca viva pinta o status; a do colhedor não', async () => {
  await withMico(async () => {
    indexerStatus.clear();
    const stub = stubFetch(() => ok([{ title: 'Coringa 2019 Dublado 👥 3', infoHash: H1 }]));
    try {
      await mico.search({ type: 'movie', imdbId: 'tt7286456' }, { recordStatus: false });
      assert.equal(indexerStatus.get('mico'), null);
      await mico.search({ type: 'movie', imdbId: 'tt7286456' });
      assert.equal(indexerStatus.get('mico')?.state, 'online');
      const diag = await jackett.test('mico', '', 'movie');
      assert.equal(diag.ok, true);
      assert.equal((diag as any).results, 1);
    } finally {
      stub.restore();
      indexerStatus.clear();
    }
  });
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

test('banco vivo: item do Mico entra com fonte mico e os trackers de `sources`', async () => {
  const savedBank = config.magnetBank.enabled;
  config.magnetBank.enabled = true;
  bank.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mico-bank-'));
  bank.open(dir);
  await withMico(async () => {
    const stub = stubFetch(() => ok([{
      title: 'Matrix 1999 1080p Dublado 👥 0',
      infoHash: H1,
      sources: ['tracker:udp://tracker.exemplo.org:1337/announce', 'dht:' + H1, 'lixo'],
    }]));
    try {
      const out = await mico.search({ type: 'movie', imdbId: 'tt0133093' });
      assert.match(String(out[0].magnet), /^magnet:\?xt=urn:btih:a{40}&tr=udp%3A%2F%2Ftracker\.exemplo\.org/);
      assert.doesNotMatch(String(out[0].magnet), /[?&]dn=/, 'título do post não vira dn=');
      bank.flushNow();
      assert.deepEqual(bank.sourcesFor(H1).map((r: any) => r.indexer), ['mico']);
      assert.match(String(bank.lookup(H1)?.uri), /tracker\.exemplo\.org/);
      assert.ok(bank.worksFor(H1).some((w: any) => w.imdb === 'tt0133093'), 'obra do pedido registrada');
    } finally {
      stub.restore();
      bank.resetForTests();
      config.magnetBank.enabled = savedBank;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('estado vivo: sucesso, falha e circuito aberto chegam ao onQueryResult', async () => {
  await withMico(async () => {
    const seen: string[] = [];
    const onQueryResult = (info: { responded: boolean; reason?: string }) => { seen.push(info.responded ? 'ok' : String(info.reason)); };
    let fail = false;
    const stub = stubFetch(() => (fail ? { ok: false, status: 503, json: async () => ({}) } : ok([])));
    try {
      await mico.search({ type: 'movie', imdbId: 'tt0000002' }, { onQueryResult });
      fail = true;
      for (let i = 0; i < config.mico.breakerFailures; i += 1) {
        await mico.search({ type: 'movie', imdbId: 'tt0000002' }, { onQueryResult });
      }
      await mico.search({ type: 'movie', imdbId: 'tt0000002' }, { onQueryResult });
      assert.deepEqual(seen, ['ok', ...Array(config.mico.breakerFailures).fill('error'), 'breaker']);
    } finally {
      stub.restore();
    }
  });
});
