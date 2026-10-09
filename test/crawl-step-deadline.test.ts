// Regressão do vigia do passo (Mico travado ~16h, 2026-10-08): um passo que
// excede `CRAWL_STEP_DEADLINE_MS` NÃO pode segurar a vaga do site para sempre.
// A cerca de posse (`crawl-site-runtime.ts`) invalida a geração; o vigia
// (`crawl-step.ts`, `boundedStep`) marca a linha presa como `error step-timeout`
// (progresso preservado), libera a vaga e o site segue. Escritas TARDIAS de um
// passo expirado (settle OU reject) são descartadas. Sem rede real: dublês e
// deferreds; deadline curto via override de `config.crawl.stepDeadlineMs`.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { STEP_TIMEOUT_REASON } = await import('../src/providers/crawl-site-runtime.js');
import type { CrawlDiscovery } from '../src/providers/crawl-types.js';

const savedCrawl = { ...config.crawl };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HASH = 'a'.repeat(40);
const emptyDiscovery = async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] });
const movie = (url: string) => ({ url, lastmod: '2026-01-01', kind: 'movie' as const });

function done(url: string) {
  return {
    url, status: 'done' as const, imdb: 'tt1000000', title: 'Fake Obra', year: 2000,
    type: 'movie' as const,
    releases: [{
      title: 'Fake Obra (2000) 1080p DUBLADO', infoHash: HASH,
      magnet: `magnet:?xt=urn:btih:${HASH}`, indexer: 'fake', isBr: true, seeders: 1, size: 1000,
    }],
  };
}

function siteWithFetch(fetchWork: (url: string) => Promise<unknown>) {
  return { id: 'fake', label: 'Fake', discover: emptyDiscovery, fetchWork: fetchWork as never };
}

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['fake'], delayMs: 0, maxPerHour: 1000,
    idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10,
    incrementalIntervalMin: 60, stepDeadlineMs: 40,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

test('passo preso: vira error step-timeout (retentável) e o próximo item executa', async () => {
  store.engine().upsertUrls('fake', [movie('/a-stuck'), movie('/z-ok')], 1);
  let releaseStuck!: () => void;
  const stuck = new Promise<void>((resolve) => { releaseStuck = resolve; });
  crawler._setSitesForTest(() => siteWithFetch(async (url) => {
    if (url.endsWith('/a-stuck')) { await stuck; return done(url); }
    return done(url);
  }));

  await crawler.tick(); // descoberta
  await crawler.tick(); // reclama /a-stuck e trava — o vigia dispara

  const stuckRow = store.engine().getUrl('fake', '/a-stuck');
  assert.equal(stuckRow?.status, 'error');
  assert.equal(stuckRow?.error, STEP_TIMEOUT_REASON);
  assert.ok((stuckRow?.nextAt ?? 0) > Date.now(), 'erro precisa de backoff retentável');

  await crawler.tick();
  assert.equal(store.engine().getUrl('fake', '/z-ok')?.status, 'simulated');

  releaseStuck();
  await sleep(20);
  assert.equal(store.engine().getUrl('fake', '/a-stuck')?.status, 'error');
});

test('escrita tardia (reject) após nova geração não altera fila/tries/contadores', async () => {
  store.engine().upsertUrls('fake', [movie('/a-stuck'), movie('/z-ok')], 1);
  let rejectStuck!: (err: Error) => void;
  const stuck = new Promise((_resolve, reject) => { rejectStuck = reject; });
  crawler._setSitesForTest(() => siteWithFetch(async (url) => {
    if (url.endsWith('/a-stuck')) return await stuck;
    return done(url);
  }));

  await crawler.tick(); // descoberta
  await crawler.tick(); // trava; vigia marca error
  const afterTimeout = store.engine().getUrl('fake', '/a-stuck');
  assert.equal(afterTimeout?.error, STEP_TIMEOUT_REASON);
  const triesBefore = afterTimeout?.tries ?? 0;

  await crawler.tick(); // nova geração processa /z-ok
  assert.equal(store.engine().getUrl('fake', '/z-ok')?.status, 'simulated');
  const totalBefore = store.engine().counters('fake').total;

  rejectStuck(new Error('boom tardio'));
  await sleep(20);

  const late = store.engine().getUrl('fake', '/a-stuck');
  assert.equal(late?.status, 'error');
  assert.equal(late?.error, STEP_TIMEOUT_REASON, 'reject tardio não pode sobrescrever o motivo');
  assert.equal(late?.tries, triesBefore, 'reject tardio não pode incrementar tries');
  assert.equal(store.engine().counters('fake').total, totalBefore, 'reject tardio não pode criar linha');
});

test('sucesso dentro do budget não dispara timeout espúrio', async () => {
  config.crawl.stepDeadlineMs = 500;
  store.engine().upsertUrls('fake', [movie('/a-ok')], 1);
  crawler._setSitesForTest(() => siteWithFetch(async (url) => done(url)));

  await crawler.tick(); // descoberta
  await crawler.tick(); // página (rápida)

  const row = store.engine().getUrl('fake', '/a-ok');
  assert.equal(row?.status, 'simulated');
  assert.equal(row?.error, '');
});

