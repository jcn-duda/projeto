// Regressão do orçamento PRÓPRIO da fase de DESCOBERTA (Mico) e da cerca de
// posse das escritas internas do adaptador (marker `full-sweep`). A descoberta
// completa do Mico lê DOIS catálogos (filme+série, ~50 min cada) — o orçamento
// de LINHA não pode cancelá-la; um passo expirado não pode gravar marker/upsert
// tardio nem pedir páginas novas. Adaptador REAL (`createMicoCrawlSite`) com o
// catálogo JSON dublado; zero rede real.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { createMicoCrawlSite } = await import('../src/providers/crawl-sites/mico.js');
const { _resetThrottleForTest } = await import('../src/providers/crawl-sites/mico-shared.js');
const { CURSOR_STATE_KEY } = await import('../src/providers/crawl-cursor.js');
const { stubFetch } = await import('./helpers/stub.js');

const savedCrawl = { ...config.crawl };
const savedMico = { ...config.mico };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKER = 'full-sweep:movie';

/** Página de catálogo do Mico: `{ metas: [{id}] }`. */
const page = (ids: string[]) => ({ ok: true, status: 200, json: async () => ({ metas: ids.map((id) => ({ id })) }) });
const nonCatalog = { ok: true, status: 200, json: async () => ({}) };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  _resetThrottleForTest();
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['mico'], delayMs: 0, maxPerHour: 1000,
    idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10,
    incrementalIntervalMin: 60, seriesEnabled: false,
    stepDeadlineMs: 40, discoveryDeadlineMs: 2000,
  });
  Object.assign(config.mico, {
    crawlMinGapMs: 0, crawlEmptyRetries: 0, crawlEndAfterEmpties: 1, crawlMaxPages: 10,
    crawlFullSweepHours: 24, timeout: 15_000,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
  Object.assign(config.mico, savedMico);
});

/** Injeta o adaptador Mico REAL via fábrica (sem tocar a rede do site). */
function micoReal(): void {
  crawler._setSitesForTest((id) => (id === 'mico' ? createMicoCrawlSite() : null));
}

test('movie completa mas series pendente: marker de filme SÓ após a fila dos dois kinds', async () => {
  config.crawl.seriesEnabled = true;
  config.crawl.discoveryDeadlineMs = 5000;
  config.crawl.stepDeadlineMs = 40;
  let releaseSeries!: () => void;
  const seriesGate = new Promise<void>((resolve) => { releaseSeries = resolve; });
  const stub = stubFetch(async (url) => {
    if (!url.includes('/catalog/')) return nonCatalog;
    if (url.includes('/catalog/movie/')) return url.includes('skip=0') ? page(['tt0000101']) : page([]);
    if (url.includes('/catalog/series/') && url.includes('skip=0')) { await seriesGate; return page(['tt0000201']); }
    return page([]);
  });
  try {
    micoReal();
    const tick = crawler.tick();
    await sleep(120); // filme terminou; série está pendurada no gate

    assert.equal(store.engine().getState('mico', 'full-sweep:movie'), null,
      'marker de filme NÃO pode adiantar a série');
    assert.equal(store.engine().counters('mico').total, 0, 'nada persistido antes do commit');

    releaseSeries();
    await tick;
    await sleep(20);
    assert.notEqual(store.engine().getState('mico', 'full-sweep:movie'), null, 'marker de filme no commit');
    assert.notEqual(store.engine().getState('mico', 'full-sweep:series'), null, 'marker de série no commit');
    assert.equal(store.engine().counters('mico').total, 2, 'fila dos DOIS kinds persistida antes dos markers');
  } finally {
    stub.restore();
  }
});

test('series expira: nem o marker de filme avança; resolução tardia não grava fila nem marker', async () => {
  config.crawl.seriesEnabled = true;
  config.crawl.discoveryDeadlineMs = 50;
  config.crawl.stepDeadlineMs = 50;
  let releaseSeries!: () => void;
  const seriesGate = new Promise<void>((resolve) => { releaseSeries = resolve; });
  const stub = stubFetch(async (url) => {
    if (!url.includes('/catalog/')) return nonCatalog;
    if (url.includes('/catalog/movie/')) return url.includes('skip=0') ? page(['tt0000101']) : page([]);
    if (url.includes('/catalog/series/') && url.includes('skip=0')) { await seriesGate; return page(['tt0000201']); }
    return page([]);
  });
  try {
    micoReal();
    await crawler.tick(); // o vigia expira enquanto a série está pendurada

    assert.equal(store.engine().getState('mico', 'full-sweep:movie'), null, 'filme não pode ter gravado marker');
    assert.equal(store.engine().counters('mico').total, 0);

    releaseSeries(); // resolução TARDIA, cerca fechada
    await sleep(60);
    assert.equal(store.engine().getState('mico', 'full-sweep:movie'), null, 'resolução tardia não grava marker de filme');
    assert.equal(store.engine().getState('mico', 'full-sweep:series'), null);
    assert.equal(store.engine().counters('mico').total, 0, 'resolução tardia não grava fila');
  } finally {
    stub.restore();
  }
});

