// Status `simulated` do dry-run (correção antes da Fase 7): página lida em
// simulação COM releases e obra identificada NUNCA marca `done` (nada foi
// gravado — as ~256 `done` antigas do dry-run se perderam assim). Cobre:
// marcação do processador, terminais no-torrent/no-work em dry-run,
// reenfileiramento one-shot do switch true→false (ao vivo e no restart),
// idempotência, contadores/painel e a migração do `crawl.db` com CHECK legada.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CACHE_PERSIST = 'false';

// `node:sqlite` só existe no Node 22+; no 20 (que o CI também roda) o store cai
// na engine de memória por desenho. O bloco de migração da CHECK é contrato
// exclusivo do arquivo SQLite — sem o módulo não há o que validar.
let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}
const skipSemSqlite = !hasNodeSqlite && 'node:sqlite indisponível — precisa de Node 22+';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const crawlerLive = await import('../src/utils/crawler-live.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  crawlerLive._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  freshCrawl();
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

describe('crawl-page: dry-run marca simulated', () => {
  test('dry-run com releases + obra: status simulated, NUNCA done', async () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    const row = store.engine().takeNext('fake', 10) as CrawlUrlRow;
    const outcome = await createPageProcessor()(fakeSite(), row, { dryRun: true, maxTries: 3 });
    assert.equal(outcome.kind, 'simulated');
    assert.equal(outcome.releases, 1);
    const saved = store.engine().getUrl('fake', '/a') as CrawlUrlRow;
    assert.equal(saved.status, 'simulated');
    assert.equal(saved.imdb, 'tt1000000', 'obra identificada preservada para a gravação futura');
    assert.equal(saved.releases, 1);
    // simulated NÃO volta sozinho: não é elegível para takeNext (terminal até
    // o reenfileiramento do switch).
    assert.equal(store.engine().takeNext('fake', Date.now() + 3_600_000), null);
  });

  test('dry-run: no-torrent e no-work continuam terminais (nada a gravar)', async () => {
    store.engine().upsertUrls('fake', [movie('/nt'), movie('/nw')], 1);
    const site = fakeSite({
      fetchWork: async (url) => (url === '/nt'
        ? { url, status: 'no-torrent', imdb: null, title: 'Só streaming', year: 2000, type: 'movie' }
        : { url, status: 'done', imdb: null, title: 'Sem casamento', year: 2000, type: 'movie', releases: [item(url)] }),
    });
    const identify = async () => ({ outcome: 'unidentified' as const, imdb: null, reason: 'x' });
    const process = createPageProcessor({ identify });
    const ntRow = store.engine().takeNext('fake', 10) as CrawlUrlRow;
    const nt = await process(site, ntRow, { dryRun: true });
    assert.equal(nt.kind, 'no-torrent');
    assert.equal(store.engine().getUrl('fake', ntRow.url)?.status, 'no-torrent');
    const nwRow = store.engine().takeNext('fake', 10) as CrawlUrlRow;
    const nw = await process(site, nwRow, { dryRun: true });
    assert.equal(nw.kind, 'no-work');
    assert.equal(store.engine().getUrl('fake', nwRow.url)?.status, 'no-work');
  });

  test('gravação real na mesma URL: simulated vira done', async () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    const process = createPageProcessor({ record: async () => ({ kept: 1, added: 1, transition: 'none', cleared: 0 }) });
    const row = store.engine().takeNext('fake', 10) as CrawlUrlRow;
    await process(fakeSite(), row, { dryRun: true });
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
    const second = store.engine().getUrl('fake', '/a') as CrawlUrlRow;
    const outcome = await process(fakeSite(), second, { dryRun: false });
    assert.equal(outcome.kind, 'done');
    assert.equal(outcome.addedNew, 1);
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'done');
  });
});

