// Fase 7 v2 ‐ Parte B: semântica do status `partial` no crawl-page, no store e
// no flip do dry-run. Séries longas (One Piece/TWD) convergem em passes com
// progresso monotônico; estagnação vira `error series_stall`; o progresso SECO
// é resetado quando o dry-run desliga. Sem rede: store em memória + dublês.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const store = await import('../src/utils/crawl-store.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
const crawler = await import('../src/providers/crawler.js');
const crawlerLive = await import('../src/utils/crawler-live.js');
const config = (await import('../src/config.js')).default;
import { parseProgress, progressAdvanced, renderProgress, withDryFlag } from '../src/utils/crawl-store-rules.js';
import type { CrawlSite, CrawlUrlRow, CrawlWorkResult, SeriesWorkProgress } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const SHOW = 'https://site.example/pt/tv-shows/one-piece/';
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

/** Site dublê cujo `fetchWork` devolve `over` (partial por default). */
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

function claimedRow(url = SHOW, kind: 'tv_show' | 'movie' = 'tv_show'): CrawlUrlRow {
  store.engine().upsertUrls('fake', [{ url, lastmod: '2026-01-01', kind }], 1);
  return store.engine().takeNext('fake', 1) as CrawlUrlRow;
}

describe('crawl-page: desfecho partial (Fase 7 v2)', () => {
  test('ao vivo com releases: grava os grupos e marca partial com progresso', async () => {
    const recorded: Array<unknown> = [];
    const process = createPageProcessor({
      identify: collabs.identify,
      record: async (_s, _o, releases, location) => {
        recorded.push({ location, items: releases.length });
        return { kept: 0, added: releases.length, transition: 'none', cleared: 0 };
      },
    });
    const outcome = await process(partialSite(), claimedRow(), { dryRun: false });
    assert.equal(outcome.kind, 'partial');
    assert.equal(outcome.releases, 1);
    assert.equal(outcome.addedNew, 1);
    assert.equal(outcome.requestCost, 9);
    assert.deepEqual(recorded, [{ location: { season: 1, episode: 1 }, items: 1 }], 'grava ANTES de marcar');
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'partial');
    assert.equal(row.releases, 1);
    assert.equal(parseProgress(row.progress)?.doneCards.length, 2);
    assert.equal(row.tries, 0, 'avanço não é falha');
    assert.ok(row.nextAt > Date.now(), 'retry no prazo curto da base');
  });

  test('estouro (progresso igual ao da coluna) ⅎ error series_stall com tries+1', async () => {
    const process = createPageProcessor(collabs);
    const row1 = claimedRow();
    await process(partialSite(), row1, { dryRun: false });
    // Segunda passada devolve O MESMO progresso: nada avançou.
    store.engine().requeueUrl('fake', SHOW);
    const row2 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    assert.equal(row2.status, 'inflight');
    const outcome = await process(partialSite(), row2, { dryRun: false });
    assert.equal(outcome.kind, 'error');
    assert.match(outcome.detail || '', /^series_stall:/);
    const after = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after.status, 'error');
    assert.equal(after.tries, 1, 'estagnação conta como tentativa');
    assert.equal(parseProgress(after.progress)?.doneCards.length, 2, 'progresso ANTERIOR preservado');
  });

  test('gravação lança ⅎ error retentável com progresso anterior intacto', async () => {
    const process = createPageProcessor({
      identify: collabs.identify,
      record: async () => { throw new Error('flush failed'); },
    });
    const outcome = await process(partialSite(), claimedRow(), { dryRun: false });
    assert.equal(outcome.kind, 'error');
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'error');
    assert.equal(row.progress, '', 'sem progresso anterior, nada é marcado como avançado');
  });

  test('dry-run: partial com dry:1, record NUNCA chamado; descobertas ACUMULAM (contador, sem acervo)', async () => {
    let recorded = 0;
    const process = createPageProcessor({
      identify: collabs.identify,
      record: async () => { recorded += 1; return { kept: 0, added: 0, transition: 'none', cleared: 0 }; },
    });
    const outcome = await process(partialSite(), claimedRow(), { dryRun: true });
    assert.equal(outcome.kind, 'partial');
    assert.equal(recorded, 0, 'dry nunca grava');
    assert.equal(outcome.releases, 1, 'descoberta é reportada');
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'partial');
    assert.equal(parseProgress(row.progress)?.dry, 1, 'flag seco é o que o flip reseta');
    assert.equal(row.releases, 1, 'contador DISCOBERTA acumula no dry (sem acervo; B1 pós-v2)');
  });

  test('TMDB indisponível no partial com releases ⅎ error preservando progresso', async () => {
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'unavailable', imdb: null, reason: 'timeout' }),
      record: collabs.record,
    });
    const outcome = await process(partialSite({ imdb: null }), claimedRow(), { dryRun: false });
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.requestCost, 9);
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'error');
    assert.equal(row.progress, '');
  });

  test('obra não identificada no partial ⅎ no-work terminal (progresso limpo)', async () => {
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'unidentified', imdb: null, reason: 'ambiguous' }),
      record: collabs.record,
    });
    const outcome = await process(partialSite({ imdb: null }), claimedRow(), { dryRun: false });
    assert.equal(outcome.kind, 'no-work');
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'no-work');
  });

  test('partial com 0 releases: só progresso (sem TMDB, sem no-torrent)', async () => {
    let identified = 0;
    const process = createPageProcessor({
      identify: async () => { identified += 1; return { outcome: 'identified', imdb: 'tt1', reason: 'ok' }; },
      record: collabs.record,
    });
    const outcome = await process(
      partialSite({ groups: [] }),
      claimedRow(),
      { dryRun: false },
    );
    assert.equal(outcome.kind, 'partial');
    assert.equal(identified, 0, 'identificar sem release gasta TMDB à toa');
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'partial');
    assert.ok(row.progress);
  });

  test('F3: releases ACUMULAM entre fatias; fatia vazia preserva; conclusão herda (e o painel soma o total)', async () => {
    const process = createPageProcessor(collabs);
    // Fatia 1: 1 release ⅎ partial com acumulado 1.
    await process(partialSite(), claimedRow(), { dryRun: false });
    // Fatia 2: vazia ⅎ partial preservando o acumulado.
    store.engine().requeueUrl('fake', SHOW);
    const row2 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const outcome2 = await process(partialSite({ groups: [] }, { v: 1, doneCards: ['/c1', '/c2', '/c3'], totalCards: 4 }), row2, { dryRun: false });
    assert.equal(outcome2.kind, 'partial');
    assert.equal(outcome2.releases, 0);
    const after2 = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after2.releases, 1, 'fatia vazia NÂO zera o acumulado');
    // Fatia 3: +1 release ⅎ acumulado 2.
    store.engine().requeueUrl('fake', SHOW);
    const row3 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    await process(partialSite(undefined, { v: 1, doneCards: ['/c1', '/c2', '/c3', '/c4'], totalCards: 4 }), row3, { dryRun: false });
    const after3 = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after3.releases, 2, 'cada marcação corresponde a fatia nova: acumula');
    // Conclusão por resume (fatia final vazia): done herda o acumulado.
    store.engine().requeueUrl('fake', SHOW);
    const row4 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const doneSite = { id: 'fake', label: 'Fake', discover: async () => ({ urls: [], complete: true, failures: [] }), fetchWork: async (url: string) => ({ url, status: 'done' as const, imdb: 'tt1', title: 'One Piece', year: 1999, type: 'series' as const, requestCost: 2 }) };
    const outcome4 = await process(doneSite, row4, { dryRun: false });
    assert.equal(outcome4.kind, 'done');
    assert.equal(store.engine().getUrl('fake', SHOW)?.releases, 2, 'conclusão preserva a contagem');
    // Painel: a soma do site reflete o total acumulado da série.
    assert.equal(store.engine().sumReleases('fake'), 2);
  });
});

