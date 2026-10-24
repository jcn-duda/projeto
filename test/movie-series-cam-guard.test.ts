// Resident Evil (2026): série, pack fora do intervalo e gravações de cinema.
//
// Regressões reais medidas em produção (dda4189, cache streams:v11):
// - ApacheTorrent: "Resident Evil - A Série - 1ª Temporada [1080p WEBRIP LEGENDADO]"
//   com dn S01 entrou na lista do filme porque o título não tem ano.
// - therarbg: "Resident Evil Collection 2002 2016 Extras 4k UHD" (2 anos, regra
//   antiga pulava a checagem).
// - Kickass: "HQ PreDVD" e "D.TS.1080p" (sourceFromTitle não reconhecia TS/PreDVD).
// - NerdFilmes: título limpo, mas dn "Resident.Evil.2026.1080p.TELESYNC…"
//   (notCam só olhava s.title).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevantRaw as relevantRaw } from '../src/utils/format.js';
import { sourceFromTitle } from '../src/utils/audio-quality.js';
import { yearContradicts } from '../src/utils/matching-tokens.js';
import { magnetYearContradicts } from '../src/utils/release-filters.js';
import { titleTokens } from '../src/utils/matching-vocabulary.js';
import { collectInstantItems } from '../src/providers/magnet-bank-instant.js';
import * as bank from '../src/utils/magnet-bank.js';
import config from '../src/config.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as releaseIndex from '../src/utils/release-index.js';
import debrid from '../src/debrid/index.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import * as metrics from '../src/utils/metrics.js';
import { patch } from './helpers/stub.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const HASH2 = 'c'.repeat(40);
const HASH3 = 'd'.repeat(40);
const HASH4 = 'e'.repeat(40);
const magnet = (h: string, dn: string) => `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(dn)}`;

// ─── 1. Filme rejeita release de série ────────────────────────────────────────

test('filme Resident Evil (2026): rejeita posts "A Série S01" (título + dn)', () => {
  const ctx = { names: ['Resident Evil'], year: 2026, isSeries: false, season: null, episode: null };
  const items = [
    {
      title: 'Resident Evil - A Série - 1ª Temporada [1080p WEBRIP LEGENDADO]',
      magnet: magnet(HASH, 'Resident.Evil.S01.1080p.NF.WEBRip'),
    },
    {
      title: 'Resident Evil - A Série - 1ª Temporada [720p WEBRIP LEGENDADO]',
      magnet: magnet(OTHER, 'Resident.Evil.S01.720p.NF.WEBRip'),
    },
  ];
  const rejected: Array<{ title: string; reason: string }> = [];
  const result = relevantRaw(items, ctx, (_item, reason) => {
    rejected.push({ title: items[0]?.title || '', reason });
  });
  assert.equal(result.length, 0, 'nenhum item de série passa no filme');
});

test('filme Resident Evil (2026): rejeita "Collection 2002 2016" (pack fora do intervalo)', () => {
  const ctx = { names: ['Resident Evil'], year: 2026, isSeries: false, season: null, episode: null };
  const item = {
    title: 'Resident Evil Collection 2002 2016 Extras 4k UHD',
    magnet: magnet(HASH, 'Resident.Evil.Collection.2002.2016.Extras.4k'),
  };
  const result = relevantRaw([item], ctx);
  assert.equal(result.length, 0, 'pack 2002-2016 não cabe no catálogo 2026');
});

test('filme Resident Evil (2026): aceita WEB-DL legítimo', () => {
  const ctx = { names: ['Resident Evil'], year: 2026, isSeries: false, season: null, episode: null };
  const item = {
    title: 'Resident Evil (2026) 1080p AMZN WEB-DL DDP5 1 H 264-FLUX',
    magnet: magnet(HASH, 'Resident.Evil.2026.1080p.AMZN.WEB-DL'),
  };
  const result = relevantRaw([item], ctx);
  assert.equal(result.length, 1, 'WEB-DL legítimo passa');
});

