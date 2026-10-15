// Roteamento single-owner do Mico (own_pace) com CRAWL_ENGINE=rust: o sidecar
// Rust é o dono dos sites comuns (e os exclui no claim, `store/ops.rs`); o
// motor TS arma o timer RESTRITO aos own_pace — sem isto o Mico deixava de ser
// raspado (o engine Rust o recusava queimando tentativa e o TS não armava
// nada). Estes casos cobrem o lado TS do contrato; o lado Rust tem os casos
// `take_next_recusa_own_pace` e `take_next_batch_exclui_own_pace_sem_gastar_vaga`.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
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

/** Defaults de teste em MODO RUST: o sidecar (processo externo) é o dono do
 * resto — aqui ele é simulado pela AUSÊNCIA de trabalho TS sobre os comuns. */
function freshCrawl(overrides: Record<string, unknown> = {}): void {
  Object.assign(config.crawl, {
    crawlEngine: 'rust',
    enabled: true,
    dryRun: true,
    sites: ['mico', 'fake'],
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

describe('crawler em modo rust: dono único do own_pace (Mico)', () => {
  test('tick restrito: processa SÓ o own_pace; site comum fica para o sidecar', async () => {
    let fakeFetches = 0;
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt1000000/')], 1);
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    // O contador é SÓ do site comum: o fetch do próprio Mico não é "vazamento".
    crawler._setSitesForTest((id) => fakeSiteFor(id, id === 'fake' ? () => { fakeFetches += 1; } : undefined));
    crawler._forceDiscoveryForTest();
    await crawler.tick(); // descoberta do Mico (a única fila que o TS enxerga)
    await crawler.tick(); // página do Mico
    assert.equal(store.engine().counters('mico').byStatus.simulated, 1, 'o TS processa o own_pace em modo rust');
    assert.equal(store.engine().counters('fake').byStatus.pending, 1, 'site comum fica para o sidecar');
    assert.equal(fakeFetches, 0, 'o adaptador do site comum nunca é chamado pelo TS');
    // O custo do own_pace não consome o TETO AGREGADO (`pagesThisHour` do
    // status é o contador do SITE ATIVO — aqui o próprio Mico, que tem contador
    // só para o painel; o agregado do processo é quem não pode ser tocado).
    assert.equal(crawler.status().pagesThisHourTotal, 0, 'teto agregado não consome com own_pace');
  });

  test('start() retoma a inflight órfã do Mico (claim interrompido)', async () => {
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt2000000/')], 1);
    assert.equal(store.engine().takeNext('mico', 2)?.status, 'inflight', 'simula claim interrompido');
    crawler._setSitesForTest((id) => fakeSiteFor(id));
    crawler.start(); // primeSite → requeueInflight em TODOS os sites ativos
    assert.equal(store.engine().getUrl('mico', '/crawl/movie/tt2000000/')?.status, 'pending', 'inflight órfã volta a pending no modo rust');
  });
});
