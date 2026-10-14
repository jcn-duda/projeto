// Integração do banco de magnets vivo com a fiação REAL: `jackett.search`
// (por indexer e `/all` agregado) e `prepareCandidateStreams` (o filtro de
// título do pipeline). Cobre a fila assíncrona (não escreve no tick, drena no
// setImmediate) e o `close()` que flusha antes de fechar.
//
// Sem rede: `fetch` é dublê e `config`/cache são restaurados em finally.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'magnet-bank-int-'));
const hex = (c: string) => c.repeat(40);
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;

function fakeResponse(body: unknown, { status = 200 }: { status?: number } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
type FakeResponse = ReturnType<typeof fakeResponse>;

interface FetchCall { url: string; init: any; }
interface JackettFetch {
  (url: unknown, init?: any): Promise<FakeResponse>;
  calls: FetchCall[];
  handler?: (call: FetchCall) => FakeResponse | Promise<FakeResponse>;
}

function makeFetch(): JackettFetch {
  const calls: FetchCall[] = [];
  const fetchImpl: JackettFetch = (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(fetchImpl.handler ? fetchImpl.handler(call) : fakeResponse({ Results: [] }));
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function withJackett(fetchImpl: JackettFetch, fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  const saved = { url: config.jackett.url, apiKey: config.jackett.apiKey };
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'test-key';
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch;
  cache.clear();
  try {
    await fn();
  } finally {
    cache.clear();
    globalThis.fetch = realFetch;
    config.jackett.url = saved.url;
    config.jackett.apiKey = saved.apiKey;
  }
}

beforeEach(() => {
  bank.resetForTests();
  bank.open(FRESH_DIR());
  metrics.reset();
  config.magnetBank.enabled = true;
  config.magnetBank.queueMax = 500;
});

after(() => {
  bank.resetForTests();
});

test('jackett.search por indexer captura item com hash e identidade da obra', async () => {
  const h = hex('a');
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({
    Results: [{ Title: 'Filme Teste 2024 1080p', Seeders: 7, MagnetUri: magnet(h), InfoHash: h }],
  });
  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Filme Teste', 'movie', ['bludv-cardigann'], {
      imdbId: 'tt700', season: null, episode: null, resetPassedFilter: true,
    });
    assert.equal(items.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    const row = bank.lookup(h);
    assert.ok(row, 'a captura foi drenada');
    assert.equal(row!.title, 'Filme Teste 2024 1080p');
    assert.equal(row!.seedersLast, 7);
    const sources = bank.sourcesFor(h);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].indexer, 'bludv-cardigann', 'indexer do plano, minúsculo');
    const works = bank.worksFor(h);
    assert.equal(works.length, 1);
    assert.equal(works[0].imdb, 'tt700');
    assert.equal(works[0].passedFilter, 0, 'captura nasce sem filtro');
  });
});

test('jackett.search /all agregado captura com o indexer do item', async () => {
  const h = hex('b');
  const savedIndexers = config.jackett.indexers;
  config.jackett.indexers = [];
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (!call.url.includes('/indexers/all/results')) return fakeResponse({ Results: [] });
    return fakeResponse({
      Results: [{ Title: 'Filme Teste 2024 720p', Seeders: 4, MagnetUri: magnet(h), InfoHash: h, TrackerId: 'all-tracker' }],
    });
  };
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('Filme Teste', 'movie', null, { imdbId: 'tt701', resetPassedFilter: true });
      assert.equal(items.length, 1);
      await new Promise((resolve) => setImmediate(resolve));
      const sources = bank.sourcesFor(h);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].indexer, 'all-tracker', 'no /all usa o indexer do item');
      assert.equal(bank.worksFor(h)[0].imdb, 'tt701');
    });
  } finally {
    config.jackett.indexers = savedIndexers;
  }
});

test('prepareCandidateStreams marca passed_filter 1 no sobrevivente e 0 no cortado', () => {
  const ctx = { imdbId: 'tt800', season: null, episode: null, resetPassedFilter: true };
  const hs = hex('c');
  const hc = hex('d');
  const survivor = { title: 'Filme Teste 2024 1080p', infoHash: hs, seeders: 5, magnet: magnet(hs) };
  const cut = { title: 'Outra Producao Totalmente Diferente 1999 720p', infoHash: hc, seeders: 5, magnet: magnet(hc) };

  // Captura do Jackett cria a obra (base 0) antes do filtro da mesma busca.
  bank.captureItems([survivor, cut], 'nerdfilmes', ctx);
  bank.flushNow();
  assert.equal(bank.worksFor(hs)[0].passedFilter, 0);

  prepareCandidateStreams([survivor, cut] as any, {
    meta: { name: 'Filme Teste', year: 2024 },
    imdbId: 'tt800',
  } as any);
  bank.flushNow();
  assert.equal(bank.worksFor(hs)[0].passedFilter, 1, 'sobrevivente do filtro de título');
  assert.equal(bank.worksFor(hc)[0].passedFilter, 0, 'cortado pelo filtro');
});

test(
  'close() flusha a fila e persiste antes de fechar (SQLite)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    bank.resetForTests();
    const dbPath = path.join(FRESH_DIR(), 'close.db');
    bank.open(dbPath);
    const h = hex('e');
    bank.captureItems([{ title: 'Close', infoHash: h, magnet: magnet(h) }], 'x', {});
    bank.close();
    bank.open(dbPath);
    assert.equal(bank.lookup(h)?.title, 'Close', 'o close drenou a fila antes de fechar');
    bank.resetForTests();
  },
);
