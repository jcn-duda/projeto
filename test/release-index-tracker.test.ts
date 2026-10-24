// Tracker preservado no índice de releases: o `record` não rebaixa o tracker
// gravado para vazio e o `idxReleasesToRaw` cai no indexer quando a linha é
// antiga. Saiu de `allowed-source-indexer.test.ts` quando o filtro de origem TS
// (`allowedSourceIndexer`) ficou sem chamador: o `ji` é aplicado no Rust.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';

const hex = (c: string) => c.repeat(40);

const tempDirs: string[] = [];
const saved = {
  releaseIndex: config.releaseIndex.enabled,
};

beforeEach(() => {
  bank.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-tracker-'));
  tempDirs.push(dir);
  bank.open(dir);
  config.releaseIndex.enabled = true;
  config.magnetBank.enabled = true;
});

after(() => {
  bank.resetForTests();
  config.releaseIndex.enabled = saved.releaseIndex;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('idxReleasesToRaw preserva tracker gravado (fallback para indexer)', () => {
  const withTracker = [{
    hash: hex('1'), title: 'Filme 1080p', seeders: 3, size: 1,
    indexer: 'torrentio', tracker: 'ThePirateBay', isBr: false, dubbed: false, quality: '1080p',
  }];
  assert.equal(idxReleasesToRaw(withTracker)[0].tracker, 'ThePirateBay');
  assert.equal(idxReleasesToRaw(withTracker)[0].indexer, 'torrentio');
  const legacy = [{
    hash: hex('2'), title: 'Filme 720p', seeders: 1, size: null,
    indexer: 'kickasstorrents-to', isBr: true, dubbed: true, quality: '720p',
  }];
  assert.equal(idxReleasesToRaw(legacy)[0].tracker, 'kickasstorrents-to');
});

test('record preserva tracker sem rebaixar para vazio', () => {
  const imdb = 'tt9100001';
  const hash = hex('a');
  releaseIndex.record(imdb, {}, [{
    title: 'Filme Teste 2024 1080p Dublado',
    infoHash: hash,
    seeders: 5,
    indexer: 'torrentio',
    tracker: 'ThePirateBay',
    isBr: true,
  }]);
  assert.equal(releaseIndex.lookup(imdb)[0].tracker, 'ThePirateBay');
  releaseIndex.record(imdb, {}, [{
    title: 'Filme Teste 2024 1080p Dublado',
    infoHash: hash,
    seeders: 6,
    indexer: 'torrentio',
    tracker: '',
    isBr: true,
  }]);
  assert.equal(releaseIndex.lookup(imdb)[0].tracker, 'ThePirateBay', 'vazio não apaga prior');
  assert.equal(idxReleasesToRaw(releaseIndex.lookup(imdb))[0].tracker, 'ThePirateBay');
});