test('descoberta COMPLETA que expira no meio: sem marker, sem upsert, sem cursor, retenta', async () => {
  config.crawl.discoveryDeadlineMs = 50;
  config.crawl.stepDeadlineMs = 50;
  const stub = stubFetch(async (url) => {
    if (!url.includes('/catalog/')) return nonCatalog;
    if (url.includes('skip=0')) return page(['tt0000001']); // 1ª página: obras
    await sleep(200);                                        // 2ª página termina DEPOIS do prazo
    return page([]);                                         // ...e ainda fecha a varredura (sawEnd)
  });
  try {
    micoReal();
    await crawler.tick();
    await sleep(320); // deixa o adaptador tardio terminar (já com a cerca fechada)

    assert.equal(store.engine().getState('mico', MARKER), null, 'marker full-sweep não pode ser escrito');
    assert.equal(store.engine().getState('mico', CURSOR_STATE_KEY.movie), null, 'cursor não pode andar');
    assert.equal(store.engine().counters('mico').total, 0, 'nenhuma URL pode ser enfileirada (upsert tardio)');

    const callsBefore = stub.calls.length;
    await crawler.tick(); // a vaga foi liberada e a descoberta é retentável
    await sleep(20);
    assert.ok(stub.calls.length > callsBefore, 'próxima rodada tenta a descoberta de novo');
  } finally {
    stub.restore();
  }
});

test('descoberta saudável que dura mais que o orçamento de LINHA termina OK', async () => {
  config.crawl.stepDeadlineMs = 40;       // curto de propósito
  config.crawl.discoveryDeadlineMs = 2000;
  const stub = stubFetch(async (url) => {
    if (!url.includes('/catalog/')) return nonCatalog;
    await sleep(80); // 2 páginas × 80 ms ≈ 160 ms > 40 ms de linha
    return url.includes('skip=0') ? page(['tt0000001']) : page([]);
  });
  try {
    micoReal();
    await crawler.tick();
    await sleep(20);

    assert.notEqual(store.engine().getState('mico', MARKER), null, 'full sweep completa grava o marker');
    assert.ok(store.engine().counters('mico').total >= 1, 'a URL foi enfileirada');
    assert.equal(store.engine().getUrl('mico', `${config.mico.url}/crawl/movie/tt0000001/`)?.status, 'pending');
  } finally {
    stub.restore();
  }
});

test('descoberta pendurada excede o orçamento PRÓPRIO e a vaga é liberada (retentável)', async () => {
  config.crawl.discoveryDeadlineMs = 60;
  const stub = stubFetch((url) => (url.includes('/catalog/') ? new Promise<never>(() => {}) : nonCatalog));
  try {
    micoReal();
    await crawler.tick(); // o vigia dispara aos 60 ms mesmo com o await pendurado
    assert.equal(store.engine().getState('mico', MARKER), null);

    const callsBefore = stub.calls.length;
    await crawler.tick(); // retry imediato: nextDiscoverAt rearmado
    await sleep(20);
    assert.ok(stub.calls.length > callsBefore, 'a vaga foi liberada e a descoberta retenta');
  } finally {
    stub.restore();
  }
});

test('descoberta invalidada PARA de pedir páginas novas (cooperativo)', async () => {
  config.crawl.discoveryDeadlineMs = 50;
  const calls: string[] = [];
  const stub = stubFetch(async (url) => {
    calls.push(url);
    if (!url.includes('/catalog/')) return nonCatalog;
    if (url.includes('skip=0')) return page(['tt0000001']);
    if (url.includes('skip=25')) { await sleep(200); return page(['tt0000002']); }
    return page([]);
  });
  try {
    micoReal();
    await crawler.tick();
    await sleep(320);

    assert.ok(calls.some((u) => u.includes('skip=25')), 'a página em voo termina (deadline próprio)');
    assert.ok(!calls.some((u) => u.includes('skip=50')), 'nenhuma página NOVA depois de expirar');
    assert.equal(store.engine().getState('mico', MARKER), null);
  } finally {
    stub.restore();
  }
});
