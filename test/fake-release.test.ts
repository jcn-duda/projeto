// Release falsa: extensão executável no nome e o irmão sem extensão. Casos
// medidos no magnets.db (2026-09-24): Resident Evil (2026), ainda no cinema,
// com `….exe` no magnetdownload e o mesmo nome no LimeTorrents, cujo gêmeo o
// play já tinha provado sem vídeo.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';
import { isExecutableRelease, fakeReleaseBase, dropFakeReleases } from '../src/providers/fake-release.js';

const hex = (c: string) => c.repeat(40);
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;
const tempDirs: string[] = [];
const REAL = 'Resident Evil (2026) 1080p AMZN WEB-DL DDP5 1 H 264-FLUX.exe';
const TWIN = 'Resident Evil (2026) 1080p AMZN WEB DL DDP5 1 H 264 FLUX';

function capture(hash: string, title: string, indexers: string[], imdbId = 'tt35538033') {
  for (const indexer of indexers) {
    bank.captureItems([{ title, infoHash: hash, magnet: magnet(hash), seeders: 5 }], indexer, { imdbId, season: null, episode: null });
  }
  bank.flushNow();
}

beforeEach(() => {
  bank.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-rel-'));
  tempDirs.push(dir);
  bank.open(dir);
  metrics.reset();
  config.magnetBank.enabled = true;
});

after(() => {
  bank.resetForTests();
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('extensão executável: só quando fecha o nome', () => {
  for (const t of [REAL, 'The Uprising (2026) 1080p AMZN WEB-DL DDP5.exe', 'Movie 2026 1080p .exe', 'Movie 2026 1080p-FLUX.scr']) {
    assert.equal(isExecutableRelease(t), true, t);
  }
  for (const t of ['Rampart (2011) DVDSCR', '[ www.torrenting.com ] - Halo.S01.480p', 'The.Hangover.2009.DDC-P2P [NORARS]', 'Movie.2026.1080p.mkv']) {
    assert.equal(isExecutableRelease(t), false, t);
  }
  assert.equal(isExecutableRelease('Movie 2026 1080p', 'Movie.2026.1080p.x264.exe'), true, 'o dn também conta');
  assert.equal(fakeReleaseBase(REAL), fakeReleaseBase(TWIN), 'pontuação e extensão não distinguem o irmão');
});

test('corte: executável e irmão de um indexer saem; release real e conta ficam', () => {
  const exe = hex('1');
  const twin = hex('2');
  const real = hex('3');
  const conta = hex('4');
  capture(twin, TWIN, ['limetorrents']);
  // Mesmo nome, mas circulando por vários trackers: é a release real copiada.
  capture(real, TWIN, ['therarbg', 'thepiratebay']);
  const raw = [
    { title: REAL, infoHash: exe, indexer: 'magnetdownload' },
    { title: TWIN, infoHash: twin, indexer: 'limetorrents' },
    { title: TWIN, infoHash: real, indexer: 'therarbg' },
    { title: TWIN, infoHash: conta, fromAccount: true },
    { title: 'Resident Evil (2026) 1080p CAM', infoHash: hex('5'), indexer: 'therarbg' },
  ];
  const out = dropFakeReleases(raw as any, { imdbId: 'tt35538033' });
  assert.deepEqual(out.map((i) => i.infoHash), [real, conta, hex('5')]);
  assert.equal(metrics.snapshot().counters['search.fake.executable'], 1);
  assert.equal(metrics.snapshot().counters['search.fake.twin'], 1);
});

test('corte: o executável visto só no acervo também denuncia o irmão', () => {
  const twin = hex('6');
  capture(hex('7'), REAL, ['magnetdownload']);
  capture(twin, TWIN, ['limetorrents']);
  const out = dropFakeReleases([{ title: TWIN, infoHash: twin, indexer: 'limetorrents' }] as any, { imdbId: 'tt35538033' });
  assert.equal(out.length, 0);
  // Outra obra não herda o executável.
  const other = dropFakeReleases([{ title: TWIN, infoHash: twin, indexer: 'limetorrents' }] as any, { imdbId: 'tt0000001' });
  assert.equal(other.length, 1);
});

test('corte: sem executável nenhum o lote passa intacto', () => {
  const raw = [{ title: 'Filme 2024 1080p WEB-DL', infoHash: hex('8'), indexer: 'x' }];
  assert.equal(dropFakeReleases(raw as any, { imdbId: 'tt1' }), raw);
});