describe('store: requeueSimulated one-shot e seletivo', () => {
  test('só simulated volta; done/no-torrent/no-work/error ficam; repetir é no-op', () => {
    store.engine().upsertUrls('fake', [movie('/s1'), movie('/s2'), movie('/done'), movie('/nt'), movie('/nw'), movie('/err')], 1);
    const e = store.engine();
    e.markResult('fake', '/s1', { status: 'simulated', imdb: 'tt1', releases: 3 }, 100);
    e.markResult('fake', '/s2', { status: 'simulated', imdb: 'tt2', releases: 1 }, 101);
    e.markResult('fake', '/done', { status: 'done', imdb: 'tt3', releases: 5 }, 102);
    e.markResult('fake', '/nt', { status: 'no-torrent', imdb: null, releases: 0 }, 103);
    e.markResult('fake', '/nw', { status: 'no-work', imdb: null, releases: 0 }, 104);
    e.markResult('fake', '/err', { status: 'error', error: 'http 500' }, 105);

    assert.equal(e.requeueSimulated('fake'), 2, 'reenfileira só as simuladas');
    assert.equal(e.requeueSimulated('fake'), 0, 'segunda passada é no-op (idempotente)');

    const after = e.counters('fake').byStatus;
    assert.equal(after.simulated, 0);
    assert.equal(after.pending, 2, 'as duas simuladas pendentes');
    assert.equal(after.done, 1, 'done real não é tocado');
    assert.equal(after['no-torrent'], 1);
    assert.equal(after['no-work'], 1);
    assert.equal(after.error, 1);
    const s1 = e.getUrl('fake', '/s1') as CrawlUrlRow;
    assert.equal(s1.status, 'pending');
    assert.equal(s1.imdb, 'tt1', 'pista da simulação preservada até a gravação real');
    assert.equal(s1.releases, 3);
  });

  test('reenfileiramento é POR SITE', () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    store.engine().upsertUrls('other', [movie('/b')], 1);
    store.engine().markResult('fake', '/a', { status: 'simulated', imdb: 'tt1', releases: 1 }, 100);
    store.engine().markResult('other', '/b', { status: 'simulated', imdb: 'tt2', releases: 1 }, 100);
    assert.equal(store.engine().requeueSimulated('fake'), 1);
    assert.equal(store.engine().getUrl('other', '/b')?.status, 'simulated', 'outro site não é tocado');
  });

  test('lastmod igual NÃO desperta simulated; lastmod novo reinicia do zero', () => {
    store.engine().upsertUrls('fake', [movie('/a', '2026-01-01')], 1);
    store.engine().markResult('fake', '/a', { status: 'simulated', imdb: 'tt1', releases: 1 }, 100);
    // Mesma descoberta (lastmod igual): simulated permanece (ainda sem gravação).
    store.engine().upsertUrls('fake', [movie('/a', '2026-01-01')], 200);
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
    // lastmod novo: conteúdo pode ter mudado — volta a pending do zero.
    store.engine().upsertUrls('fake', [movie('/a', '2026-02-01')], 300);
    const row = store.engine().getUrl('fake', '/a') as CrawlUrlRow;
    assert.equal(row.status, 'pending');
    assert.equal(row.releases, 0, 'refresh zera releases (dado antigo não vale)');
  });
});