describe('crawl-page: conclusão por resume (fatia vazia não vira no-torrent)', () => {
  const doneSite = (over: Partial<CrawlWorkResult> = {}): CrawlSite => ({
    id: 'fake', label: 'Fake',
    discover: async () => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url) => ({
      url, status: 'done', imdb: 'tt1', title: 'One Piece', year: 1999, type: 'series',
      requestCost: 3, ...over,
    }),
  });

  test('done com 0 releases e progresso na linha ⅎ done preservando contagem', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', SHOW, {
      status: 'partial', imdb: 'tt1', releases: 7, progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 4 }),
    }, 100);
    store.engine().requeueUrl('fake', SHOW);
    const row = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const process = createPageProcessor(collabs);
    const outcome = await process(doneSite(), row, { dryRun: false });
    assert.equal(outcome.kind, 'done');
    const after = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after.status, 'done');
    assert.equal(after.releases, 7, 'contagem da última visita com gravação preservada');
    assert.equal(after.progress, '', 'terminal limpa progresso');
  });

  test('idem em dry-run ⅎ simulated (o flip reenfileira para gravar)', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', SHOW, {
      status: 'partial', imdb: 'tt1', releases: 7, progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 4 }),
    }, 100);
    store.engine().requeueUrl('fake', SHOW);
    const row = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const outcome = await createPageProcessor(collabs)(doneSite(), row, { dryRun: true });
    assert.equal(outcome.kind, 'simulated');
    assert.equal(store.engine().getUrl('fake', SHOW)?.releases, 7);
  });

  test('done com 0 releases SEM progresso continua no-torrent (filme intacto)', async () => {
    const outcome = await createPageProcessor(collabs)(doneSite(), claimedRow('/m', 'movie'), { dryRun: false });
    assert.equal(outcome.kind, 'no-torrent');
  });

  // Bug 2026-09-27 (One Piece): resume com ACUMULADO 0 nunca colheu —
  // `done` mentiria "série colhida". Terminal honesto: no-torrent.
  test('resume com acumulado 0 ⅎ no-torrent (One Piece nunca colheu nada)', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', SHOW, {
      status: 'partial', imdb: 'tt1', releases: 0, progress: renderProgress({ v: 1, doneCards: ['/c1', '/c2'], totalCards: 4 }),
    }, 100);
    store.engine().requeueUrl('fake', SHOW);
    const row = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const outcome = await createPageProcessor(collabs)(doneSite(), row, { dryRun: false });
    assert.equal(outcome.kind, 'no-torrent', 'resume com 0 acumulado NÃO é done');
    const after = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after.status, 'no-torrent');
    assert.equal(after.releases, 0);
  });

  test('dry equivalente coerente: resume com acumulado 0 no dry-run TAMBÉM é no-torrent', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', SHOW, {
      status: 'partial', imdb: 'tt1', releases: 0, progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 4 }),
    }, 100);
    store.engine().requeueUrl('fake', SHOW);
    const row = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const outcome = await createPageProcessor(collabs)(doneSite(), row, { dryRun: true });
    assert.equal(outcome.kind, 'no-torrent', 'no-torrent é terminal nos dois modos — sem divergência dry×vivo');
  });

  // B1 pós-v2 (bug 2026-09-27): série multi-passa INTEIRA em dry-run — as
  // fatias secas DESCOBRIRAM releases (contador na linha) e a fatia final done
  // vem sem groups/releases. `no-torrent` perderia o requeue do flip; o
  // desfecho é `simulated` (estado que o flip dry→live reenfileira), com a
  // prova das fatias secas preservada na contagem — sem fingir gravação.
  test('B1: duas fatias dry (1ª com N, final vazia) ⅎ simulated com descobertas preservadas + flip requeue', async () => {
    let recorded = 0;
    const process = createPageProcessor({
      identify: collabs.identify,
      record: async () => { recorded += 1; return { kept: 0, added: 0, transition: 'none', cleared: 0 }; },
    });
    // Fatia 1 (dry): 1 release descoberta ⅎ partial com dry:1 e acumulado 1.
    const out1 = await process(partialSite(), claimedRow(), { dryRun: true });
    assert.equal(out1.kind, 'partial');
    const mid = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(mid.releases, 1, 'descoberta da fatia seca fica na linha');
    assert.equal(parseProgress(mid.progress)?.dry, 1);
    // Fatia final (dry): done SEM groups/releases — resume concluiu.
    store.engine().requeueUrl('fake', SHOW);
    const row2 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const out2 = await process(doneSite(), row2, { dryRun: true });
    assert.equal(out2.kind, 'simulated', 'resume seco com descobertas NÃO vira no-torrent');
    const after = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after.status, 'simulated');
    assert.equal(after.releases, 1, 'prova das fatias secas preservada (sem fingir gravação)');
    assert.equal(recorded, 0, 'nenhuma gravação no dry');
    // Flip dry→live: simulated (e o progresso seco) voltam à fila para gravar.
    assert.equal(store.engine().requeueSimulated('fake'), 1, 'flip reenfileira');
    const requeued = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.progress, '', 'resume seco NÃO sobrevive: passe ao vivo reprocessa do zero');
  });

  // B2 (flip×releases seca e fatia final com releases): extraído para
  // `crawl-series-flip.test.ts` pela catraca de linhas.
  test('B1: dry verdadeiramente zero (nenhuma descoberta em fatia nenhuma) ⅎ no-torrent', async () => {
    const process = createPageProcessor(collabs);
    // Fatia 1 (dry) SEM releases: partial com acumulado 0.
    const out1 = await process(partialSite({ groups: [] }), claimedRow(), { dryRun: true });
    assert.equal(out1.kind, 'partial');
    assert.equal((store.engine().getUrl('fake', SHOW) as CrawlUrlRow).releases, 0);
    // Fatia final (dry) done vazia: nunca colheu nem em passe seco.
    store.engine().requeueUrl('fake', SHOW);
    const row2 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    const out2 = await process(doneSite(), row2, { dryRun: true });
    assert.equal(out2.kind, 'no-torrent', 'acumulado 0 no dry é o mesmo terminal honesto do vivo');
    assert.equal((store.engine().getUrl('fake', SHOW) as CrawlUrlRow).status, 'no-torrent');
  });

  test('B1: re-visita da MESMA fatia seca ⅎ series_stall e contador SEM duplicar', async () => {
    const process = createPageProcessor(collabs);
    await process(partialSite(), claimedRow(), { dryRun: true });
    store.engine().requeueUrl('fake', SHOW);
    const row2 = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow;
    // MESMO progresso (nada avançou): estouro, não nova fatia.
    const out2 = await process(partialSite(), row2, { dryRun: true });
    assert.equal(out2.kind, 'error');
    assert.match(out2.detail || '', /^series_stall:/);
    const after = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(after.releases, 1, 'stall não soma de novo');
    assert.equal(parseProgress(after.progress)?.dry, 1, 'progresso seco anterior preservado');
  });
});


