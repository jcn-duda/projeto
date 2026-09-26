// Timer do crawler (Fase 4): unitários do `createCrawlScheduler` (rearm/sync/
// disarm, sem duplicar timer) e a integração "start desligado → ligar pelo
// painel arma e processa". O timer real é substituído por um dublê de
// `setInterval`/`clearInterval` — nenhum `sleep`, nenhum relógio de parede.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const live = await import('../src/utils/crawler-live.js');
const { createCrawlScheduler } = await import('../src/providers/crawl-scheduler.js');
const { envDefaults } = await import('../src/utils/crawler-live-schema.js');
import type { CrawlerEffectiveConfig } from '../src/utils/crawler-live-schema.js';
import type { CrawlDiscovery, CrawlSite } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

function cfg(over: Partial<CrawlerEffectiveConfig> = {}): CrawlerEffectiveConfig {
  return { ...envDefaults(), enabled: true, delayMs: 1000, ...over };
}

interface FakeTimers {
  readonly setCalls: number;
  readonly clearCalls: number;
  readonly entries: Map<number, { fn: () => unknown; ms: number }>;
  fireAll(): Promise<void>;
  restore(): void;
}

/** Substitui o timer global por um dublê que registra cadência e dispara sob
 * demanda. Devolve um handle com `unref()` (o scheduler chama), como o Node. */
function fakeTimers(): FakeTimers {
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  const entries = new Map<number, { fn: () => unknown; ms: number }>();
  const state = { setCalls: 0, clearCalls: 0, seq: 0 };
  (global as any).setInterval = (fn: () => unknown, ms: number) => {
    state.setCalls += 1;
    const id = ++state.seq;
    entries.set(id, { fn, ms });
    return { id, unref() {} };
  };
  (global as any).clearInterval = (handle: { id?: number }) => {
    state.clearCalls += 1;
    if (handle && typeof handle.id === 'number') entries.delete(handle.id);
  };
  return {
    get setCalls() { return state.setCalls; },
    get clearCalls() { return state.clearCalls; },
    entries,
    async fireAll() {
      for (const entry of [...entries.values()]) await entry.fn();
    },
    restore() {
      (global as any).setInterval = originalSet;
      (global as any).clearInterval = originalClear;
    },
  };
}

describe('crawl-scheduler: rearm/sync/disarm', () => {
  test('rearm arma uma vez e não duplica com a MESMA cadência', () => {
    const ft = fakeTimers();
    try {
      const s = createCrawlScheduler({ isStarted: () => true, tick: async () => {}, warn: () => {}, onDisabled: () => {} });
      s.rearm(cfg({ delayMs: 1000 }));
      s.rearm(cfg({ delayMs: 1000 }));
      assert.equal(ft.setCalls, 1, 'não cria um segundo timer');
      assert.equal(ft.entries.size, 1);
    } finally { ft.restore(); }
  });

  test('rearm com cadência NOVA troca o timer: clear antes do set', () => {
    const ft = fakeTimers();
    try {
      const s = createCrawlScheduler({ isStarted: () => true, tick: async () => {}, warn: () => {}, onDisabled: () => {} });
      s.rearm(cfg({ delayMs: 1000 }));
      s.rearm(cfg({ delayMs: 2000 }));
      assert.equal(ft.setCalls, 2);
      assert.equal(ft.clearCalls, 1, 'o timer antigo é limpo antes do novo');
      assert.equal(ft.entries.size, 1, 'só um timer ativo');
      assert.equal([...ft.entries.values()][0].ms, 2000);
    } finally { ft.restore(); }
  });

  test('cadência respeita o piso (500ms) e o teto (60s)', () => {
    const ft = fakeTimers();
    try {
      const s = createCrawlScheduler({ isStarted: () => true, tick: async () => {}, warn: () => {}, onDisabled: () => {} });
      s.rearm(cfg({ delayMs: 0 }));
      assert.equal([...ft.entries.values()][0].ms, 500);
      s.rearm(cfg({ delayMs: 120_000 }));
      assert.equal([...ft.entries.values()][0].ms, 60_000);
    } finally { ft.restore(); }
  });

  test('rearm é no-op quando não started ou desligado', () => {
    const ft = fakeTimers();
    try {
      let started = false;
      const s = createCrawlScheduler({ isStarted: () => started, tick: async () => {}, warn: () => {}, onDisabled: () => {} });
      s.rearm(cfg()); // not started
      assert.equal(ft.setCalls, 0);
      started = true;
      s.rearm(cfg({ enabled: false })); // desligado não arma
      assert.equal(ft.setCalls, 0, 'enabled=false nunca arma o timer');
    } finally { ft.restore(); }
  });

  test('disarm limpa o timer e rearm volta a armar', () => {
    const ft = fakeTimers();
    try {
      const s = createCrawlScheduler({ isStarted: () => true, tick: async () => {}, warn: () => {}, onDisabled: () => {} });
      s.rearm(cfg());
      s.disarm();
      assert.equal(ft.entries.size, 0);
      s.rearm(cfg());
      assert.equal(ft.entries.size, 1);
    } finally { ft.restore(); }
  });

  test('sync com enabled=false desarma e chama onDisabled uma vez', () => {
    const ft = fakeTimers();
    try {
      let disabled = 0;
      const s = createCrawlScheduler({ isStarted: () => true, tick: async () => {}, warn: () => {}, onDisabled: () => { disabled += 1; } });
      s.rearm(cfg());
      assert.equal(ft.entries.size, 1);
      s.sync(cfg({ enabled: false }));
      assert.equal(disabled, 1);
      assert.equal(ft.entries.size, 0);
      s.sync(cfg({ enabled: false })); // já desarmado: não redispara
      assert.equal(disabled, 1);
    } finally { ft.restore(); }
  });

  test('o callback do timer chama tick e propaga falha para warn', async () => {
    const ft = fakeTimers();
    try {
      let ticks = 0;
      const warnings: string[] = [];
      const s = createCrawlScheduler({
        isStarted: () => true,
        tick: async () => { ticks += 1; throw new Error('boom'); },
        warn: (m) => { warnings.push(m); },
        onDisabled: () => {},
      });
      s.rearm(cfg({ delayMs: 1000 }));
      await ft.fireAll();
      assert.equal(ticks, 1);
      assert.deepEqual(warnings, ['boom']);
    } finally { ft.restore(); }
  });
});

