// "S01 EP 07" das releases indianas e o episódio que ainda não foi ao ar —
// os dois furos medidos em Lanterns S01E08 (2026-09-30): a lista vinha com 6
// streams ⚡ e nenhum tocava.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseTitleSeasonEpisode, matchesEpisode } from '../src/utils/format.js';
import { filterSeriesEpisodeRaw } from '../src/providers/stream-builder-episode-filter.js';
import type { RawItem } from '../types/domain.js';

test('"S01 EP 07" é o episódio 7, não o pack da temporada', () => {
  const t = 'Lanterns (2026) S01 EP 07 TRUE WEB-DL - 1080p - AVC - UNTOUCHED - [Tamil + Telugu + Hindi + Eng]';
  assert.deepEqual(parseTitleSeasonEpisode(t).episodes, [7]);
  assert.equal(matchesEpisode(t, { season: 1, episode: 8 }), false);
  assert.equal(matchesEpisode(t, { season: 1, episode: 7 }), true);
  assert.deepEqual(parseTitleSeasonEpisode('Show S01 EP (01-07) WEB-DL').episodes, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(parseTitleSeasonEpisode('Show.S02.EP.03.1080p').episodes, [3]);
  // "EP" sem número e palavra começando com "ep" não viram episódio.
  assert.deepEqual(parseTitleSeasonEpisode('Show S01 1080p EP').episodes, []);
  assert.deepEqual(parseTitleSeasonEpisode('Show S01 epic 720p').episodes, []);
});

test('episódio que ainda não foi ao ar: sai o pack, fica quem nomeia o episódio', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const items = [
    { title: 'Lanterns.S01.2160p.AMZN.WEB-DL.DV.HDR' },
    { title: 'Lanterns 2026 S01E08 1080p HD H264 CAKES' },
  ] as RawItem[];
  const futuro = filterSeriesEpisodeRaw(items, 1, 8, ['lanterns'], { airDate: '2026-10-05T05:00:00.000Z', now });
  assert.deepEqual(futuro.kept.map((r) => r.title), ['Lanterns 2026 S01E08 1080p HD H264 CAKES']);
  // Já no ar (ou dentro das 24h de margem): o pack volta a valer.
  const noAr = filterSeriesEpisodeRaw(items, 1, 8, ['lanterns'], { airDate: '2026-09-30T20:00:00.000Z', now });
  assert.equal(noAr.kept.length, 2);
  // Sem data do Cinemeta: nada muda.
  assert.equal(filterSeriesEpisodeRaw(items, 1, 8, ['lanterns'], { now }).kept.length, 2);
});

test('ordinal por extenso: "Primeira Temporada" é a temporada 1', () => {
  // Conta AllDebrid (2026-09-30): entrava no S07E07 de Game of Thrones.
  const t = 'Game of Thrones Primeira Temporada Dual Audio Pt_Br (Dublado)';
  assert.deepEqual(parseTitleSeasonEpisode(t).seasons, [1]);
  assert.equal(matchesEpisode(t, { season: 7, episode: 7 }), false);
  assert.deepEqual(parseTitleSeasonEpisode('Série Sétima Temporada Completa').seasons, [7]);
  assert.deepEqual(parseTitleSeasonEpisode('Série Décima Primeira Temporada').seasons, [11]);
  assert.deepEqual(parseTitleSeasonEpisode('A Primeira Noite de Crime 2018').seasons, []);
});

test('artigo que não é do nome: "A Origem" (Inception) sai de From ("Origem")', () => {
  const names = ['From', 'Origem'];
  const items = [
    { title: 'A Origem 4k 2160p Dual Audio WWW.BLUDV.TV', fromAccount: true },
    { title: 'Origem S01 2022 WEB-DL 1080p x264 DUAL 2.0', fromAccount: true },
    { title: 'A Origem 1ª Temporada [1080p DUBLADO]', isBr: true },
  ] as RawItem[];
  const out = filterSeriesEpisodeRaw(items, 1, 2, ['from', 'origem'], { names });
  assert.deepEqual(out.kept.map((r) => r.title), ['Origem S01 2022 WEB-DL 1080p x264 DUAL 2.0', 'A Origem 1ª Temporada [1080p DUBLADO]']);
  // O artigo que o nome tem passa: "O Urso" é The Bear.
  const urso = filterSeriesEpisodeRaw([{ title: 'O Urso 1080p DUAL', isBr: true }] as RawItem[], 1, 1, ['the', 'bear', 'urso'], { names: ['The Bear', 'O Urso'] });
  assert.equal(urso.kept.length, 1);
});
