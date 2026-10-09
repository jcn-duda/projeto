// The Odyssey (Nolan, tt33764258), 2026-10-05: em cartaz desde 15/07, digital
// só em 15/11 no TMDB. A lista mostrava trailers como 4K e WEB-DL/WEBRip que
// eram o OUTRO "The Odyssey (2026)" (tt41605854, Tubi).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import { filterRelevantRaw } from '../src/utils/release-filters.js';
import { earliestHomeRelease } from '../src/utils/tmdb-home-release.js';
import type { RawItem } from '../types/domain.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const DIGITAL = Date.parse('2026-11-15T00:00:00Z');
const titles = [
  'The Odyssey (2026) Trailer 3 4k UHD Lossless',
  'The Odyssey (2026) Official Teaser Trailer 4K',
  'The Odyssey (2026) [1080p] [WEBRip] [5.1]',
  'The Odyssey 2026 1080p AMZN WEB DL DDP5 1 H 264 Kitsune',
  'The Odyssey 2026 1080p WEB H264 EDITH',
  'The.Odyssey.2026.720p.TUBI.WEB-DL.AAC2.0-NOtLAN (NOT The Chris Nolan FILM)',
  'Ludwig Goransson The Odyssey (Original Motion Picture Soundtrack) OST 16BIT WEB FLAC',
  'The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE',
  'The-Odyssey-2026-1080p-TS-V2-WEB.DL-GP-M-NLsubs',
  'A Odisseia (2026) [1080p CAM DUBLADO]',
];
const keep = (homeReleaseAt: number | null) => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const items = titles.map((title) => ({ title, isBr: /Odisseia/.test(title) }) as RawItem);
    const kept = new Set(filterRelevantRaw(items, { names: ['The Odyssey', 'A Odisseia'], year: 2026, homeReleaseAt }));
    return items.filter((i) => kept.has(i)).map((i) => i.title);
  } finally {
    Date.now = realNow;
  }
};

test('antes do digital: só gravação de cinema fica; trailer e trilha saem sempre', () => {
  assert.deepEqual(keep(DIGITAL), [
    'The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE',
    'The-Odyssey-2026-1080p-TS-V2-WEB.DL-GP-M-NLsubs',
    'A Odisseia (2026) [1080p CAM DUBLADO]',
  ]);
});

test('sem data doméstica (ou já lançado) as WEB voltam; trailer continua fora', () => {
  for (const at of [null, Date.parse('2026-09-01T00:00:00Z')]) {
    const kept = keep(at);
    assert.ok(kept.includes('The Odyssey 2026 1080p AMZN WEB DL DDP5 1 H 264 Kitsune'));
    assert.ok(!kept.some((t) => /Trailer|Soundtrack/.test(String(t))));
  }
  // Dentro da margem (vazamento de véspera) também não corta.
  assert.ok(keep(NOW + 3600 * 1000).includes('The Odyssey 2026 1080p WEB H264 EDITH'));
});

test('nome da obra com a palavra não condena ("Trailer Park Boys")', () => {
  const items = [{ title: 'Trailer Park Boys The Movie 2006 1080p WEB-DL' }] as RawItem[];
  assert.equal(filterRelevantRaw(items, { names: ['Trailer Park Boys: The Movie'], year: 2006 }).length, 1);
});

test('kill-switch SEARCH_PRE_HOME_RELEASE_CUT=false', () => {
  const s = config.search as { preHomeReleaseCut: boolean };
  const before = s.preHomeReleaseCut;
  s.preHomeReleaseCut = false;
  try {
    assert.ok(keep(DIGITAL).includes('The Odyssey 2026 1080p WEB H264 EDITH'));
  } finally {
    s.preHomeReleaseCut = before;
  }
});

test('TMDB: menor data entre digital, físico e TV de todos os países', () => {
  const at = earliestHomeRelease({ results: [
    { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-07-17T00:00:00.000Z' }, { type: 5, release_date: '2026-11-17T00:00:00.000Z' }] },
    { iso_3166_1: 'FR', release_dates: [{ type: 4, release_date: '2026-11-15T00:00:00.000Z' }] },
  ] });
  assert.equal(at, DIGITAL);
  assert.equal(earliestHomeRelease({ results: [{ release_dates: [{ type: 3, release_date: '2026-07-17' }] }] }), null);
});
