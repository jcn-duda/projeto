// Continuação nomeada por SUBTÍTULO recebia o filme 1 (medido 2026-09-28):
// na lista de "Resident Evil: Apocalypse" (2004), 6 das 7 releases eram do
// "Resident Evil" de 2002 — cobertura 2/3 e ano dentro do ±2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevantRaw } from '../src/utils/format.js';

const APOCALYPSE = { names: ['Resident Evil: Apocalypse', 'Resident Evil 2: Apocalipse'], year: 2004, isSeries: false };

test('o filme 1 da franquia não entra na continuação pedida por subtítulo', () => {
  for (const title of [
    'Resident Evil (2002) 2160p BRRip 5.1 10Bit x265 -YTS',
    'Resident Evil (2002) 1080p BrRip x264 -YIFY',
    'Resident Evil (2002) (1080p BluRay x265 HEVC 10bit AAC 5 1 Tigole) [QxR]',
    'Resident.Evil.2002.720p.BluRay.999MB.x265.10bit-GalaxyRG',
  ]) {
    assert.equal(filterRelevantRaw([{ title }], APOCALYPSE).length, 0, title);
  }
});

test('a continuação certa continua entrando', () => {
  for (const title of [
    'Resident Evil Apocalypse (2004) 1080p BrRip x264 -YIFY',
    'Resident.Evil.Apocalypse.2004.2160p.UHD.BluRay.x265-TERMiNAL',
    'Resident Evil Apocalypse 1080p BluRay',
    'Resident Evil 2: Apocalipse (2004) [1080p DUAL 1.39 GB]',
  ]) {
    assert.equal(filterRelevantRaw([{ title }], APOCALYPSE).length, 1, title);
  }
});

test('um nome alternativo completo salva a release (a regra é por nome)', () => {
  // "Cidade de Deus 2002" não tem o nome inglês, mas é o original inteiro.
  const ctx = { names: ['City of God', 'Cidade de Deus'], year: 2003, isSeries: false };
  assert.equal(filterRelevantRaw([{ title: 'Cidade de Deus 2002 1080p BluRay' }], ctx).length, 1);
});