describe('motor: switch dryRun true→false reenfileira', () => {
  test('ao vivo: simulated volta à fila ANTES de processar; restart cobre o boot', async () => {
    // Sem rede para a gravação real (cinemeta/TMDB falham fechado → erro
    // retentável determinístico; a gravação feliz é prova do processador acima).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('rede bloqueada no teste'); }) as typeof fetch;
    try {
      store.engine().upsertUrls('fake', [movie('/a')], 1);
      crawler._setSitesForTest(() => fakeSite({
        fetchWork: async (url) => ({
          url, status: 'done', imdb: 'tt1000000', title: 'Fake Obra', year: 2000,
          type: 'movie', releases: [item(url)],
        }),
      }));
      crawler._forceDiscoveryForTest();
      await crawler.tick(); // descoberta
      await crawler.tick(); // /a em dry-run → simulated
      await crawler.tick(); // drena → fecha a rodada
      assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
      assert.equal(crawler.status().runOpen, false, 'fila terminou: rodada fechada');

      // Switch ao vivo via config persistida (mesmo caminho do painel).
      crawler.start();
      const set = crawlerLive.set({ dryRun: false });
      assert.ok(set.ok);

      // Primeiro tick pós-switch: reenfileira e ABRE rodada (não espera o ciclo).
      await crawler.tick();
      assert.notEqual(
        store.engine().getUrl('fake', '/a')?.status, 'simulated',
        'a leitura simulada não fica presa: voltou a processar',
      );
      assert.equal(store.engine().counters('fake').byStatus.simulated, 0);
      await crawler.tick(); // processa a URL reenfileirada
      // A gravação feliz pertence ao teste do processador; aqui a prova é a
      // fila: simulated saiu e a página foi reprocessada (done ou erro
      // retentável de gravação — nunca simulated nem pending parado).
      const status = store.engine().getUrl('fake', '/a')?.status;
      assert.ok(status === 'done' || status === 'error', `desfecho coerente: ${status}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('restart com dry-run já desligado (override persistido): start() reenfileira', () => {
    // Fila com simulated órfã de um processo anterior que rodou em dry-run.
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    store.engine().markResult('fake', '/a', { status: 'simulated', imdb: 'tt1', releases: 2 }, 100);
    crawler._setSitesForTest(() => fakeSite());
    crawler.start(); // boot com dryRun=false (config de teste alterada abaixo)
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated', 'dry-run ainda ligado: nada muda');

    freshCrawl({ dryRun: false });
    crawler._resetForTest();
    crawler.start(); // restart com dry-run desligado
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending', 'boot reenfileira as simulated');
  });
});

describe('status/painel: N simuladas aguardando gravação', () => {
  test('contadores e pendingRemaining incluem simulated; card expõe simulatedAwaiting', async () => {
    const buildCrawlerStatus = (await import('../src/providers/crawl-status.js')).buildCrawlerStatus;
    store.engine().upsertUrls('fake', [movie('/s'), movie('/d')], 1);
    store.engine().markResult('fake', '/s', { status: 'simulated', imdb: 'tt1', releases: 1 }, 100);
    store.engine().markResult('fake', '/d', { status: 'done', imdb: 'tt2', releases: 1 }, 101);
    const crawlerLiveMod = await import('../src/utils/crawler-live-schema.js');
    const cfg = crawlerLiveMod.envDefaults();
    const status = buildCrawlerStatus(store.currentEngine(), cfg, ['fake'], {
      activeSiteId: 'fake', activeLabel: 'Fake', paused: false, autoPause: null,
      cursors: { movie: '', tv_show: '' }, nextDiscoveryAt: 0, pagesThisHour: 0, openRunId: null,
      errorStreak: 0, canaryStreak: 0, cycle: {}, currentSiteNewReleases: 0, siteReady: true,
    });
    const card = status.sites[0];
    assert.equal(card.byStatus.simulated, 1);
    assert.equal(card.simulatedAwaiting, 1, 'painel recebe o N de simuladas');
    assert.equal(card.pendingRemaining, 1, 'simulated é trabalho restante');
  });

  test('modelo do painel normaliza simulated do byStatus', async () => {
    const model = await import('../src/client/painel/raspagens-model.js');
    const cards = model.crawlSiteCards({
      site: 'fake',
      sites: [{ id: 'fake', label: 'Fake', total: 10, byStatus: { done: 3, simulated: 7 }, progressPercent: 30 }],
    });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].simulated, 7);
    const badge = model.motorBadge(model.crawlSummary({ enabled: true, dryRun: true }));
    assert.equal(badge.text, 'SIMULAÇÃO');
  });
});

describe('SQLite legado: migração da CHECK de status', { skip: skipSemSqlite }, () => {
  test('crawl.db com CHECK legada é reconstruído preservando linhas e aceitando simulated', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-mig-'));
    const dbPath = path.join(dir, 'crawl.db');
    try {
      const legacy = new DatabaseSync(dbPath);
      // Schema HIPOTÉTICO antigo com a trava: o que a migração existe p/ tolerar.
      legacy.exec(`
        CREATE TABLE crawl_url (
          site TEXT NOT NULL,
          url TEXT NOT NULL,
          lastmod TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'movie',
          status TEXT NOT NULL CHECK (status IN ('pending','inflight','done','no-torrent','no-work','error')),
          imdb TEXT,
          tries INTEGER NOT NULL DEFAULT 0,
          next_at INTEGER NOT NULL DEFAULT 0,
          checked_at INTEGER NOT NULL DEFAULT 0,
          releases INTEGER NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '',
          added_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (site, url)
        );
        CREATE TABLE crawl_run (
          id INTEGER PRIMARY KEY,
          site TEXT NOT NULL,
          phase TEXT NOT NULL DEFAULT 'initial',
          cursor TEXT NOT NULL DEFAULT '',
          started_at INTEGER NOT NULL DEFAULT 0,
          finished_at INTEGER,
          counters TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE crawl_state (
          site TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (site, key)
        );
      `);
      legacy.prepare(
        'INSERT INTO crawl_url (site, url, lastmod, kind, status, imdb, releases, checked_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('fake', '/a', '2026-01-01', 'movie', 'done', 'tt1', 4, 123, 1);
      legacy.prepare(
        'INSERT INTO crawl_url (site, url, lastmod, kind, status, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('fake', '/b', '2026-01-01', 'movie', 'pending', 2);
      legacy.prepare(
        'INSERT INTO crawl_run (id, site, phase, cursor, started_at, counters) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(1, 'fake', 'initial', '2026-01-01', 10, '{}');
      legacy.prepare('INSERT INTO crawl_state (site, key, value, updated_at) VALUES (?, ?, ?, ?)').run('fake', 'cursor', '2026-01-01', 10);
      legacy.close();

      // A CHECK antiga rejeitaria o status novo:
      const probe = new DatabaseSync(dbPath);
      assert.throws(() => {
        probe.prepare('UPDATE crawl_url SET status = ? WHERE url = ?').run('simulated', '/a');
      }, /CHECK/i, 'pré-requisito: a CHECK legada não aceita simulated');
      probe.close();

      store.resetForTests();
      store.open(dbPath);
      const e = store.engine();
      assert.equal(e.kind, 'sql', 'SQLite segue ativo após a migração');
      // Linhas preservadas:
      assert.equal(e.getUrl('fake', '/a')?.status, 'done');
      assert.equal(e.getUrl('fake', '/a')?.releases, 4);
      assert.equal(e.getUrl('fake', '/b')?.status, 'pending');
      assert.equal(e.latestRun('fake')?.cursor, '2026-01-01');
      assert.equal(e.getState('fake', 'cursor'), '2026-01-01');
      // E agora o status novo grava sem violar constraint:
      e.markResult('fake', '/b', { status: 'simulated', imdb: 'tt2', releases: 1 }, 500);
      assert.equal(e.getUrl('fake', '/b')?.status, 'simulated');
      store.resetForTests();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('crawl.db SEM CHECK (schema real) abre sem migração', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-ok-'));
    const dbPath = path.join(dir, 'crawl.db');
    try {
      store.resetForTests();
      store.open(dbPath);
      store.engine().upsertUrls('fake', [movie('/a')], 1);
      store.engine().markResult('fake', '/a', { status: 'simulated', imdb: 'tt1', releases: 2 }, 100);
      assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
      store.close(); // fecha SEM limpar (resetForTests zebra por desenho)
      store.open(dbPath);
      // Reabrir o MESMO arquivo: idempotente e o estado sobrevive.
      assert.equal(store.engine().kind, 'sql');
      assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
      store.resetForTests();
    } finally {
      // Windows pode segurar o handle do WAL um instante: limpeza best-effort.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /*tmp*/ }
    }
  });
});
