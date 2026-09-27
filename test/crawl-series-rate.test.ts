// Fase 7 (séries) no MOTOR: a descoberta de séries recebe os limites da config
// viva (gated, default off) e o teto por hora cobra o custo REAL da página
// (requestCost medido pelo adaptador), não 1 por página. Adaptador dublê —
// o Vaca real nunca é tocado. Os testes do adaptador em si estão em
// `crawl-vaca-series.test.ts`.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { createHourCounter } = await import('../src/providers/crawl-rate.js');
import type { CrawlSite } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const SITE = 'https://vaqueirofilmes.com';
const SHOW = 'https://vaqueirofilmes.com/pt/tv-shows/outer-banks/';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['fake'], delayMs: 0,
    maxPerHour: 1000, idleWindowMs: 0, maxTries: 2, layoutCanary: 10,
    seriesEnabled: false, seriesMaxCards: 10, seriesMaxButtons: 40,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

describe('motor Fase 7: descoberta gated e teto horário com o custo REAL', () => {
  function rel(hash: string): RawItem {
    return {
      title: 'Outer Banks (2020) S02E01 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
      indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1,
    };
  }
  function seriesSiteForMotor(): CrawlSite {
    return {
      id: 'fake', label: 'Fake',
      discover: async () => ({ urls: [], complete: true, failures: [] }),
      fetchWork: async () => ({
        url: SHOW, status: 'done', imdb: 'tt1', title: 'Outer Banks', year: 2020, type: 'series',
        groups: [{ season: 2, episode: 1, releases: [rel('a1'.repeat(20))] }],
        requestCost: 9,
      }),
    };
  }

  test('discover recebe os limites da config viva e o corte POR KIND; knob off chega como enabled:false', async () => {
    const crawlerLive = await import('../src/utils/crawler-live.js');
    crawlerLive._resetForTest();
    let seen: unknown = null;
    const site: CrawlSite = {
      id: 'fake', label: 'Fake',
      discover: async (_since, opts) => { seen = opts; return { urls: [], complete: true, failures: [] }; },
      fetchWork: async (url) => ({ url, status: 'no-torrent' }),
    };
    crawler._setSitesForTest(() => site);
    config.crawl.seriesEnabled = true; config.crawl.seriesMaxCards = 7; config.crawl.seriesMaxButtons = 9;
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    // F2: primeiro ciclo = carga inicial dos DOIS kinds (cursor vazio).
    assert.deepEqual(seen, {
      series: { enabled: true, maxCards: 7, maxButtons: 9 },
      sinceByKind: { movie: null, tv_show: null },
    });
    config.crawl.seriesEnabled = false;
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // fecha a rodada anterior (fila vazia)
    await crawler.tick(); // redescobre com o knob off
    assert.deepEqual(seen, {
      series: { enabled: false, maxCards: 7, maxButtons: 9 },
      sinceByKind: { movie: null, tv_show: null },
    });
  });

  test('requestCost é cobrado no teto por hora (página de série não vale 1 request)', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: '2026-01-01', kind: 'tv_show' }], 1);
    crawler._setSitesForTest(() => seriesSiteForMotor());
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    await crawler.tick(); // a página de série
    assert.equal(crawler.status().pagesThisHour, 9, '1 anotado no claim + 8 do custo medido');
    config.crawl.maxPerHour = 9;
    await crawler.tick(); // teto atingido: nada mais roda
    assert.equal(store.engine().counters('fake').byStatus.simulated, 1, 'fila segura no teto real');
  });

  test('gate de rate com DUAS séries caras: teto 9/h processa a 1ª e segura a 2ª (não vacuo)', async () => {
    const s2 = `${SITE}/pt/tv-shows/another-show/`;
    store.engine().upsertUrls('fake', [
      { url: SHOW, lastmod: '2026-01-01', kind: 'tv_show' as const },
      { url: s2, lastmod: '2026-01-01', kind: 'tv_show' as const },
    ], 1);
    crawler._setSitesForTest(() => seriesSiteForMotor());
    config.crawl.maxPerHour = 9; // UMA página de série (9 req) esgota a hora
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    await crawler.tick(); // 1ª série: custa 9 → teto esgotado
    await crawler.tick(); // 2ª série: BLOQUEADA pelo teto real
    let counters = store.engine().counters('fake');
    assert.equal(counters.byStatus.simulated, 1, 'só a primeira cabe no teto de 9 req/h');
    assert.equal(counters.byStatus.pending, 1, 'a segunda continua na fila, não foi tragada');
    // Teto frouxo: as duas passam — prova que o gate é o custo, não sorte.
    config.crawl.maxPerHour = 1000;
    await crawler.tick();
    counters = store.engine().counters('fake');
    assert.equal(counters.byStatus.simulated, 2, 'com o teto largo as duas são processadas');
  });

  test('hour counter: note() acumula N unidades', () => {
    const counter = createHourCounter();
    counter.note();
    counter.note(8);
    counter.note(0); // piso 1
    assert.equal(counter.current(), 10);
  });
});