test('filme: resolução no magnet NÃO vira temporada (1280x720, 3840x2160)', () => {
  // "Inception.2010.1280x720.BluRay" → parser lia "80x720" como T80 E720.
  // "3840x2160" → parser lia "40x2160" como T40 E2160.
  const ctx = { names: ['Inception'], year: 2010, isSeries: false, season: null, episode: null };
  const items = [
    { title: 'Inception', magnet: magnet(HASH, 'Inception.2010.1280x720.BluRay.x264') },
    { title: 'Inception', magnet: magnet(OTHER, 'Inception.2010.3840x2160.BluRay.x264') },
    { title: 'Inception', magnet: magnet(HASH2, 'Inception.2010.1920x1080.BluRay.x264') },
  ];
  const result = relevantRaw(items, ctx);
  assert.equal(result.length, 3, 'resoluções no magnet não rejeitam filme');
});

test('filme: "A Series of Unfortunate Events" NÃO é rejeitado como série', () => {
  // "series" solto no título não deve ativar o filtro. O rótulo "a série",
  // "the série" e "minissérie" continuam ativos.
  const ctx = { names: ['A Series of Unfortunate Events'], year: 2004, isSeries: false, season: null, episode: null };
  const item = { title: 'A Series of Unfortunate Events (2004) 1080p BluRay' };
  const result = relevantRaw([item], ctx);
  assert.equal(result.length, 1, 'filme com "Series" no nome passa');
});

test('filme: "Series 7: The Contenders" NÃO é rejeitado como série', () => {
  const ctx = { names: ['Series 7: The Contenders'], year: 2001, isSeries: false, season: null, episode: null };
  const item = { title: 'Series 7 The Contenders (2001) 720p BluRay' };
  const result = relevantRaw([item], ctx);
  assert.equal(result.length, 1, 'filme com "Series" no nome passa');
});

// ─── 2. Regressões do intervalo de anos ───────────────────────────────────────

test('yearContradicts: Blade Runner 2049 (2017) com catálogo 2017 passa', () => {
  const tokens = titleTokens('Blade Runner 2049 2017 1080p BluRay');
  assert.equal(yearContradicts(tokens, 2017, false), false);
});

test('yearContradicts: Collection 2002-2016 com catálogo 2004 passa', () => {
  const tokens = titleTokens('Resident Evil Collection 2002 2016 1080p');
  assert.equal(yearContradicts(tokens, 2004, false), false);
});

test('yearContradicts: Collection 2002-2016 com catálogo 2026 morre', () => {
  const tokens = titleTokens('Resident Evil Collection 2002 2016 1080p');
  assert.equal(yearContradicts(tokens, 2026, false), true);
});

test('yearContradicts: S1m0ne (2002) com nome "S1m0ne" passa (exceção do marcador)', () => {
  // O parser lê S1 em "S1m0ne" como temporada 1; a exceção do nome procurado
  // com o mesmo marcador protege o filme legítimo.
  const ctx = { names: ['S1m0ne'], year: 2002, isSeries: false, season: null, episode: null };
  const item = { title: 'S1m0ne (2002) 1080p BluRay' };
  const result = relevantRaw([item], ctx);
  assert.equal(result.length, 1, 'filme S1m0ne passa apesar do S1 no nome');
});

test('magnetYearContradicts: multi-year com catálogo fora do intervalo', () => {
  const item = {
    title: 'Collection',
    magnet: magnet(HASH, 'Collection.2002.2016.4k'),
  };
  assert.equal(magnetYearContradicts(item, 2026), true, 'catálogo 2026 fora de [2002,2016]');
  assert.equal(magnetYearContradicts(item, 2004), false, 'catálogo 2004 dentro de [2002,2016]');
});

// ─── 3. sourceFromTitle: gravações de cinema ──────────────────────────────────

test('sourceFromTitle: devolve CAM para HQ PreDVD, D.TS.1080p, TELESYNC, HDTS, HDTC', () => {
  assert.equal(sourceFromTitle('Resident Evil (2026) HQ PreDVD 1080p'), 'CAM');
  assert.equal(sourceFromTitle('Resident.Evil.2026.D.TS.1080p'), 'CAM');
  assert.equal(sourceFromTitle('Resident.Evil.2026.1080p.TELESYNC'), 'CAM');
  assert.equal(sourceFromTitle('Resident.Evil.2026.HDTS.1080p'), 'CAM');
  assert.equal(sourceFromTitle('Resident.Evil.2026.HDTC.1080p'), 'CAM');
  assert.equal(sourceFromTitle('Resident.Evil.2026.TC.1080p'), 'CAM');
  assert.equal(sourceFromTitle('Resident.Evil.2026.TELECINE'), 'CAM');
});

