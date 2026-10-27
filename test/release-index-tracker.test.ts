// Tracker preservado no índice de releases: o `record` não rebaixa o tracker
// gravado para vazio. Saiu de `allowed-source-indexer.test.ts` quando o filtro de origem TS
// (`allowedSourceIndexer`) ficou sem chamador: o `ji` é aplicado no Rust.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as releaseIndex from '../src/utils/release-index.js';

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
});
