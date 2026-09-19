// Letras latinas que NÃO se decompõem no NFD (ı turco sem ponto, ł, đ, ø, ß,
// æ, œ) viram ASCII na normalização de título.
//
// Medido em My Name Is Farah S01E01 (2026-09-13): o título original "Adım
// Farah" tem o ı sem ponto, que é letra própria e não "i" com acento. As
// releases escrevem "Adim Farah", `normalizeTitle` devolvia "adım farah" contra
// "adim farah", e o filtro de título recusava todas. A lista do episódio saía
// só com o aviso.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTitle, stripDiacritics, filterRelevantRaw } from '../src/utils/format.js';
import type { RawItem } from '../types/domain.js';

test('normalizeTitle dobra letras latinas sem decomposição para ASCII', () => {
  assert.equal(normalizeTitle('Adım Farah'), normalizeTitle('Adim Farah'));
  assert.equal(normalizeTitle('Kızılcık Şerbeti'), 'kizilcik serbeti');
  assert.equal(normalizeTitle('Łódź'), 'lodz');
  assert.equal(normalizeTitle('Øresund'), 'oresund');
  assert.equal(normalizeTitle('Straße'), 'strasse');
  assert.equal(normalizeTitle('Æon Flux'), 'aeon flux');
  assert.equal(normalizeTitle('Œuvre'), 'oeuvre');
  assert.equal(normalizeTitle('Đorđe'), 'dorde');
});

test('stripDiacritics dobra as mesmas letras preservando a caixa', () => {
  assert.equal(stripDiacritics('Adım Farah'), 'Adim Farah');
  assert.equal(stripDiacritics('ŁÓDŹ'), 'LODZ');
  assert.equal(stripDiacritics('Øresund'), 'Oresund');
  assert.equal(stripDiacritics('Meu Nome é Farah'), 'Meu Nome e Farah');
});

test('release com o título original em ASCII passa no filtro de título', () => {
  const items = [
    { title: 'Adim.Farah.S01E01.720p.HDTV.Subtitulado.Esp.SC.mp4', infoHash: 'e'.repeat(40), seeders: 3 },
    { title: 'Adım Farah (Меня зовут Фарах) Сезон 1 (DVO DiziMania) WEB-DL 1080p', infoHash: 'd'.repeat(40), seeders: 1 },
  ] as RawItem[];
  const rejected: string[] = [];
  const kept = filterRelevantRaw(
    items,
    { names: ['My Name Is Farah', 'Adım Farah'], year: 2023, isSeries: true, season: 1, episode: 1 },
    (item, reason) => rejected.push(`${String(item.title).slice(0, 30)}:${reason}`),
  );
  assert.ok(
    kept.some((item) => String(item.title).startsWith('Adim.Farah.S01E01')),
    `a release em ASCII do episódio pedido fica (recusados: ${rejected.join(' | ')})`,
  );
  assert.equal(rejected.filter((r) => r.endsWith(':title')).length, 0, `nenhuma recusa por título (recusados: ${rejected.join(' | ')})`);
});
