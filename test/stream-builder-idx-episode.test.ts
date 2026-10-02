// Pack do índice sem URI: título genérico "4ª Temporada" passava em qualquer
// E; o dn= contraditório mora no magnet-bank. O pipeline enriquece em lote
// antes do corte e só então grava no releaseIndex.
process.env.CACHE_PERSIST = 'false';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as cache from '../src/utils/cache.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idx-ep-'));
const hex = (c: string) => c.repeat(40);
const richMagnet = (h: string, dn: string) =>
  `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(dn)}`;

const TITLE = 'True Detective 4ª Temporada Dublado';
const META = { name: 'True Detective', year: 2014 };
const savedEnabled = config.magnetBank.enabled;

beforeEach(() => {
  bank.resetForTests();
  bank.open(FRESH_DIR(), { forceMemory: true });
  config.magnetBank.enabled = true;
  cache.clear();
});

after(() => {
  bank.resetForTests();
  config.magnetBank.enabled = savedEnabled;
  cache.clear();
});

test('prepareCandidateStreams: idx sem magnet + bank dn S04E03 corta em S4E1', () => {
  const hBad = hex('a');
  const hOk = hex('b');
  const imdbId = 'tt8800201';
  bank.captureItems([
    {
      title: TITLE,
      infoHash: hBad,
      magnet: richMagnet(hBad, 'True.Detective.S04E03.1080p.WEB-DL.DUBLADO'),
      seeders: 1,
      isBr: true,
    },
    {
      title: TITLE,
      infoHash: hOk,
      magnet: richMagnet(hOk, 'True.Detective.S04E01.1080p.WEB-DL.DUBLADO'),
      seeders: 1,
      isBr: true,
    },
  ], 'apachetorrent-cardigann', { imdbId, season: 4, episode: 1 });
  bank.flushNow();

  // Espelha idxReleasesToRaw: só hash, título pack, SEM magnet.
  const raw = idxReleasesToRaw([
    {
      hash: hBad,
      title: TITLE,
      seeders: 1,
      indexer: 'apachetorrent-cardigann',
      isBr: true,
      dubbed: true,
      quality: '1080p',
    },
    {
      hash: hOk,
      title: TITLE,
      seeders: 1,
      indexer: 'apachetorrent-cardigann',
      isBr: true,
      dubbed: true,
      quality: '1080p',
    },
  ]);
  assert.ok(!('magnet' in raw[0]), 'pré-condição: idx sem magnet');

  const pool = prepareCandidateStreams(raw as any, {
    meta: META,
    imdbId,
    season: 4,
    episode: 1,
  });
  const hashes = pool.streams.map((s) => String(s.infoHash || '').toLowerCase());
  assert.ok(!hashes.includes(hBad), 'dn S04E03 do bank corta o pack no S4E1');
  assert.ok(hashes.includes(hOk), 'dn S04E01 do bank sobrevive');

  // Record só depois do corte: E03 não fica indexado sob S4E1.
  const indexed = releaseIndex.lookup(imdbId, { season: 4, episode: 1 }).map((r) => r.hash);
  assert.ok(!indexed.includes(hBad), 'índice não grava o E03 sob S4E1');
  assert.ok(indexed.includes(hOk), 'índice grava o E01 sobrevivente');
});

test('prepareCandidateStreams: sem bank (hash ausente) mantém fail-open do título pack', () => {
  const h = hex('c');
  const imdbId = 'tt8800202';
  const raw = idxReleasesToRaw([{
    hash: h,
    title: TITLE,
    seeders: 1,
    indexer: 'apachetorrent-cardigann',
    isBr: true,
    dubbed: true,
    quality: '1080p',
  }]);
  const pool = prepareCandidateStreams(raw as any, {
    meta: META,
    imdbId,
    season: 4,
    episode: 1,
  });
  assert.equal(pool.streams.length, 1, 'sem dn no bank o pack genérico ainda passa (fail-open)');
  assert.equal(String(pool.streams[0].infoHash).toLowerCase(), h);
});