test('sourceFromTitle: NÃO devolve CAM para DDP5.1, WEB-DL, BluRay', () => {
  assert.notEqual(sourceFromTitle('Movie 2026 DDP5.1 1080p'), 'CAM');
  assert.notEqual(sourceFromTitle('Movie 2026 WEB-DL 1080p'), 'CAM');
  assert.notEqual(sourceFromTitle('Movie 2026 BluRay 1080p'), 'CAM');
  assert.notEqual(sourceFromTitle('Movie 2026 HDTV 1080p'), 'CAM');
});

test('sourceFromTitle: extensão .ts NÃO é gravação de cinema', () => {
  // .ts é extensão de arquivo, não TELESYNC. O \bTS\b casa com ".ts" porque
  // "." conta como fronteira de palavra.
  assert.notEqual(sourceFromTitle('Filme.2019.1080p.H264.ts'), 'CAM');
  assert.notEqual(sourceFromTitle('Movie.2020.720p.x264.ts'), 'CAM');
  // Mas TELESYNC no meio continua CAM
  assert.equal(sourceFromTitle('Resident.Evil.2026.TELESYNC.ts'), 'CAM');
});

// ─── 4. notCam: dn revela TELESYNC escondido no título ────────────────────────

test('notCam: corta item cujo título é limpo mas dn diz TELESYNC', () => {
  // Simula o ranking: sourceFromTitle no título não acha CAM, mas no dn acha.
  const title = 'Resident Evil (2026) [1080p LEGENDADO 6.95 GB]';
  const dn = 'Resident.Evil.2026.1080p.TELESYNC.x264';
  assert.equal(sourceFromTitle(title), '', 'título limpo não revela CAM');
  assert.equal(sourceFromTitle(dn), 'CAM', 'dn revela TELESYNC');
});

// ─── 5. Banco instantâneo: série gravada para filme não sai ───────────────────

const DAY_MS = 86400000;
const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inst-red-'));
const hex = (c: string) => c.repeat(40);
const magnetUri = (h: string) => `magnet:?xt=urn:btih:${h}`;

const tempDirs: string[] = [];
const saved = {
  releaseIndex: config.releaseIndex.enabled,
  instantEnabled: config.magnetBank.instantEnabled,
  fallbackMaxPerIndexer: config.magnetBank.fallbackMaxPerIndexer,
  fallbackGlobalMax: config.magnetBank.fallbackGlobalMax,
};

function seedInstant(hash: string, indexer: string, ctx: any, opts: { title?: string; uri?: string } = {}) {
  const title = opts.title ?? 'Filme Teste 2024 1080p Dublado';
  const uri = opts.uri ?? magnetUri(hash);
  bank.captureItems([{ title, infoHash: hash, magnet: uri, seeders: 5, isBr: true }], indexer, ctx);
  bank.markFilterResult([hash], [hash], ctx);
  bank.flushNow();
}

test('banco instantâneo: série gravada para filme não sai na resposta', () => {
  const dir = FRESH_DIR();
  tempDirs.push(dir);
  bank.open(dir);
  config.releaseIndex.enabled = false;
  config.magnetBank.instantEnabled = true;

  const imdbId = 'tt35538033';
  const ctx = { imdbId, season: null, episode: null, type: 'movie' };
  // Grava série (S01) como passed_filter=1 para o filme
  const seriesHash = hex('f');
  seedInstant(seriesHash, 'apachetorrent', ctx, {
    title: 'Resident Evil - A Série - 1ª Temporada [1080p WEBRIP LEGENDADO]',
    uri: magnet(seriesHash, 'Resident.Evil.S01.1080p.NF.WEBRip'),
  });

  const result = collectInstantItems({
    type: 'movie',
    imdbId,
    season: null,
    episode: null,
    names: ['Resident Evil'],
    year: 2026,
    isSeries: false,
    preferDubbed: false,
    now: Date.now(),
  });

  // A série deve ser filtrada pelo reaplicação do filtro
  const seriesItems = result.items.filter((i: any) =>
    String(i.title || '').includes('Série'),
  );
  assert.equal(seriesItems.length, 0, 'série S01 não sai na resposta do filme');

  // Restore
  bank.resetForTests();
  bank.close();
  config.releaseIndex.enabled = saved.releaseIndex;
  config.magnetBank.instantEnabled = saved.instantEnabled;
});

// Cleanup
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
