// Descoberta incremental do Mico (2026-10-06). A varredura completa custava
// ~50 min na VPS e rodava a cada rodada de 60 min: o site passava o tempo
// redescobrindo e a fila de séries não andava. Agora a completa roda no máximo
// a cada `MICO_CRAWL_FULL_SWEEP_HOURS`, e entre elas a rodada lê do topo e para
// em páginas seguidas só com obras já na fila. Só a completa move o cursor.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const micoCrawl = await import('../src/providers/crawl-sites/mico.js');
const crawlStore = await import('../src/utils/crawl-store.js');
const { stubFetch } = await import('./helpers/stub.js');

const savedMico = { ...config.mico };

beforeEach(() => {
  crawlStore.resetForTests();
  crawlStore.open(undefined, { forceMemory: true });
  config.mico.enabled = true;
  config.mico.crawlMinGapMs = 0;
  config.mico.crawlEmptyRetries = 0;
  config.mico.crawlEndAfterEmpties = 1;
  config.mico.crawlKnownPagesToStop = 2;
  config.mico.crawlFullSweepHours = 24;
  micoCrawl._resetThrottleForTest();
});

after(() => {
  Object.assign(config.mico, savedMico);
  micoCrawl._resetThrottleForTest();
  crawlStore.resetForTests();
});

/** Catálogo de filmes: `pages[i]` é a lista de tt no skip i*25 (passo fixo abaixo de 1000). */
function catalogStub(pages: string[][]) {
  const skips: number[] = [];
  const stub = stubFetch((url) => {
    const m = /\/catalog\/movie\/MicoFilmes\/skip=(\d+)\.json/.exec(url);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    const skip = Number(m[1]);
    skips.push(skip);
    const ids = pages[skip / 25] ?? [];
    return { ok: true, status: 200, json: async () => ({ metas: ids.map((id) => ({ id })) }) };
  });
  return { skips, restore: () => stub.restore() };
}

const page = (start: number) => Array.from({ length: 5 }, (_, i) => `tt${1_000_000 + start + i}`);
const CATALOG = [page(0), page(10), page(20), page(30), page(40), page(50)];

function enqueue(urls: Array<{ url: string; lastmod: string; kind: 'movie' | 'tv_show' }>): void {
  crawlStore.engine().upsertUrls('mico', urls, Date.now());
}

describe('Mico: descoberta incremental', () => {
  test('1ª rodada é completa: lê até o fim e move o cursor', async () => {
    const { skips, restore } = catalogStub(CATALOG);
    try {
      const found = await micoCrawl.createMicoCrawlSite().discover(null);
      assert.equal(found.urls.length, 30);
      assert.equal(found.complete, true);
      assert.deepEqual(found.completeByKind, { movie: true, tv_show: true });
      assert.equal(skips.length, 7, '6 páginas com obra + 1 vazia que marca o fim');
    } finally { restore(); }
  });

  test('rodada seguinte é incremental: para em 2 páginas conhecidas, sem mover o cursor', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    let stub = catalogStub(CATALOG);
    try { enqueue((await site.discover(null)).urls); } finally { stub.restore(); }
    stub = catalogStub([page(100), ...CATALOG]);
    try {
      const found = await site.discover(null);
      assert.deepEqual(stub.skips, [0, 25, 50], 'obra nova no topo + 2 páginas conhecidas');
      assert.equal(found.urls.filter((u) => u.url.includes('tt1000100')).length, 1, 'a obra nova entra');
      assert.equal(found.complete, true, 'parada na âncora não é descoberta parcial (sem retry curto)');
      assert.deepEqual(found.completeByKind, { movie: false, tv_show: true }, 'incremental não move o cursor');
    } finally { stub.restore(); }
  });

  test('passado o intervalo, a varredura completa volta', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    let stub = catalogStub(CATALOG);
    try { enqueue((await site.discover(null)).urls); } finally { stub.restore(); }
    crawlStore.engine().setState('mico', 'full-sweep:movie', String(Date.now() - 25 * 3_600_000));
    stub = catalogStub(CATALOG);
    try {
      const found = await site.discover(null);
      assert.equal(stub.skips.length, 7, 'leu o catálogo inteiro de novo');
      assert.equal(found.completeByKind?.movie, true);
    } finally { stub.restore(); }
  });

  test('varredura completa truncada pelo teto não grava a data (a próxima tenta de novo)', async () => {
    config.mico.crawlMaxPages = 3;
    const { restore } = catalogStub(CATALOG);
    try {
      const found = await micoCrawl.createMicoCrawlSite().discover(null);
      assert.equal(found.complete, false);
      assert.equal(crawlStore.engine().getState('mico', 'full-sweep:movie'), null);
    } finally { restore(); config.mico.crawlMaxPages = savedMico.crawlMaxPages; }
  });

  test('fila zerada com a data recente: a incremental não acha âncora e lê tudo', async () => {
    crawlStore.engine().setState('mico', 'full-sweep:movie', String(Date.now()));
    const { skips, restore } = catalogStub(CATALOG);
    try {
      const found = await micoCrawl.createMicoCrawlSite().discover(null);
      assert.equal(found.urls.length, 30, 'nada conhecido: nenhuma parada antecipada');
      assert.equal(skips.length, 7);
    } finally { restore(); }
  });
});
