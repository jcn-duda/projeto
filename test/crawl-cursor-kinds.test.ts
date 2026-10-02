// Correções da revisão adversarial da Fase 7 (séries do Vaca) — MOTOR:
//   F2 cursor POR KIND (`cursor:movie` / `cursor:tv_show`): migração do cursor
//      legado preserva filmes; séries ao habilitar começam `initial` sem
//      "Zerar site"; parcial de um kind não trava o avanço do outro; restart
//      restaura os dois; reset apaga os dois;
//   F5 truncagem por teto vira `series_truncated` (NUNCA done) com o `maxTries`
//      como freio anti-loop;
//   F4 rótulo do teto horário em "requisições/h" (chave `maxPerHour` mantida).
// Motor com adaptadores dublês — o Vaca real nunca é tocado.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
import type { CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';

const SHOW = 'https://vaqueirofilmes.com/pt/tv-shows/outer-banks/';
const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['fake'], delayMs: 0,
    maxPerHour: 1000, idleWindowMs: 0, maxTries: 2, layoutCanary: 10,
    seriesEnabled: false, seriesMaxCards: 10, seriesMaxButtons: 40,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

function motorSite(sinceSeen: Array<Record<string, string | null>>): CrawlSite {
  const entry = (url: string, lastmod: string, kind: 'movie' | 'tv_show') => ({ url, lastmod, kind });
  return {
    id: 'fake',
    label: 'Fake',
    discover: async (_since, opts) => {
      sinceSeen.push({ ...(opts?.sinceByKind ?? {}) });
      return {
        urls: [
          entry('/filme', '2026-03-01', 'movie'),
          entry('/serie', '2026-04-01', 'tv_show'),
        ],
        complete: true,
        failures: [],
      };
    },
    fetchWork: async (url) => ({
      url, status: 'no-torrent', imdb: 'tt1000000', title: 'T', year: 2000,
      type: url === '/serie' ? ('series' as const) : ('movie' as const),
    }),
  };
}

async function drainAll(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (!crawler.status().runOpen) return;
    await crawler.tick();
  }
}

describe('F2 no motor: cursor POR KIND (migração, toggle, parcial, restart, reset)', () => {
  test('instalação existente: cursor legado único migra para cursor:movie sem refazer filmes', async () => {
    store.engine().setState('fake', 'cursor', '2026-02-01');
    const sinceSeen: Array<Record<string, string | null>> = [];
    crawler._setSitesForTest(() => motorSite(sinceSeen));
    crawler.start();
    assert.equal(crawler.status().cursors.movie, '2026-02-01', 'cursor de filme preservado pela migração');
    assert.equal(crawler.status().cursors.tv_show, '', 'séries sem cursor começam do zero');
    assert.equal(store.engine().getState('fake', 'cursor:movie'), '2026-02-01', 'migração persistida (idempotente)');
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    assert.deepEqual(sinceSeen[0], { movie: '2026-02-01', tv_show: null }, 'filmes incrementais; séries AO HABILITAR começam initial — sem Zerar site');
  });

  test('parcial de UM kind não trava o cursor do outro; o kind falho volta no retry curto', async () => {
    const sinceSeen: Array<Record<string, string | null>> = [];
    const site = motorSite(sinceSeen);
    site.discover = async (_since, opts) => {
      sinceSeen.push({ ...(opts?.sinceByKind ?? {}) });
      return {
        urls: [
          { url: '/filme', lastmod: '2026-03-01', kind: 'movie' as const },
          { url: '/serie', lastmod: '2026-04-01', kind: 'tv_show' as const },
        ],
        complete: false,
        failures: ['tv_show-sitemap.xml: http_503'],
        completeByKind: { movie: true, tv_show: false },
      };
    };
    crawler._setSitesForTest(() => site);
    await crawler.tick(); // descoberta parcial
    await drainAll();
    assert.equal(crawler.status().cursors.movie, '2026-03-01', 'filme completo avança o SEU cursor');
    assert.equal(crawler.status().cursors.tv_show, '', 'sitemap de série caído NÃO avança o cursor de série');
    assert.ok((crawler.status().nextDiscoveryAt as number) <= Date.now() + 90_000, 'o kind faltante volta no retry curto');
  });

  test('restart: ambos os cursores vêm do crawl.db; reset apaga os dois', async () => {
    const sinceSeen: Array<Record<string, string | null>> = [];
    crawler._setSitesForTest(() => motorSite(sinceSeen));
    crawler.start();
    await crawler.tick();
    await drainAll();
    assert.equal(crawler.status().cursors.movie, '2026-03-01');
    assert.equal(crawler.status().cursors.tv_show, '2026-04-01');
    // "Restart": motor zerado, store PRESERVADO.
    crawler._resetForTest();
    const sinceSeen2: Array<Record<string, string | null>> = [];
    crawler._setSitesForTest(() => motorSite(sinceSeen2));
    crawler.start();
    assert.deepEqual(crawler.status().cursors, { movie: '2026-03-01', tv_show: '2026-04-01' }, 'restart restaura os dois kinds');
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    assert.deepEqual(sinceSeen2[0], { movie: '2026-03-01', tv_show: '2026-04-01' }, 'ambos incrementais pós-restart');
    // Reset: Zerar site apaga o estado do site inteiro, cursores incluídos.
    crawler.resetSite('fake');
    assert.deepEqual(crawler.status().cursors, { movie: '', tv_show: '' }, 'reset zera os dois cursores');
    crawler.start();
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    assert.deepEqual(sinceSeen2[sinceSeen2.length - 1], { movie: null, tv_show: null }, 'descoberta recomeça sem corte nenhum');
  });
});

describe('F5: truncagem de série nunca é done e não vira loop eterno', () => {
  test('status error series_truncated: acumula tries e dorme após maxTries (freio anti-loop)', async () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: '2026-01-01', kind: 'tv_show' }], 1);
    const truncSite: CrawlSite = {
      id: 'fake', label: 'Fake',
      discover: async () => ({ urls: [], complete: true, failures: [] }),
      fetchWork: async (u) => ({
        url: u, status: 'error', type: 'series',
        error: 'series_truncated: teto de série atingido (cards 2/4, botões 40/40)',
      }),
    };
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'identified', imdb: 'tt1', reason: 'ok' }),
      record: async () => ({ kept: 0, added: 0, transition: 'none', cleared: 0 }),
    });
    for (let i = 0; i < 2; i += 1) {
      const row = store.engine().takeNext('fake', 1) as CrawlUrlRow;
      const outcome = await process(truncSite, row, { dryRun: true, maxTries: 2 });
      assert.equal(outcome.kind, 'error');
      if (i === 0) store.engine().requeueUrl('fake', SHOW);
    }
    const slept = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(slept.tries, 2, 'tentativas acumulam no erro truncado');
    assert.ok(slept.nextAt > Date.now(), 'após maxTries a URL dorme (sem loop eterno) — o operador levanta o teto e usa "Reprocessar erros"');
  });
});

describe('F4: teto horário anunciado em requisições/h (chave preservada)', () => {
  test('schema do painel usa "requisições/h" e mantém a chave maxPerHour', async () => {
    const schemaMod = await import('../src/utils/crawler-live-schema.js');
    const field = schemaMod.schema().find((f) => f.key === 'maxPerHour');
    assert.ok(field, 'campo continua existindo');
    assert.equal(field?.unit, 'requisições/h');
    assert.match(field?.label || '', /Requisições por Hora/);
  });
});
