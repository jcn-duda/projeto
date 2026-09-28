// Política de pausa, processador de página e recorder da raspagem (Fase 3).
// Separado de `crawler.test.ts` pela catraca de 400 linhas: aqui ficam os
// módulos que NÃO precisam do motor — pura política, identificação injetada e
// o fio da gravação real (fábrica com dublês).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const { createCrawlRecorder } = await import('../src/providers/crawl-recorder.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
const { isSiteLevelError, maxLastmod, CrawlPausePolicy } =
  await import('../src/providers/crawl-pauses.js');
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, { enabled: true, dryRun: true, sites: ['fake'] });
});

after(() => {
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

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

describe('crawl-pauses: política pura', () => {
  test('isSiteLevelError reconhece 403/429/5xx/blocked_host/challenge; timeout não', () => {
    for (const text of ['HTTP 403', 'erro 429', 'HTTP 503', 'blocked_host:evil.example', 'Just a moment... Cloudflare challenge']) {
      assert.equal(isSiteLevelError(text), true, text);
    }
    for (const text of ['socket hang up', 'layout: página sem h1', 'parse falhou']) {
      assert.equal(isSiteLevelError(text), false, text);
    }
  });

  test('maxLastmod escolhe o maior legível e ignora o vazio', () => {
    assert.equal(maxLastmod([{ lastmod: '2026-01-01' }, { lastmod: '2026-02-01' }, { lastmod: '' }]), '2026-02-01');
    assert.equal(maxLastmod([]), '');
  });

  test('CrawlPausePolicy: canário só após torrent prévio; success zera streaks', () => {
    const policy = new CrawlPausePolicy();
    const limits = { errorPauseStreak: 3, layoutCanary: 2 };
    assert.equal(policy.observePage('/a', { kind: 'no-torrent' }, limits), null, 'sem torrent prévio não é evento');
    assert.equal(policy.observePage('/a', { kind: 'done', releases: 2 }, limits), null);
    assert.equal(policy.observePage('/a', { kind: 'no-torrent' }, limits), null, '1º evento');
    assert.equal(policy.observePage('/a', { kind: 'no-torrent' }, limits), 'layout', '2º evento pausa');
  });
});

describe('crawl-page: identificação (Vaca + crawl-identify)', () => {
  test('done sem IMDb ancora via identifyWork; unavailable→erro; unidentified→no-work', async () => {
    store.engine().upsertUrls('fake', [movie('/id'), movie('/un'), movie('/none')], 1);
    const site = fakeSite({
      fetchWork: async (url) => ({
        url, status: 'done', imdb: null,
        title: url.includes('id') ? 'ID' : url.includes('un') ? 'UNAVAIL' : 'NONE',
        year: 2000, type: 'movie', releases: [item(url)],
      }),
    });
    const identify = async ({ title }: { title: string }) => {
      if (title === 'ID') return { outcome: 'identified' as const, imdb: 'tt999', reason: 'casamento-unico' };
      if (title === 'UNAVAIL') return { outcome: 'unavailable' as const, imdb: null, reason: 'tmdb-indisponivel' };
      return { outcome: 'unidentified' as const, imdb: null, reason: 'nome-sem-casamento' };
    };
    const process = createPageProcessor({ identify });
    const outId = await process(site, store.engine().getUrl('fake', '/id') as CrawlUrlRow);
    // config dryRun=true default do teste: página lida fica `simulated` (com a
    // obra identificada preservada), nunca `done` — nada foi gravado.
    assert.equal(outId.kind, 'simulated');
    assert.equal(store.engine().getUrl('fake', '/id')?.status, 'simulated');
    assert.equal(store.engine().getUrl('fake', '/id')?.imdb, 'tt999');
    const outUn = await process(site, store.engine().getUrl('fake', '/un') as CrawlUrlRow);
    assert.equal(outUn.kind, 'error');
    assert.equal(store.engine().getUrl('fake', '/un')?.status, 'error');
    const outNone = await process(site, store.engine().getUrl('fake', '/none') as CrawlUrlRow);
    assert.equal(outNone.kind, 'no-work');
    assert.equal(store.engine().getUrl('fake', '/none')?.status, 'no-work');
  });

  test('no-torrent não gasta identificação e vira no-torrent', async () => {
    let identified = 0;
    const process = createPageProcessor({
      identify: async () => { identified += 1; return { outcome: 'unidentified', imdb: null, reason: 'x' }; },
    });
    store.engine().upsertUrls('fake', [movie('/s')], 1);
    const site = fakeSite({
      fetchWork: async (url) => ({ url, status: 'no-torrent', imdb: null, title: 'Só streaming', year: 2000, type: 'movie' }),
    });
    const out = await process(site, store.engine().getUrl('fake', '/s') as CrawlUrlRow);
    assert.equal(out.kind, 'no-torrent');
    assert.equal(identified, 0, 'página sem magnet não consulta o TMDB');
  });
});

describe('crawl-recorder: gravação real reusa o fluxo existente', () => {
  const context = { names: ['Expresso do Amanhã'], year: 2013, isSeries: false, season: null, episode: null };
  const releases = [item('/a', 'Expresso do Amanhã'), item('/b', 'Expresso do Amanhã')]
    .map((rel) => ({ ...rel, title: 'Expresso do Amanhã (2013) 1080p DUBLADO' }));

  test('captura atômica → flush → índice com partial em obra nova', async () => {
    const calls: Record<string, unknown> = {};
    let flushed = 0;
    const recorder = createCrawlRecorder({
      buildContext: async () => context,
      captureAndMark: (entered, survivors, indexer, ctx) => {
        calls.batch = [entered.length, survivors.length, indexer, ctx];
        return true;
      },
      flush: () => { flushed += 1; return { ok: true, written: 2 }; },
      lookupQuiet: () => [],
      isPartial: () => false,
      record: (imdb, _loc, items, opts) => { calls.record = [imdb, items.length, opts.partial, opts.keepPartial]; return 3; },
      transition: () => 'none',
      invalidate: () => 0,
      count: () => {},
    });
    const report = await recorder.record('vacatorrent', { imdb: 'tt1', title: 'T', year: 2013, kind: 'movie' }, releases);
    assert.deepEqual(
      (calls.batch as unknown[]).slice(0, 1).concat((calls.batch as unknown[]).slice(2)),
      [2, 'vacatorrent', { imdbId: 'tt1', season: null, episode: null, year: 2013 }],
    );
    assert.ok(((calls.batch as number[])[1]) >= 1, 'o filtro deixou passar a obra certa');
    assert.equal(flushed, 1, 'a barreira de persistência é chamada antes do índice');
    assert.equal((calls.record as unknown[])[0], 'tt1');
    assert.equal((calls.record as unknown[])[2], true, 'obra nova nasce partial');
    assert.equal((calls.record as unknown[])[3], true, 'escrita usa keepPartial (não rebaixa)');
    assert.equal(report.added, 3);
  });

  test('preserva partial do registro existente e invalida na transição BR', async () => {
    let partial: unknown;
    let keep: unknown;
    let invalidated = 0;
    const recorder = createCrawlRecorder({
      buildContext: async () => context,
      captureAndMark: () => true,
      flush: () => ({ ok: true, written: 0 }),
      lookupQuiet: () => [{ hash: 'x' }],
      isPartial: () => true,
      record: (_i, _l, _it, opts) => { partial = opts.partial; keep = opts.keepPartial; return 1; },
      transition: () => 'br',
      invalidate: () => { invalidated += 1; return 2; },
      count: () => {},
    });
    const report = await recorder.record('vacatorrent', { imdb: 'tt1', title: 'T', year: 2013, kind: 'movie' }, releases);
    assert.equal(partial, true, 'partial existente preservado');
    assert.equal(keep, true);
    assert.equal(report.transition, 'br');
    assert.equal(report.cleared, 2);
    assert.equal(invalidated, 1, 'transição BR invalida as listas prontas');
  });

  test('registro completo existente NÃO volta a partial', async () => {
    let partial: unknown;
    const recorder = createCrawlRecorder({
      buildContext: async () => context,
      captureAndMark: () => true,
      flush: () => ({ ok: true, written: 0 }),
      lookupQuiet: () => [{ hash: 'x' }],
      isPartial: () => false,
      record: (_i, _l, _it, opts) => { partial = opts.partial; return 0; },
      transition: () => 'none', invalidate: () => 0, count: () => {},
    });
    await recorder.record('vacatorrent', { imdb: 'tt1', title: 'T', year: 2013, kind: 'movie' }, releases);
    assert.equal(partial, false);
  });

  test('falha do flush aborta com erro retentável e NÃO grava no índice', async () => {
    let recorded = 0;
    const counted: string[] = [];
    const recorder = createCrawlRecorder({
      buildContext: async () => context,
      captureAndMark: () => true,
      flush: () => ({ ok: false, written: 0 }),
      lookupQuiet: () => [],
      isPartial: () => false,
      record: () => { recorded += 1; return 1; },
      transition: () => 'none', invalidate: () => 0,
      count: (name) => { counted.push(name); },
    });
    await assert.rejects(
      () => recorder.record('vacatorrent', { imdb: 'tt1', title: 'T', year: 2013, kind: 'movie' }, releases),
      /magnetbank-flush-falhou/,
    );
    assert.equal(recorded, 0, 'flush falho não chega ao índice');
    assert.ok(counted.includes('crawl.record.flushFailed'), 'métrica própria de falha do flush');
  });

  test('sem nomes de catálogo a gravação é recusada (não contamina o índice)', async () => {
    const recorder = createCrawlRecorder({
      buildContext: async () => null,
      captureAndMark: () => { throw new Error('não deveria capturar'); },
    });
    await assert.rejects(
      () => recorder.record('vacatorrent', { imdb: 'tt1', title: 'T', year: 2013, kind: 'movie' }, releases),
      /catalogo-sem-nomes/,
    );
  });
});
