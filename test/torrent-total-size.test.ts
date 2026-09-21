// Tamanho TOTAL do torrent vindo do Premiumize (`tsz`) como 💾 de quem o
// tracker deixou sem tamanho.
//
// Motivo medido (True Detective S01E01, 2026-09-20): duas releases 1080p da
// TheRARBG saíam sem chip — uma sem tamanho no tracker, outra com o tamanho do
// .torrent ("65.95 KB"). O `/cache/check` do Premiumize devolve `filesize` por
// hash (617.8 MB e 4.22 GB) e o adapter jogava fora. No pack de 8 episódios o
// mesmo campo veio 12.41 GB — é o torrent inteiro, não o episódio.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as premiumize from '../src/debrid/premiumize.js';
import { annotateEpisodeSizes } from '../src/providers/episode-size.js';
import { recordTorrentTotal, peekTorrentTotal, clearFileSizes } from '../src/debrid/file-sizes.js';
import { stubFetch } from './helpers/stub.js';
import type { Stream } from '../types/domain.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CACHED = 'aa'.repeat(20);
const UNCACHED = 'bb'.repeat(20);
const SEM_SIZE = 'cc'.repeat(20);
const PACK = 'dd'.repeat(20);

const stream = (infoHash: string, title: string) => ({ name: '[PM⚡] 1080p', title, infoHash }) as Stream;
const titleOf = (s: Stream | null | undefined) => String(s?.title || '');

test('checkCached do Premiumize grava o filesize só dos cacheados', async () => {
  clearFileSizes();
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', response: [true, false], filesize: ['647765771', 0] }),
  }));
  try {
    const cached = await premiumize.checkCached('KEY', [CACHED, UNCACHED]);
    assert.deepEqual([...cached.cached], [CACHED]);
    assert.equal(peekTorrentTotal(CACHED), 647765771);
    assert.equal(peekTorrentTotal(UNCACHED), 0, 'não-cacheado não grava tamanho');
  } finally {
    stub.restore();
  }
});

test('release sem tamanho no tracker ganha o 💾 do total do serviço', () => {
  clearFileSizes();
  recordTorrentTotal(SEM_SIZE, Math.round(4.22 * GB));
  const [out] = annotateEpisodeSizes(
    [stream(SEM_SIZE, 'True Detective S01E01 The Long Bright Dark 1080p AMZN WEB-DL\n👤 65 ⚙️ TheRARBG')],
    { season: 1, episode: 1, meta: { episodes: { 1: 8 } } },
  );
  assert.match(titleOf(out), /👤 65 💾 4\.22 GB/);
});

test('💾 em KB (tamanho do .torrent) é trocado pelo total do serviço', () => {
  clearFileSizes();
  recordTorrentTotal(CACHED, 647765771);
  const [out] = annotateEpisodeSizes(
    [stream(CACHED, 'True.Detective.S01E01.The.Long.Bright.Dark.1080p.HEVC.x265-MeGusta\n👤 87 💾 65.95 KB ⚙️ TheRARBG')],
    { season: 1, episode: 1, meta: { episodes: { 1: 8 } } },
  );
  assert.match(titleOf(out), /💾 617\.76 MB/);
  assert.doesNotMatch(titleOf(out), /KB/);
});

test('pack sem tamanho no tracker: o total vira média do episódio, nunca o chip da temporada', () => {
  clearFileSizes();
  recordTorrentTotal(PACK, Math.round(12.41 * GB));
  const [out] = annotateEpisodeSizes(
    [stream(PACK, 'True.Detective.2014.S01.1080p.BDRip.x265-ToVaR\n👤 1 ⚙️ nerdfilmes')],
    { season: 1, episode: 1, meta: { episodes: { 1: 8 } } },
  );
  assert.match(titleOf(out), /💾 1\.55 GB 📦 pack 12\.41 GB \(média\)/);
});

test('pack cujo episódio não dá para medir fica sem 💾 em vez de exibir o total', () => {
  clearFileSizes();
  recordTorrentTotal(PACK, Math.round(12.41 * GB));
  const original = stream(PACK, 'True.Detective.2014.S01.1080p.BDRip.x265-ToVaR\n👤 1 ⚙️ nerdfilmes');
  const [out] = annotateEpisodeSizes([original], { season: 1, episode: 1, meta: null });
  assert.doesNotMatch(titleOf(out), /💾/);
});

test('💾 real do tracker não é tocado pelo total do serviço', () => {
  clearFileSizes();
  recordTorrentTotal(CACHED, 900 * MB);
  const [out] = annotateEpisodeSizes(
    [stream(CACHED, 'True Detective S01E01 720p AMZN WEB DL\n👤 27 💾 1.86 GB ⚙️ LimeTorrents')],
    { season: 1, episode: 1, meta: { episodes: { 1: 8 } } },
  );
  assert.match(titleOf(out), /💾 1\.86 GB/);
  assert.doesNotMatch(titleOf(out), /900/);
});
