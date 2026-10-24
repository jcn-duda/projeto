// Contrato do corte da Fase 6: o Mico virou `rust: true` no registro e é
// raspado pela lane de ritmo próprio do sidecar (`adom-crawl::motor::mico_lane`),
// fora do teto/ociosidade/vagas. O motor TS perdeu o alvo: os NOVE sites da
// tabela são do sidecar, então `tick()` não reivindica nem processa o Mico em
// NENHUM modo — antes ele era o único own_pace do TS e o claim do Rust o
// recusava. O lado Rust do contrato vive em `motor::own_pace::tests` (bypass
// dos três freios) e `store::tests_part2` (claim exclusive do lote × lane).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const registry = await import('../src/providers/crawl-sites/registry.js');
import type { CrawlDiscovery, CrawlSite } from '../src/providers/crawl-types.js';
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

/** Defaults de teste: o sidecar (processo externo) é o dono dos nove sites. */
function freshCrawl(overrides: Record<string, unknown> = {}): void {
  Object.assign(config.crawl, {
    crawlEngine: 'rust',
    enabled: true,
    dryRun: true,
    sites: ['mico'],
    delayMs: 0,
    maxPerHour: 1000,
    idleWindowMs: 0,
    maxTries: 2,
  }, overrides);
}

const movie = (url: string, lastmod = '2026-01-01') => ({ url, lastmod, kind: 'movie' as const });

/** Magnet determinístico e hex para o seed (40 chars) — sem release nenhuma o
 * `done` viraria `no-torrent` e o dry-run não chegaria a `simulated`. */
function item(seed: string, title = 'Mico Obra'): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return {
    title: `${title} (2000) 1080p DUBLADO`, magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1, size: 1000,
  };
}

/** Adaptador dublê para QUALQUER id (o motor nunca toca o site real). */
function fakeSiteFor(id: string, onFetch?: () => void): CrawlSite {
  return {
    id,
    label: id,
    discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string) => {
      onFetch?.();
      return {
        url, status: 'done', imdb: 'tt1000000', title: 'Mico Obra', year: 2000,
        type: 'movie', releases: [item(url)],
      };
    },
  };
}

describe('Fase 6: o Mico é do sidecar Rust em ambos os modos', () => {
  test('registro: mico é rust, own_pace e sem módulo TS', async () => {
    assert.equal(registry.isRustSite('mico'), true, 'o motor TS não é mais o dono');
    assert.equal(registry.isOwnPace('mico'), true, 'ritmo próprio continua declarado (lane do Rust)');
    assert.equal(registry.siteInfo('mico').adapter, true, 'tem adaptador (no sidecar)');
    assert.equal(await registry.ensureSite('mico'), null, 'não há adaptador TS para o Mico');
  });

  for (const mode of ['rust', 'ts'] as const) {
    test(`modo ${mode}: tick não reivindica nem chama o adaptador do Mico`, async () => {
      Object.assign(config.crawl, { crawlEngine: mode });
      let micoFetches = 0;
      store.engine().upsertUrls('mico', [movie('/crawl/movie/tt1000000/')], 1);
      // A fábrica de teste devolveria um adaptador para 'mico'; se o motor o
      // pedisse, o fetch abaixo contaria — o filtro por `isRustSite` é o que
      // impede o TS de disputar a fila com a lane.
      crawler._setSitesForTest((id) => fakeSiteFor(id, id === 'mico' ? () => { micoFetches += 1; } : undefined));
      await crawler.tick();
      await crawler.tick();
      assert.equal(store.engine().getUrl('mico', '/crawl/movie/tt1000000/')?.status, 'pending',
        'a fila do Mico é do sidecar: o TS não a move');
      assert.equal(micoFetches, 0, 'o adaptador do Mico nunca é chamado pelo TS');
      assert.equal(crawler.status().pagesThisHourTotal, 0, 'nada é cobrado no teto agregado do TS');
    });
  }

  test('id fora da tabela segue no motor TS, provando que o filtro é POR site', async () => {
    freshCrawl({ sites: ['fake'] });
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    crawler._setSitesForTest((id) => fakeSiteFor(id));
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta do dublê (sem URLs)
    await crawler.tick(); // linha semeada
    assert.equal(store.engine().counters('fake').byStatus.simulated, 1, 'o dublê continua no motor TS');
  });

  test('start() retoma a inflight órfã do Mico mesmo sem adaptador TS', async () => {
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt2000000/')], 1);
    assert.equal(store.engine().takeNext('mico', 2)?.status, 'inflight', 'simula claim interrompido');
    crawler._setSitesForTest((id) => fakeSiteFor(id));
    crawler.start(); // primeSite → requeueInflight em TODOS os sites ativos
    assert.equal(store.engine().getUrl('mico', '/crawl/movie/tt2000000/')?.status, 'pending',
      'inflight órfã volta a pending: o sidecar a encontra na próxima rodada');
  });
});
