// Fase 6 do plano "Raspagem total": ciclo INCREMENTAL. Depois da carga
// inicial, cada `incrementalIntervalMin` o sitemap é relido e SÓ URL nova ou
// com lastmod alterado é reprocessada (`unchanged` não toca status,
// `checked_at` nem releases); descoberta parcial não avança o cursor e não
// agenda como completa; o cursor é PERSISTIDO no `crawl.db` e o restart
// retoma incremental sem recarregar o acervo; a rodada (initial e
// incremental) fecha com `finishedAt`/contadores coerentes quando a fila
// esgota; lançamento novo descoberto entra na MESMA rodada.
//
// Isolamento: sem rede (adaptadores dublês), relógio real mas intervalos
// verificados pelo `status().nextDiscoveryAt` (o teste não espera 60 min);
// store em MEMÓRIA por caso — o caso de restart usa SQLite em diretório
// temporário para provar a persistência de verdade.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const savedCrawl = { ...config.crawl };
const tempDirs: string[] = [];
const freshDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-incr-'));
  tempDirs.push(d);
  return d;
};

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
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
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const entry = (url: string, lastmod: string) => ({ url, lastmod, kind: 'movie' as const });

/** Magnet determinístico e hex (40 chars) — release válida para o desfecho `done`. */
function item(seed: string): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return {
    title: 'Fake Obra (2000) 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1, size: 1000,
  };
}

/** Adaptador dublê: descoberta e fetches sob controle do caso. */
function harness(initial: { url: string; lastmod: string }[], lastmodFor: (url: string) => string) {
  const fetched: string[] = [];
  const sinceCalls: Array<string | null> = [];
  const site: CrawlSite = {
    id: 'fake',
    label: 'Fake',
    discover: async (since) => {
      sinceCalls.push(since ?? null);
      const urls = initial.map((e) => entry(e.url, lastmodFor(e.url)));
      return { urls, complete: true, failures: [] } satisfies CrawlDiscovery;
    },
    fetchWork: async (url) => {
      fetched.push(url);
      return {
        url, status: 'done' as const, imdb: 'tt1000000', title: 'Fake Obra',
        year: 2000, type: 'movie' as const, releases: [item(url)],
      };
    },
  };
  return { site, fetched, sinceCalls };
}

function drainAll(): Promise<void> {
  return (async () => {
    // Teto de segurança: a fila de teste nunca passa de algumas URLs.
    for (let i = 0; i < 20; i += 1) {
      if (!crawler.status().runOpen) return;
      await crawler.tick();
    }
  })();
}

