// Motor de raspagem (plano "Raspagem total", Fase 3): fila serial, ritmo,
// freio de tráfego, teto horário, retomada de inflight, cursor incremental
// (parcial não avança), canário de layout, pausa por erros de site e dry-run
// sem efeitos colaterais. A política pura, o processador de página e o
// recorder ficam em `crawl-recorder.test.ts` (catraca de 400 linhas).
//
// Isolamento: store em MEMÓRIA por caso; adaptadores DUBLÊS injetados (o Vaca
// real nunca é tocado); `idleWindowMs: 0` desliga o freio por padrão (o freio
// tem o próprio caso, porque `activity.noteUserRequest` não tem reset e
// poluiria os casos seguintes).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const activity = await import('../src/providers/activity.js');
const cache = await import('../src/utils/cache.js');
const releaseIndex = await import('../src/utils/release-index.js');
const bank = await import('../src/utils/magnet-bank.js');
const { prefix } = await import('../src/utils/cache-keys.js');
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  freshCrawl();
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

/** Defaults de teste: freio desligado (0) e delay 0; o caso do freio o liga. */
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

/** Magnet determinístico e hex para o seed (40 chars). */
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('crawler: motor', () => {
  test('ritmo: CRAWL_DELAY_MS espaça requisições ao site', async () => {
    freshCrawl({ delayMs: 150 });
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b')], 1);
    crawler._setSitesForTest(() => fakeSite());
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    await crawler.tick(); // dentro da pausa: segura
    assert.equal(store.engine().counters('fake').byStatus.simulated, 0, 'ritmo segura a página após a descoberta');
    await sleep(170);
    await crawler.tick();
    assert.equal(store.engine().counters('fake').byStatus.simulated, 1);
    await crawler.tick();
    assert.equal(store.engine().counters('fake').byStatus.simulated, 1, '2ª página respeita a pausa');
    await sleep(170);
    await crawler.tick();
    assert.equal(store.engine().counters('fake').byStatus.simulated, 2);
  });

  test('freio: tráfego recente trava; janela 0 libera', async () => {
    freshCrawl({ idleWindowMs: 600_000 });
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    crawler._setSitesForTest(() => fakeSite());
    crawler._forceDiscoveryForTest();
    activity.noteUserRequest();
    await crawler.tick();
    assert.equal(store.engine().counters('fake').byStatus.pending, 1, 'com tráfego, nada é reclamado');
    freshCrawl({ idleWindowMs: 0 });
    await crawler.tick(); // descoberta
    await crawler.tick(); // página
    assert.equal(store.engine().counters('fake').byStatus.simulated, 1);
  });

  test('teto horário: CRAWL_MAX_PER_HOUR corta e reporta no status', async () => {
    // Desde a Fase 8 a rodada de descoberta entra no teto por hora (são
    // requisições de verdade), então o teto deste caso é 1 (descoberta) + 2
    // páginas. O custo da descoberta tem caso próprio, logo abaixo.
    freshCrawl({ maxPerHour: 3, discoveryCost: 1 });
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b'), movie('/c')], 1);
    crawler._setSitesForTest(() => fakeSite());
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    await crawler.tick(); // /a
    await crawler.tick(); // /b
    assert.equal(crawler.status().pagesThisHour, 3);
    assert.equal(crawler.status().maxPerHour, 3);
    await crawler.tick(); // teto
    assert.equal(store.engine().counters('fake').byStatus.simulated, 2);
    assert.equal(store.engine().counters('fake').byStatus.pending, 1, '3ª página fica na fila');
  });

  test('Fase 8: a descoberta entra no teto por hora (custo declarado)', async () => {
    freshCrawl({ maxPerHour: 4, discoveryCost: 3 });
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b'), movie('/c')], 1);
    crawler._setSitesForTest(() => fakeSite());
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta: 3 req
    assert.equal(crawler.status().pagesThisHour, 3);
    await crawler.tick(); // /a: 1 req — fecha a hora
    assert.equal(crawler.status().pagesThisHour, 4);
    await crawler.tick(); // teto: nada mais passa
    assert.equal(crawler.status().pagesThisHour, 4, 'o teto global segura a página seguinte');
    assert.equal(store.engine().counters('fake').byStatus.simulated, 1);
  });

  test('retomada: inflight de processo anterior volta a pending no start()', async () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    assert.equal(store.engine().takeNext('fake', 2)?.status, 'inflight', 'simula claim interrompido');
    crawler._setSitesForTest(() => fakeSite());
    crawler.start(); // requeueInflight(0)
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending', 'inflight órfão retomado');
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    await crawler.tick(); // página
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
  });

  test('descoberta parcial não avança o cursor; completa avança e alimenta o since', async () => {
    const sinceCalls: Array<string | null> = [];
    let partial = true;
    const site = fakeSite({
      discover: async (since) => {
        sinceCalls.push(since ?? null);
        if (partial) return { urls: [movie('/a', '2026-01-01')], complete: false, failures: ['s: down'] };
        return { urls: [movie('/a', '2026-01-01'), movie('/b', '2026-02-01')], complete: true, failures: [] };
      },
    });
    crawler._setSitesForTest(() => site);
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // t1: descoberta parcial
    await crawler.tick(); // t2: página /a
    await crawler.tick(); // t3: drena → fecha ciclo
    assert.equal(crawler.status().cursor, null, 'parcial não avança o cursor');

    crawler._forceDiscoveryForTest();
    await crawler.tick(); // t4: descoberta (since deve continuar null)
    assert.equal(sinceCalls[1], null, 'cursor vazio → ainda carga inicial');
    await crawler.tick(); // t5: nada pendente → fecha

    partial = false;
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // t6: descoberta COMPLETA (since null; avança o cursor agora)
    assert.equal(sinceCalls[2], null, 'o since da rodada ainda era o cursor antigo');
    await crawler.tick(); // t7: página /b
    await crawler.tick(); // t8: fecha
    assert.equal(crawler.status().cursor, '2026-02-01', 'completa avança para o maior lastmod');
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // t9: incremental
    assert.equal(sinceCalls[3], '2026-02-01', 'incremental relê a partir do cursor');
  });

  test('canário de layout: páginas que tinham torrent e voltam sem botão pausam', async () => {
    freshCrawl({ layoutCanary: 2 });
    let phase: 'torrents' | 'no-buttons' = 'torrents';
    const site = fakeSite({
      discover: async () => ({
        urls: [movie('/a', phase === 'torrents' ? '2026-01-01' : '2026-03-01'),
          movie('/b', phase === 'torrents' ? '2026-01-01' : '2026-03-01')],
        complete: true, failures: [],
      }),
      fetchWork: async (url) => (phase === 'torrents'
        ? { url, status: 'done', imdb: 'tt1', title: 'T', year: 2000, type: 'movie', releases: [item(url)] }
        : { url, status: 'no-torrent', imdb: 'tt1', title: 'T', year: 2000, type: 'movie' }),
    });
    crawler._setSitesForTest(() => site);
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 4; i += 1) await crawler.tick(); // descoberta + /a + /b + fecha
    assert.equal(crawler.status().autoPause, null);
    phase = 'no-buttons'; // layout mudou: lastmod novo força refresh das URLs
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta (refresh)
    await crawler.tick(); // /a sem botão → evento 1
    assert.equal(crawler.status().autoPause, null);
    await crawler.tick(); // /b sem botão → evento 2 → pausa
    assert.equal(crawler.status().autoPause?.reason, 'layout');
    assert.equal(crawler.status().canaryStreak, 2);
  });

  test('pausa por erros de site (403/429/5xx/blocked_host/challenge)', async () => {
    freshCrawl({ errorPauseStreak: 3 });
    let n = 0;
    const site = fakeSite({
      discover: async () => ({
        urls: [movie('/a'), movie('/b'), movie('/c'), movie('/d')], complete: true, failures: [],
      }),
      fetchWork: async () => {
        n += 1;
        throw new Error(n % 2 ? 'fetch: HTTP 403 Forbidden' : 'blocked_host:evil.example');
      },
    });
    crawler._setSitesForTest(() => site);
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    for (let i = 0; i < 3; i += 1) await crawler.tick(); // 3 erros de site
    assert.equal(crawler.status().autoPause?.reason, 'error-streak');
    assert.equal(crawler.status().errorStreak, 3);
    const errors = store.engine().counters('fake').byStatus.error;
    await crawler.tick(); // pausado: não processa
    assert.equal(store.engine().counters('fake').byStatus.error, errors);
  });

  test('erro comum (timeout/parse) NÃO pausa o site', async () => {
    freshCrawl({ errorPauseStreak: 2 });
    const site = fakeSite({
      discover: async () => ({ urls: [movie('/a'), movie('/b'), movie('/c')], complete: true, failures: [] }),
      fetchWork: async () => { throw new Error('socket hang up'); },
    });
    crawler._setSitesForTest(() => site);
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    for (let i = 0; i < 3; i += 1) await crawler.tick();
    assert.equal(crawler.status().autoPause, null);
    assert.equal(crawler.status().errorStreak, 0);
  });

  test('setPaused(false) limpa a pausa automática', async () => {
    freshCrawl({ errorPauseStreak: 1 });
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    const site = fakeSite({ fetchWork: async () => { throw new Error('HTTP 500'); } });
    crawler._setSitesForTest(() => site);
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    await crawler.tick();
    assert.equal(crawler.status().autoPause?.reason, 'error-streak');
    crawler.setPaused(false);
    assert.equal(crawler.status().autoPause, null);
  });

  test('desabilitado: start() não arma e tick() não faz nada', async () => {
    freshCrawl({ enabled: false });
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    crawler._setSitesForTest(() => fakeSite());
    crawler._forceDiscoveryForTest();
    crawler.start();
    await crawler.tick();
    assert.equal(crawler.status().enabled, false);
    assert.equal(store.engine().counters('fake').byStatus.pending, 1);
  });

  test('dry-run: zero efeitos colaterais (banco, índice, listas)', async () => {
    freshCrawl({ dryRun: true });
    const imdb = 'tt7654321';
    const streamKey = `${prefix('streams')}movie:${imdb}:canary`;
    cache.set(streamKey, { keep: 1 }, 900);
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    crawler._setSitesForTest(() => fakeSite({
      fetchWork: async (url) => ({
        url, status: 'done', imdb, title: 'Obra', year: 2000, type: 'movie', releases: [item(url)],
      }),
    }));
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta
    await crawler.tick(); // página
    const row = store.engine().getUrl('fake', '/a') as CrawlUrlRow;
    // Dry-run NÃO marca done (nada foi gravado): status próprio `simulated`.
    assert.equal(row.status, 'simulated');
    assert.equal(row.imdb, imdb);
    assert.equal(row.releases, 1);
    assert.equal(releaseIndex.lookupQuiet(imdb, {}).length, 0, 'índice intacto');
    assert.ok(cache.get(streamKey), 'lista pronta não foi invalidada');
    assert.equal(bank.isOpen(), false, 'banco vivo não foi aberto');
    cache.forget(streamKey);
  });
});
