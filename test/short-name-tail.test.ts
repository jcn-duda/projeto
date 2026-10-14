// Monster (2018), 2026-10-04: Cinemeta 2018 (Sundance), TMDB 2021 (Netflix).
// O global publica "Monster (2018)" e o BR "Monstro (2021)"; com um ano só,
// um dos lados sumia. E com o ano 2021, "Monster Hunter 2021" e afins passavam
// porque o nome de um token só é checado pelo prefixo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterRelevantRaw } from '../src/utils/release-filters.js';
import { catalogYearOf, catalogAltYearOf } from '../src/utils/catalog-year.js';
import type { RawItem } from '../types/domain.js';

const keep = (titles: Array<[string, boolean?]>, ctx: Record<string, unknown>) => {
  const items = titles.map(([title, isBr]) => ({ title, isBr: !!isBr }) as RawItem);
  const kept = new Set(filterRelevantRaw(items, ctx));
  return items.filter((i) => kept.has(i)).map((i) => i.title);
};

test('ano de catálogo: o descartado vira altYear só quando diverge mais de 2', () => {
  assert.equal(catalogYearOf(2018, 2021), 2021);
  assert.equal(catalogAltYearOf(2018, 2021), 2018);
  assert.equal(catalogAltYearOf(1967, 1964), 1967);
  assert.equal(catalogAltYearOf(2019, 2020), null);
  assert.equal(catalogAltYearOf(2019, null), null);
});

test('Monster: os dois anos valem e outra obra com o mesmo nome curto sai', () => {
  const kept = keep([
    ['Monster.Hunter.2021.1080p.WEB-DL.DD5.1.H264-EVO[TGx]'],
    ['Monster Hospital 2021 4K 2160p WEB DL'],
    ['Monster Pets A Hotel Transylvania Short (2021) 1080p WEBRip 5.1 x264 -YTS'],
    ['Monster (2018) (1080p) [WEBRip] [5 1] [YTS MX]'],
    ['Monster.2018.1080p.NF.WEB-DL.DDP5.1.x264-NTG'],
    ['Monstro (2021) [1080p WEB-DL DUBLADO 3.9 GB]', true],
    ['Monstro - Monster [1080p WEB-DL DUAL]', true],
  ], { names: ['Monster', 'Monstro'], year: 2021, altYear: 2018 });
  assert.deepEqual(kept, [
    'Monster (2018) (1080p) [WEBRip] [5 1] [YTS MX]',
    'Monster.2018.1080p.NF.WEB-DL.DDP5.1.x264-NTG',
    'Monstro (2021) [1080p WEB-DL DUBLADO 3.9 GB]',
    'Monstro - Monster [1080p WEB-DL DUAL]',
  ]);
});

test('nome curto: rótulo, edição depois do ano e outro nome da obra continuam passando', () => {
  assert.deepEqual(keep([
    ['Alien.1979.Directors.Cut.1080p.BluRay.x264'],
    ['Alien (1979) [Director\'s Cut] 1080p BrRip -YTS'],
  ], { names: ['Alien'], year: 1979 }).length, 2);
  assert.deepEqual(keep([
    ['Coringa - Joker 2019 1080p WEB-DL DUAL'],
    ['Joker.2019.1080p.WEBRip.x264'],
    ['Joker.Folie.a.Deux.2024.1080p.WEB-DL'],
  ], { names: ['Joker', 'Coringa'], year: 2019 }), ['Coringa - Joker 2019 1080p WEB-DL DUAL', 'Joker.2019.1080p.WEBRip.x264']);
  // Sem ano no título, o nome curto não é julgado por esta régua.
  assert.equal(keep([['Monster 1080p WEB-DL']], { names: ['Monster'], year: 2018 }).length, 1);
});

test('sem altYear nada muda no ano único', () => {
  assert.deepEqual(keep([
    ['Monster (2018) (1080p) [WEBRip] [5 1] [YTS MX]'],
  ], { names: ['Monster'], year: 2021 }), []);
});