test('partial resume: 40/49 doneCards preservados sem reset nem duplicação', async () => {
  store.engine().upsertUrls('fake', [movie('/a-stuck')], 1);
  const doneCards = Array.from({ length: 40 }, (_unused, i) => `1:${i + 1}`);
  const progress = JSON.stringify({ v: 1, doneCards, totalCards: 49 });
  store.engine().markResult(
    'fake', '/a-stuck',
    { status: 'partial', imdb: 'tt1000000', releases: 37, error: 'series_truncated', progress },
    Date.now(),
    { retryBaseMs: 0 },
  );
  crawler._setSitesForTest(() => siteWithFetch(async () => new Promise(() => {})));

  await crawler.tick(); // descoberta
  await crawler.tick(); // reclama a partial e trava — vigia

  const row = store.engine().getUrl('fake', '/a-stuck');
  assert.equal(row?.status, 'error');
  assert.equal(row?.error, STEP_TIMEOUT_REASON);
  const parsed = JSON.parse(String(row?.progress)) as { v: number; doneCards: string[]; totalCards: number };
  assert.equal(parsed.doneCards.length, 40, 'não pode resetar nem duplicar os cards feitos');
  assert.equal(new Set(parsed.doneCards).size, 40);
  assert.deepEqual(parsed.doneCards, doneCards);
  assert.equal(parsed.totalCards, 49);
  assert.equal(row?.releases, 37, 'contagem acumulada preservada');
});

test('startup recupera inflight órfão preservando o progresso', async () => {
  store.engine().upsertUrls('fake', [movie('/a')], 1);
  const progress = JSON.stringify({ v: 1, doneCards: ['1:1', '1:2'], totalCards: 5 });
  store.engine().markResult('fake', '/a', { status: 'partial', imdb: 'tt1000000', releases: 3, error: 'x', progress }, Date.now(), { retryBaseMs: 0 });
  assert.ok(store.engine().takeNext('fake', Date.now()), 'reivindica a linha');
  assert.equal(store.engine().getUrl('fake', '/a')?.status, 'inflight');

  crawler.start(); // boot: primeSite → requeueInflight

  const row = store.engine().getUrl('fake', '/a');
  assert.equal(row?.status, 'pending');
  assert.equal(row?.progress, progress);
  crawler._resetForTest();
});

test('Zerar site (lifecycle) invalida o passo em voo — não re-semeia a fila', async () => {
  config.crawl.stepDeadlineMs = 5000; // o vigia não deve disparar durante o reset
  store.engine().upsertUrls('fake', [movie('/a-stuck')], 1);
  let releaseStuck!: () => void;
  const stuck = new Promise<void>((resolve) => { releaseStuck = resolve; });
  crawler._setSitesForTest(() => siteWithFetch(async (url) => { await stuck; return done(url); }));

  await crawler.tick(); // descoberta
  const pageTick = crawler.tick(); // trava em /a-stuck
  for (let i = 0; i < 50 && store.engine().getUrl('fake', '/a-stuck')?.status !== 'inflight'; i += 1) await sleep(5);
  assert.equal(store.engine().getUrl('fake', '/a-stuck')?.status, 'inflight');

  const reset = crawler.resetSite('fake');
  assert.equal(reset.ok, true);
  assert.equal(store.engine().counters('fake').total, 0);

  releaseStuck();
  await pageTick; // passo velho termina, já com a cerca fechada
  assert.equal(store.engine().counters('fake').total, 0, 'passo invalidado não pode re-semear a fila');
  assert.equal(store.engine().getUrl('fake', '/a-stuck'), null);
});

test('disable/pause: tick não serve e a fila fica intacta', async () => {
  store.engine().upsertUrls('fake', [movie('/a')], 1);
  crawler._setSitesForTest(() => siteWithFetch(async (url) => done(url)));

  config.crawl.enabled = false;
  await crawler.tick();
  assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending');

  config.crawl.enabled = true;
  assert.equal(crawler.setPaused(true, 'fake').ok, true);
  await crawler.tick();
  assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending', 'site pausado não é servido');

  crawler.setPaused(false, 'fake');
  await crawler.tick(); // descoberta
  await crawler.tick(); // página
  assert.equal(store.engine().getUrl('fake', '/a')?.status, 'simulated');
});

test('a cerca chega ao fetchWork: o laço de botões vê o passo expirar', async () => {
  store.engine().upsertUrls('fake', [movie('/a-stuck')], 1);
  const probe: { seen?: () => boolean } = {};
  let releaseStuck!: () => void;
  const stuck = new Promise<void>((resolve) => { releaseStuck = resolve; });
  crawler._setSitesForTest(() => siteWithFetch((async (url: string, opts?: { isAborted?: () => boolean }) => {
    probe.seen = opts?.isAborted;
    await stuck;
    return done(url);
  }) as never));

  await crawler.tick(); // descoberta
  await crawler.tick(); // trava; o vigia invalida a geração
  assert.equal(typeof probe.seen, 'function', 'fetchWork precisa receber isAborted');
  assert.equal(probe.seen?.(), true, 'depois do prazo a cerca responde abortado');
  releaseStuck();
  await sleep(20);
});

test('prazo por site: faixa Flare usa o orçamento próprio, nunca abaixo do global', async () => {
  const { stepDeadlineFor } = await import('../src/providers/crawl-step.js');
  Object.assign(config.crawl, { stepDeadlineMs: 1000, flareStepDeadlineMs: 5000, flareSites: ['flarey'] });
  assert.equal(stepDeadlineFor('fake'), 1000);
  assert.equal(stepDeadlineFor('flarey'), 5000);
  config.crawl.flareStepDeadlineMs = 10;
  assert.equal(stepDeadlineFor('flarey'), 1000, 'Flare abaixo do global sobe ao global');
});
