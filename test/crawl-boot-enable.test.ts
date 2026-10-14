// Boot DESABILITADO com dry-run desligado (follow-up P3): start() sai antes de
// chegar no site, então a passada de `simulated` não roda. Ao habilitar depois
// (mesmo caminho do painel), a primeira `step` tem que reenfileirar; enquanto
// desabilitado, NADA é tocado.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const crawlerLive = await import('../src/utils/crawler-live.js');
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  crawlerLive._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, savedCrawl);
});

after(() => {
  crawler._resetForTest();
  crawlerLive._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

function freshCrawl(overrides: Record<string, unknown> = {}): void {
  Object.assign(config.crawl, {
    enabled: true,
    dryRun: true,
    sites: ['fake'],
    delayMs: 0,
    maxPerHour: 1000,
    idleWindowMs: 0,
    maxTries: 2,
    errorPauseStreak: 5,
    layoutCanary: 10,
    incrementalIntervalMin: 60,
  }, overrides);
}

const movie = (url: string, lastmod = '2026-01-01') => ({ url, lastmod, kind: 'movie' as const });

function item(seed: string, title = 'Fake Obra'): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return {
    title: `${title} (2000) 1080p DUBLADO`, magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1, size: 1000,
  };
}

function fakeSite(over: Partial<CrawlSite> = {}): CrawlSite {
  return {
    id: 'fake',
    label: 'Fake',
    discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string) => ({
      url, status: 'done', imdb: 'tt1000000', title: 'Fake Obra', year: 2000,
      type: 'movie', releases: [item(url)],
    }),
    ...over,
  };
}

describe('motor: boot disabled + dry-run off — recuperação de simulated na 1ª step pós-enable', () => {
  test('boot enabled=false && dryRun=false: simulated fica parada; enable reenfileira na 1ª tick', async () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    store.engine().markResult('fake', '/a', { status: 'simulated', imdb: 'tt1', releases: 2 }, 100);
    crawler._setSitesForTest(() => fakeSite());
    freshCrawl({ enabled: false, dryRun: false });
    crawler.start(); // boot desabilitado: sai antes do site, sem passada
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated', 'desabilitado: simulated não é tocada');

    await crawler.tick(); // tick sem enabled é no-op
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');

    // Habilitar pelo mesmo caminho do painel (config persistida); o listener
    // de config já foi registrado no start() do boot desabilitado.
    const set = crawlerLive.set({ enabled: true });
    assert.ok(set.ok);

    await crawler.tick(); // 1ª step pós-enable: reenfileira ANTES do takeNext
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending', 'enable reenfileira na primeira step');
    assert.equal(store.engine().counters('fake').byStatus.simulated, 0);

    await crawler.tick(); // processa a reenfileirada (gravação real falha fechado → erro retentável)
    const status = store.engine().getUrl('fake', '/a')?.status;
    assert.ok(status === 'done' || status === 'error', `desfecho coerente: ${status}`);
    assert.notEqual(status, 'simulated', 'passada é one-shot: não volta a simulated');
  });

  test('cursor gravado: o card mostra com o motor desligado e o enable roda INCREMENTAL', async () => {
    // Antes, só o `start()` com o motor LIGADO lia o `crawl_state`: boot
    // desligado + enable no painel saía `initial` e relia o sitemap inteiro,
    // e o card dizia "carga inicial" com cursor gravado no banco.
    store.engine().setState('fake', 'cursor:movie', '2026-05-01T00:00:00+00:00');
    store.engine().setState('fake', 'cursor:tv_show', '2026-05-02T00:00:00+00:00');
    const sinces: Array<string | null | undefined> = [];
    crawler._setSitesForTest(() => fakeSite({
      discover: async (since): Promise<CrawlDiscovery> => {
        sinces.push(since);
        return { urls: [movie('/c', '2026-06-01')], complete: true, failures: [] };
      },
    }));
    freshCrawl({ enabled: false });
    crawler.start();
    const card = crawler.status().sites.find((s) => s.id === 'fake');
    assert.equal(card?.cursors.movie, '2026-05-01T00:00:00+00:00', 'card lê o cursor com o motor desligado');
    assert.equal(card?.cursors.tv_show, '2026-05-02T00:00:00+00:00');

    assert.ok(crawlerLive.set({ enabled: true }).ok);
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 4 && sinces.length === 0; i += 1) await crawler.tick();
    assert.deepEqual(sinces, ['2026-05-01T00:00:00+00:00'], 'descoberta parte do cursor gravado');
    assert.equal(store.engine().latestRun('fake')?.phase, 'incremental');
  });

  test('boot desabilitado com dry-run LIGADO: enable não reenfileira (ainda é simulação)', async () => {
    store.engine().upsertUrls('fake', [movie('/b')], 1);
    store.engine().markResult('fake', '/b', { status: 'simulated', imdb: 'tt2', releases: 1 }, 100);
    crawler._setSitesForTest(() => fakeSite());
    freshCrawl({ enabled: false, dryRun: true });
    crawler.start();
    const set = crawlerLive.set({ enabled: true });
    assert.ok(set.ok);
    await crawler.tick();
    assert.equal(store.engine().getUrl('fake', '/b')?.status, 'simulated', 'dry-run ligado: simulated permanece terminal');
  });
});
