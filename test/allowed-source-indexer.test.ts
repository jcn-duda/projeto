// Filtro de origem compartilhada (idx / magnet-bank) pela config do pedido:
// torrentio/`ji`, tracker preservado no índice. R4: os casos da via rápida
// (`attemptIndexFastPath`) e da instantânea TS (`collectInstantItems`) saíram
// com os módulos; a reserva TS (`collectFallbackItems`) saiu depois, junto com
// o fallback 📦 do build Node. O filtro continua.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { allowedSourceIndexer } from '../src/providers/allowed-source-indexer.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';
import { testOpts } from './helpers/stub.js';

const hex = (c: string) => c.repeat(40);

const tempDirs: string[] = [];
const saved = {
  releaseIndex: config.releaseIndex.enabled,
  fallbackEnabled: config.magnetBank.fallbackEnabled,
};

function withOpts<T>(over: Record<string, unknown>, fn: () => T): T {
  return runtime.run({ opts: testOpts(over), encoded: 'src-filter' }, fn);
}

beforeEach(() => {
  bank.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-filter-'));
  tempDirs.push(dir);
  bank.open(dir);
  config.releaseIndex.enabled = true;
  config.magnetBank.enabled = true;
  config.magnetBank.fallbackEnabled = true;
});

after(() => {
  bank.resetForTests();
  config.releaseIndex.enabled = saved.releaseIndex;
  config.magnetBank.fallbackEnabled = saved.fallbackEnabled;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('helper: torrentio só com provider torrentio/both', () => {
  withOpts({ providers: ['jackett'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('torrentio'), false);
  });
  withOpts({ providers: ['jackett', 'torrentio'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('torrentio'), true);
  });
  withOpts({ providers: ['both'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('torrentio'), true);
  });
});

test('helper: ji explícito filtra Jackett; lista vazia passa tudo; origem não-indexer passa', () => {
  withOpts({ providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] }, () => {
    assert.equal(allowedSourceIndexer('kickasstorrents-to'), true);
    assert.equal(allowedSourceIndexer('thepiratebay'), false);
    assert.equal(allowedSourceIndexer('bludv'), true, 'scraper bludv não é ji');
    assert.equal(allowedSourceIndexer('autofetch'), true);
    assert.equal(allowedSourceIndexer('!!!nao-indexer!!!'), true);
  });
  withOpts({ providers: ['jackett'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('thepiratebay'), true);
    assert.equal(allowedSourceIndexer('kickasstorrents-to'), true);
  });
});

test('helper: index-only passa mesmo fora do ji (só chega pelo idx/banco)', () => {
  // VPS 2026-09-18: `.env` com `apachetorrent` (id inexistente) e a /configure
  // desmarcando `apachetorrent-cardigann` — o filtro cortava a fonte de todos.
  const savedIndexOnly = config.jackett.indexOnlyIndexers;
  config.jackett.indexOnlyIndexers = ['apachetorrent-cardigann'];
  try {
    withOpts({ providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] }, () => {
      assert.equal(allowedSourceIndexer('apachetorrent-cardigann'), true);
      assert.equal(allowedSourceIndexer('Apachetorrent-Cardigann'), true);
      assert.equal(allowedSourceIndexer('thepiratebay'), false, 'indexer comum segue o ji');
    });
  } finally {
    config.jackett.indexOnlyIndexers = savedIndexOnly;
  }
});

test('helper: vacatorrent (card local do piloto) não fica invisível pelo ji', () => {
  // O id do piloto é o do card REAL (`crawl.indexer_identity`) e NÃO é
  // index-only. O `ji` o governa como qualquer indexer BR comum: incluído (ou
  // lista vazia = tudo) entra; fora por escolha explícita do usuário, segue
  // oculto — o acervo raspado não fura a seleção da instalação.
  const savedIndexOnly = config.jackett.indexOnlyIndexers;
  config.jackett.indexOnlyIndexers = [];
  try {
    withOpts({ providers: ['jackett'], jackettIndexers: ['vacatorrent', 'bludv-cardigann'] }, () => {
      assert.equal(allowedSourceIndexer('vacatorrent'), true);
      assert.equal(allowedSourceIndexer('Vacatorrent'), true);
    });
    withOpts({ providers: ['jackett'], jackettIndexers: [] }, () => {
      assert.equal(allowedSourceIndexer('vacatorrent'), true, 'ji vazio passa tudo');
    });
    withOpts({ providers: ['jackett'], jackettIndexers: ['thepiratebay'] }, () => {
      assert.equal(allowedSourceIndexer('vacatorrent'), false, 'fora do ji, oculto (não é index-only)');
    });
  } finally {
    config.jackett.indexOnlyIndexers = savedIndexOnly;
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
