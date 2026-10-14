// Pack "Completo" sem temporada no `dn=` numa página que agrega a série (HDR):
// o adaptador o entrega em `unlocated`, e o motor só o grava como temporada 1
// quando a obra identificada tem UMA temporada no TMDB. Medido na VPS em
// 2026-10-06: 17 de 20 séries em erro eram "Hellsing (Dublado) Completo",
// "DESENHO - PUCCA DUBLADO" etc., descartadas por não declarar temporada.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
const { seriesRowGroups, unlocatedReleases } = await import('../src/providers/crawl-sites/season-page.js');
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow, CrawlWorkResult } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: false, sites: ['fake'], delayMs: 0,
    maxPerHour: 1000, idleWindowMs: 0, maxTries: 2, layoutCanary: 10,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

function release(seed: string, dn: string): RawItem {
  const hash = seed.repeat(40).slice(0, 40);
  return {
    title: 'Pucca [TVRip DUBLADO]', magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1,
  };
}

function seriesSite(result: Partial<CrawlWorkResult>): CrawlSite {
  return {
    id: 'fake',
    label: 'Fake',
    discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string) => ({
      url, status: 'done', type: 'series', title: 'Pucca', year: 2006, imdb: 'tt0800000', groups: [], ...result,
    }),
  };
}

function takeRow(): CrawlUrlRow {
  store.engine().upsertUrls('fake', [{ url: '/pucca', lastmod: '2026-01-01', kind: 'movie' }], 1);
  return store.engine().takeNext('fake', 10) as CrawlUrlRow;
}

type Recorded = Array<{ season: number | null; episode: number | null; n: number }>;
function recorder(calls: Recorded) {
  return async (_site: string, _obra: unknown, items: RawItem[], loc: { season: number | null; episode: number | null }) => {
    calls.push({ season: loc.season, episode: loc.episode, n: items.length });
    return { kept: items.length, added: items.length, transition: 'none' as const, cleared: 0 };
  };
}

describe('unlocatedReleases', () => {
  test('separa o pack sem temporada das linhas que o seriesRowGroups locou', () => {
    const s1 = release('a', 'Go Diego Go Temporada 1 Completo Pt-Br');
    const complete = release('b', 'DESENHO - PUCCA DUBLADO');
    const groups = seriesRowGroups([s1, complete].map((r) => ({ release: r, rowSeason: null })));
    assert.equal(groups.length, 1);
    assert.deepStrictEqual(unlocatedReleases([s1, complete], groups), [complete]);
  });
});

describe('crawl-page: pack sem temporada (unlocated)', () => {
  const pack = release('c', 'DESENHO - PUCCA DUBLADO');

  test('série de UMA temporada no TMDB: grava como temporada 1', async () => {
    const calls: Recorded = [];
    const process = createPageProcessor({
      record: recorder(calls),
      seasonCount: async () => ({ ok: true, seasons: 1 }),
    });
    const outcome = await process(seriesSite({ unlocated: [pack] }), takeRow());
    assert.equal(outcome.kind, 'done');
    assert.deepStrictEqual(calls, [{ season: 1, episode: null, n: 1 }]);
    assert.equal(store.engine().getUrl('fake', '/pucca')?.status, 'done');
  });

  test('série com várias temporadas: o pack fica fora e a página é no-torrent', async () => {
    const calls: Recorded = [];
    const process = createPageProcessor({
      record: recorder(calls),
      seasonCount: async () => ({ ok: true, seasons: 3 }),
    });
    const outcome = await process(seriesSite({ unlocated: [pack] }), takeRow());
    assert.equal(outcome.kind, 'no-torrent');
    assert.equal(calls.length, 0, 'nada gravado na raiz nem em temporada inventada');
    assert.equal(store.engine().getUrl('fake', '/pucca')?.status, 'no-torrent');
  });

  test('grupos locados seguem gravados; o pack só entra com uma temporada', async () => {
    const s1 = release('d', 'Pucca Temporada 1 Pt-Br');
    const groups = seriesRowGroups([{ release: s1, rowSeason: null }]);
    const calls: Recorded = [];
    const process = createPageProcessor({
      record: recorder(calls),
      seasonCount: async () => ({ ok: true, seasons: 2 }),
    });
    const outcome = await process(seriesSite({ groups, unlocated: [pack] }), takeRow());
    assert.equal(outcome.kind, 'done');
    assert.deepStrictEqual(calls.map((c) => c.season), [1]);
    assert.equal(calls[0].n, 1, 'só a linha que declara temporada');
  });

  test('TMDB indisponível: erro retentável, nada gravado', async () => {
    const calls: Recorded = [];
    const process = createPageProcessor({
      record: recorder(calls),
      seasonCount: async () => ({ ok: false, seasons: null }),
    });
    const outcome = await process(seriesSite({ unlocated: [pack] }), takeRow());
    assert.equal(outcome.kind, 'error');
    assert.match(String(outcome.detail), /tmdb-indisponivel/);
    assert.equal(calls.length, 0);
  });

  test('filme nunca consulta temporadas, mesmo com unlocated', async () => {
    let asked = 0;
    const process = createPageProcessor({
      record: recorder([]),
      seasonCount: async () => { asked += 1; return { ok: true, seasons: 1 }; },
    });
    const site = seriesSite({ type: 'movie', releases: [pack], groups: undefined, unlocated: [pack] });
    const outcome = await process(site, takeRow());
    assert.equal(outcome.kind, 'done');
    assert.equal(asked, 0);
  });
});