describe('motor: flip dry-run reset partial seco; simulação não escreve flag', () => {
  test('simulate (noPersist) sobre linha partial ⅎ kind partial e linha intacta', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', SHOW, {
      status: 'partial', progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 4 }),
    }, 100);
    crawler._setSitesForTest(() => partialSite());
    Object.assign(config.crawl, { sites: ['fake'], dryRun: false });
    crawler.start();
    crawler._forceDiscoveryForTest();
    const result = await crawler.simulate(1);
    assert.equal(result.results[0]?.kind, 'partial');
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'pending', 'requeueUrl devolve a linha à fila');
    assert.equal(parseProgress(row.progress)?.dry, undefined, 'noPersist nunca escreve flag seco');
    assert.ok(row.progress.includes('/c1'), 'progresso intacto');
  });

  test('F1/F2 restart já em dryRun=false: recovery ordem segura ‐ inflight órfã e seca de QUALQUER status são resetadas antes do primeiro takeNext', () => {
    store.engine().upsertUrls('fake', [
      { url: '/crash-inflight', lastmod: 'x', kind: 'tv_show' },
      { url: '/crash-error', lastmod: 'x', kind: 'tv_show' },
    ], 1);
    const dry = withDryFlag(renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 }));
    store.engine().markResult('fake', '/crash-inflight', { status: 'partial', progress: dry }, 100);
    store.engine().takeNext('fake', Date.now() + 1); // ⅎ inflight seca (crash)
    store.engine().markResult('fake', '/crash-error', { status: 'partial', progress: dry }, 100);
    store.engine().markResult('fake', '/crash-error', { status: 'error', error: 'http_503' }, 110);

    // Restart do processo JÁ com gravação: start() roda requeueInflight e
    // requeueSimulated ANTES de qualquer takeNext.
    crawler._setSitesForTest(() => partialSite());
    Object.assign(config.crawl, { sites: ['fake'], dryRun: false });
    crawler.start();
    const inflight = store.engine().getUrl('fake', '/crash-inflight') as CrawlUrlRow;
    assert.equal(inflight.status, 'pending', 'inflight seca do crash resetada pelo flip');
    assert.equal(inflight.progress, '');
    const error = store.engine().getUrl('fake', '/crash-error') as CrawlUrlRow;
    assert.equal(error.status, 'pending', 'error seco resetado pelo flip');
    assert.equal(error.progress, '');
    // A fila servida em seguida já é limpa: nada seco sobrevive ao restart.
    const next = store.engine().takeNext('fake', Date.now() + 3_600_000) as CrawlUrlRow | null;
    assert.ok(next, 'fila tem trabalho');
    assert.equal(parseProgress(next.progress)?.dry, undefined, 'nenhum resume seco sobrevive ao flip');
  });
});