// --- Integração com o motor ------------------------------------------------

const savedCrawl = { ...config.crawl };

const movie = (url: string) => ({ url, lastmod: '2026-01-01', kind: 'movie' as const });

function item(seed: string): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return {
    title: 'Fake (2000) 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1, size: 1000,
  };
}

function fakeSite(): CrawlSite {
  return {
    id: 'fake',
    label: 'Fake Site',
    discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string) => ({
      url, status: 'done' as const, imdb: 'tt1000000', title: 'Fake', year: 2000,
      type: 'movie' as const, releases: [item(url)],
    }),
  };
}

describe('crawler: enabled ao vivo (start desligado → ligar pelo painel)', () => {
  let ft: FakeTimers;

  beforeEach(() => {
    crawler._resetForTest();
    live._resetForTest();
    store.resetForTests();
    store.open(undefined, { forceMemory: true });
    Object.assign(config.crawl, {
      enabled: false, dryRun: true, sites: ['fake'], delayMs: 0, maxPerHour: 1000,
      idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10, incrementalIntervalMin: 60,
    });
    crawler._setSitesForTest(() => fakeSite());
    ft = fakeTimers();
  });

  afterEach(() => {
    ft.restore();
    crawler._resetForTest();
    live._resetForTest();
    store.resetForTests();
    Object.assign(config.crawl, savedCrawl);
  });

  test('default desligado: start não arma timer; config set true arma e processa', async () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    crawler.start();
    assert.equal(ft.entries.size, 0, 'enabled=false não arma o timer');

    const outcome = live.set({ enabled: true });
    assert.equal(outcome.ok, true);
    assert.equal(ft.entries.size, 1, 'o set dispara onConfigChange → sync → rearm');

    // O callback do timer é o mesmo `tick` exportado (provado no unitário);
    // aqui o motor é dirigido direto para não depender de flush de microtask.
    await crawler.tick(); // descoberta (sem URLs novas)
    await crawler.tick(); // processa a página pendente
    assert.equal(store.engine().counters('fake').byStatus.done, 1, 'o motor processa após habilitar ao vivo');
  });

  test('desligar ao vivo desarma o timer e para o processamento', () => {
    crawler.start();
    live.set({ enabled: true });
    assert.equal(ft.entries.size, 1);
    live.set({ enabled: false });
    assert.equal(ft.entries.size, 0, 'enabled=false desarma sem restart');
  });
});