describe('crawler: ciclo incremental (Fase 6)', () => {
  test('intervalo: fecha a carga inicial e só relê depois de incrementalIntervalMin', async () => {
    const h = harness([{ url: '/a', lastmod: '2026-01-01' }], () => '2026-01-01');
    crawler._setSitesForTest(() => h.site);
    await crawler.tick(); // descoberta
    await drainAll(); // /a + fecha
    assert.equal(crawler.status().runOpen, false, 'carga inicial fecha quando a fila esgota');
    const run = store.engine().latestRun('fake');
    assert.equal(run?.phase, 'initial');
    assert.ok(run?.finishedAt, 'rodada fechada com finishedAt');
    assert.equal(run?.counters?.pages, 1, 'contador de páginas coerente');
    const before = crawler.status().nextDiscoveryAt as number;
    assert.ok(before > Date.now() + 55 * 60_000, 'próxima descoberta só no fim do intervalo');
    await crawler.tick(); // dentro do intervalo: nada acontece
    assert.equal(h.fetched.length, 1, 'nada é reprocessado antes do intervalo');
    assert.equal(store.engine().latestRun('fake')?.id, run?.id, 'nenhuma rodada nova aberta');
  });

  test('incremental: URL nova entra na mesma rodada; lastmod igual não reprocessa', async () => {
    let phase2 = false;
    const h = harness(
      [{ url: '/a', lastmod: '2026-01-01' }],
      (url) => (phase2 && url === '/b' ? '2026-02-01' : '2026-01-01'),
    );
    // /b só existe na releitura incremental.
    const discover = h.site.discover;
    h.site.discover = async (since) => {
      const d = await discover(since);
      if (phase2) return { urls: [...d.urls, entry('/b', '2026-02-01')], complete: true, failures: [] };
      return d;
    };
    crawler._setSitesForTest(() => h.site);
    await crawler.tick(); // descoberta inicial
    await drainAll();
    const aBefore = store.engine().getUrl('fake', '/a') as CrawlUrlRow;
    assert.equal(aBefore.status, 'done');

    phase2 = true;
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta incremental
    assert.equal(h.sinceCalls[1], '2026-01-01', 'incremental relê a partir do cursor');
    await drainAll();
    assert.ok(h.fetched.includes('/b'), 'lançamento novo é processado na mesma rodada');
    assert.ok(!h.fetched.slice(1).includes('/a'), 'lastmod igual NÃO reprocessa /a');
    const aAfter = store.engine().getUrl('fake', '/a') as CrawlUrlRow;
    assert.equal(aAfter.checkedAt, aBefore.checkedAt, 'unchanged não toca checked_at');
    assert.equal(aAfter.releases, aBefore.releases, 'unchanged não toca releases');
    const run = store.engine().latestRun('fake');
    assert.equal(run?.phase, 'incremental');
    assert.ok(run?.finishedAt, 'rodada incremental fecha com finishedAt');
    assert.equal(run?.counters?.pages, 1, 'só a página nova conta na rodada');
  });

  test('incremental: lastmod alterado reprocessa; no-torrent sem mudança não é tocado', async () => {
    const mods: Record<string, string> = { '/a': '2026-01-01', '/b': '2026-01-01' };
    const h = harness(
      [{ url: '/a', lastmod: '2026-01-01' }, { url: '/b', lastmod: '2026-01-01' }],
      (url) => mods[url],
    );
    h.site.fetchWork = async (url) => {
      h.fetched.push(url);
      if (url === '/b') {
        return { url, status: 'no-torrent', imdb: 'tt1000000', title: 'Fake Obra', year: 2000, type: 'movie' };
      }
      return { url, status: 'done', imdb: 'tt1000000', title: 'Fake Obra', year: 2000, type: 'movie' };
    };
    crawler._setSitesForTest(() => h.site);
    await crawler.tick();
    await drainAll();
    const bBefore = store.engine().getUrl('fake', '/b') as CrawlUrlRow;
    assert.equal(bBefore.status, 'no-torrent');

    mods['/a'] = '2026-03-01'; // só /a mudou
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    await drainAll();
    assert.ok(h.fetched.includes('/a'), 'lastmod novo reprocessa');
    assert.equal(h.fetched.filter((u) => u === '/b').length, 1, 'no-torrent sem mudança não é reprocessado');
    const bAfter = store.engine().getUrl('fake', '/b') as CrawlUrlRow;
    assert.equal(bAfter.checkedAt, bBefore.checkedAt, 'linha intocada (checked_at)');
    assert.equal(bAfter.status, 'no-torrent');
  });

  test('descoberta parcial não avança o cursor e reagenda em retry curto', async () => {
    let partial = true;
    const site: CrawlSite = {
      id: 'fake',
      label: 'Fake',
      discover: async () => (partial
        ? { urls: [entry('/a', '2026-01-01')], complete: false, failures: ['sitemap2: down'] }
        : { urls: [entry('/a', '2026-01-01'), entry('/b', '2026-02-01')], complete: true, failures: [] }),
      fetchWork: async (url) => ({
        url, status: 'done', imdb: 'tt1000000', title: 'T', year: 2000, type: 'movie',
      }),
    };
    crawler._setSitesForTest(() => site);
    await crawler.tick(); // descoberta parcial
    await drainAll();
    assert.equal(crawler.status().cursor, null, 'parcial não avança o cursor');
    const next = crawler.status().nextDiscoveryAt as number;
    assert.ok(next <= Date.now() + 90_000, 'parcial reagenda em retry curto, não no intervalo');
    assert.equal(store.engine().latestRun('fake')?.phase, 'initial', 'sem cursor não vira incremental');

    partial = false;
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta completa
    await drainAll();
    assert.equal(crawler.status().cursor, '2026-02-01', 'completa avança o cursor');
    const nextOk = crawler.status().nextDiscoveryAt as number;
    assert.ok(nextOk > Date.now() + 55 * 60_000, 'completa agenda o ciclo incremental inteiro');
  });

  test('restart: cursor vem do crawl.db e a rodada nasce incremental', async () => {
    // Este caso usa SQLite de verdade para provar a persistência.
    store.resetForTests();
    store.open(path.join(freshDir(), 'crawl.db'));
    const h = harness([{ url: '/a', lastmod: '2026-01-01' }], () => '2026-01-01');
    crawler._setSitesForTest(() => h.site);
    crawler.start();
    await crawler.tick();
    await drainAll();
    assert.equal(crawler.status().cursor, '2026-01-01');
    assert.equal(store.engine().latestRun('fake')?.phase, 'initial');

    // "Restart": motor zerado, store PRESERVADO (mesmo crawl.db).
    crawler._resetForTest();
    const h2 = harness([{ url: '/a', lastmod: '2026-01-01' }], () => '2026-01-01');
    crawler._setSitesForTest(() => h2.site);
    crawler.start();
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // primeira descoberta pós-restart
    assert.equal(h2.sinceCalls[0], '2026-01-01', 'cursor restaurado do store, não da memória');
    assert.equal(store.engine().latestRun('fake')?.phase, 'incremental', 'rodada pós-restart é incremental');
    await drainAll();
    assert.equal(h2.fetched.length, 0, 'restart não reprocessa o acervo sem mudança');
  });

  test('"Zerar site" apaga o cursor persistido (volta a carga inicial)', async () => {
    const h = harness([{ url: '/a', lastmod: '2026-01-01' }], () => '2026-01-01');
    crawler._setSitesForTest(() => h.site);
    crawler.start();
    await crawler.tick();
    await drainAll();
    assert.ok(crawler.status().cursor);
    crawler.resetSite('fake');
    assert.equal(crawler.status().cursor, null, 'cursor some com o estado do site');
    crawler.start();
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    assert.equal(h.sinceCalls[h.sinceCalls.length - 1], null, 'descoberta recomeça sem since');
    assert.equal(store.engine().latestRun('fake')?.phase, 'initial');
  });
});
