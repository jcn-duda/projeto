// B2 — flip dry→live × contagem de releases SECAS (2026-09-27): o passe seco
// só DESCOBRE releases (nada é gravado no acervo), então o flip que
// reenfileira as linhas contaminadas deve ZERAR a contagem — senão o passe ao
// vivo re-acumula o real sobre o seco e o painel soma seco+vivo. E a fatia
// final seca COM releases preserva acumulado+fatia no `simulated`. Extraído de
// `crawl-series-resume.test.ts` pela catraca de linhas. Sem rede: store em
// memória + dublês.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const store = await import('../src/utils/crawl-store.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
import type { CrawlSite, CrawlUrlRow, CrawlWorkResult, SeriesWorkProgress } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const SHOW = 'https://site.example/pt/tv-shows/one-piece/';

const rel = (hash: string): RawItem => ({
  title: 'One Piece (1999) S01E01 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
  indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1,
});

const partialResult = (over: Partial<CrawlWorkResult> = {}, progress: SeriesWorkProgress | null = {
  v: 1, doneCards: ['/c1', '/c2'], totalCards: 4,
}): CrawlWorkResult => ({
  url: SHOW, status: 'partial', imdb: 'tt1', title: 'One Piece', year: 1999, type: 'series',
  groups: [{ season: 1, episode: 1, releases: [rel('a1'.repeat(20))] }],
  error: 'series_truncated: teto de série atingido (cards 2/4, botões 40/40)',
  progress: progress ?? undefined, requestCost: 9,
  ...over,
});

function partialSite(over: Partial<CrawlWorkResult> = {}, progress?: SeriesWorkProgress | null): CrawlSite {
  return {
    id: 'fake', label: 'Fake',
    discover: async () => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url) => partialResult({ url, ...over }, progress),
  };
}

const collabs = {
  identify: async (): Promise<import('../src/providers/crawl-identify.js').IdentifyResult> =>
    ({ outcome: 'identified', imdb: 'tt1', reason: 'ok' }),
  record: async (): Promise<import('../src/providers/crawl-recorder.js').RecordReport> =>
    ({ kept: 0, added: 0, transition: 'none', cleared: 0 }),
};

function claimedRow(): CrawlUrlRow {
  store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: '2026-01-01', kind: 'tv_show' }], 1);
  return store.engine().takeNext('fake', 1) as CrawlUrlRow;
}

const nextSlice = (): CrawlUrlRow => {
  store.engine().requeueUrl('fake', SHOW);
  return store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
};

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
});

after(() => {
  store.resetForTests();
});

describe('B2: flip dry→live não soma descoberta seca com a gravação real', () => {
  test('multi-passa 2 fatias secas ⅎ flip zera releases ⅎ passe ao vivo soma o real', async () => {
    let recorded = 0;
    const process = createPageProcessor({
      identify: collabs.identify,
      record: async () => { recorded += 1; return { kept: 0, added: 0, transition: 'none', cleared: 0 }; },
    });
    const slice2: SeriesWorkProgress = { v: 1, doneCards: ['/c1', '/c2', '/c3'], totalCards: 4 };
    // Duas fatias secas com 1 descoberta cada ⅎ acumulado seco 2.
    await process(partialSite(), claimedRow(), { dryRun: true });
    await process(partialSite(undefined, slice2), nextSlice(), { dryRun: true });
    assert.equal((store.engine().getUrl('fake', SHOW) as CrawlUrlRow).releases, 2);
    // Flip: linha volta limpa, contagem seca ZERADA.
    assert.equal(store.engine().requeueSimulated('fake'), 1);
    const flipped = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(flipped.status, 'pending');
    assert.equal(flipped.releases, 0, 'descoberta seca não vira soma no painel');
    assert.equal(flipped.progress, '');
    // Passe ao vivo: as mesmas duas fatias re-gravam e re-acumulam o real.
    await process(partialSite(), flipped, { dryRun: false });
    await process(partialSite(undefined, slice2), nextSlice(), { dryRun: false });
    assert.equal((store.engine().getUrl('fake', SHOW) as CrawlUrlRow).releases, 2, 'acumulado ao vivo real (não 4)');
    assert.equal(recorded, 2, 'só o passe ao vivo grava');
    // Painel: a soma do site é o total REAL da série.
    assert.equal(store.engine().sumReleases('fake'), 2);
  });

  test('fatia final dry COM releases ⅎ simulated com acumulado+fatia (não só a última)', async () => {
    const process = createPageProcessor(collabs);
    // Fatia 1 (dry): 1 release ⅎ partial seco com acumulado 1.
    await process(partialSite(), claimedRow(), { dryRun: true });
    assert.equal((store.engine().getUrl('fake', SHOW) as CrawlUrlRow).releases, 1);
    // Fatia final (dry): done COM 2 releases nos groups (resume concluiu lendo).
    const finalSite: CrawlSite = {
      id: 'fake', label: 'Fake',
      discover: async () => ({ urls: [], complete: true, failures: [] }),
      fetchWork: async (url: string) => ({
        url, status: 'done' as const, imdb: 'tt1', title: 'One Piece', year: 1999,
        type: 'series' as const, requestCost: 2,
        groups: [{ season: 1, episode: 2, releases: [rel('b1'.repeat(20)), rel('c1'.repeat(20))] }],
      }),
    };
    const out = await process(finalSite, nextSlice(), { dryRun: true });
    assert.equal(out.kind, 'simulated');
    const after = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after.status, 'simulated');
    assert.equal(after.releases, 3, 'acumulado (1) + fatia final (2), não só a última fatia');
    assert.equal(store.engine().sumReleases('fake'), 3);
  });
});
