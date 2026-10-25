// Status do crawler (Fase 4) + consultas de leitura do store que o alimentam.
// Store em MEMÓRIA por caso; adaptador dublê (o Vaca real nunca é tocado);
// freio de tráfego desligado (idleWindowMs 0) exceto onde o caso exige.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const live = await import('../src/utils/crawler-live.js');
const { PROBE_STATE_KEY } = await import('../src/providers/crawl-probe-gate.js');
const { buildCrawlerStatus, buildSiteStatus, legacyView, STATUS_LIST_LIMIT } = await import('../src/providers/crawl-status.js');
const { refreshCursorsView } = await import('../src/providers/crawl-cursor-load.js');
const { stubFetch } = await import('./helpers/stub.js');

const savedCrawl = { ...config.crawl };

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
    // O status pode ABRIR o store (ver o caso do store fechado abaixo): sem
    // isto, um `dbPath` vazado de um caso para outro faria o `crawl.db` de
    // verdade aparecer no repositório durante a suíte.
    dbPath: savedCrawl.dbPath,
  }, overrides);
}

const movie = (url: string, lastmod = '2026-01-01') => ({ url, lastmod, kind: 'movie' as const });

beforeEach(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  freshCrawl();
});

after(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

describe('crawl-store: consultas de leitura e ações', () => {
  test('listByStatus ordena por checked_at e respeita o teto', () => {
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b'), movie('/c')], 1);
    store.engine().markResult('fake', '/a', { status: 'done', releases: 1 }, 100);
    store.engine().markResult('fake', '/b', { status: 'done', releases: 2 }, 300);
    store.engine().markResult('fake', '/c', { status: 'done', releases: 3 }, 200);
    const rows = store.engine().listByStatus('fake', 'done', 2);
    assert.deepEqual(rows.map((r) => r.url), ['/b', '/c']);
  });

  test('errorGroups agrupa por motivo, mais frequente primeiro', () => {
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b'), movie('/c')], 1);
    store.engine().markResult('fake', '/a', { status: 'error', error: 'HTTP 403' }, 10, { maxTries: 5 });
    store.engine().markResult('fake', '/b', { status: 'error', error: 'timeout' }, 11, { maxTries: 5 });
    store.engine().markResult('fake', '/c', { status: 'error', error: 'HTTP 403' }, 12, { maxTries: 5 });
    assert.deepEqual(store.engine().errorGroups('fake', 10), [
      { reason: 'HTTP 403', count: 2 },
      { reason: 'timeout', count: 1 },
    ]);
  });

  test('sumReleases soma os magnets vistos e requeueUrl devolve à fila', () => {
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b')], 1);
    store.engine().markResult('fake', '/a', { status: 'done', releases: 4 }, 10);
    store.engine().markResult('fake', '/b', { status: 'done', releases: 6 }, 11);
    assert.equal(store.engine().sumReleases('fake'), 10);
    assert.equal(store.engine().requeueUrl('fake', '/a'), true);
    assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending');
  });

  test('clearSite apaga só o site alvo (urls + runs)', () => {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    store.engine().upsertUrls('outro', [movie('/x')], 1);
    store.engine().startRun('fake', 'initial', '', 1);
    const report = store.engine().clearSite('fake');
    assert.equal(report.urls, 1);
    assert.equal(report.runs, 1);
    assert.equal(store.engine().counters('fake').total, 0);
    assert.equal(store.engine().counters('outro').total, 1, 'o outro site ficou intacto');
  });
});

describe('crawler: status por site (Fase 4)', () => {
  test('card do site: fase, progresso, magnets, listas e ETA', async () => {
    freshCrawl(); // delay 0 → ritmo = teto por hora (1000 páginas/h)
    // O sidecar é quem raspa: aqui o estado é semeado direto no `crawl.db`
    // (o mesmo banco que ele escreve) — /done lida em dry-run, /nostream na fila.
    store.engine().upsertUrls('fake', [movie('/done'), movie('/nostream')], 1);
    const claimed = store.engine().takeNext('fake', 2);
    assert.equal(claimed?.url, '/done');
    store.engine().markResult('fake', '/done', { status: 'simulated', imdb: 'tt1000000', releases: 1 }, 3);

    const status = crawler.status();
    assert.equal(status.sitesConfigured[0], 'fake');
    const site = status.sites.find((s) => s.id === 'fake');
    assert.ok(site, 'card do site existe');
    assert.equal(site?.label, 'fake', 'id fora da tabela: o rótulo é o próprio id');
    assert.equal(site?.total, 2);
    assert.equal(site?.byStatus.simulated, 1); // motor em dryRun:true
    assert.equal(site?.simulatedAwaiting, 1, 'painel recebe o N de simuladas aguardando gravação');
    // Progresso conta só gravação real: em dry-run a página lida não é "feita".
    assert.equal(site?.progressPercent, 0);
    assert.equal(site?.magnetsFound, 1);
    assert.ok(site ? site.ratePerHour >= 1 : false);
    assert.equal(site?.etaHours, null, 'o custo por página é medido pelo sidecar: sem ele o ETA honesto é null');
    assert.equal(site?.recentWorks.length, 0, 'sem gravação não há obra "feita" no histórico');
    assert.deepEqual(site?.noWork, []);
  });

  test('ETA cresce com páginas pendentes × custo médio observado ÷ req/h', async () => {
    freshCrawl({ delayMs: 3600 }); // teto de 1000 REQUISIÇÕES/h
    // 5000 pendentes sem processar: com custo médio observado 1 req/página,
    // ETA ≈ 5h. Sem custo observado nenhum, o ETA é null (mostra "—" no
    // painel) em vez de usar req/h como se fosse páginas/h.
    const urls = Array.from({ length: 5000 }, (_, i) => movie(`/p${i}`));
    store.engine().upsertUrls('fake', urls, 1);
    const liveCfg = live.effective();
    const state = (avgRequestCost: number | null): any => ({
      activeSiteId: 'fake', activeLabel: 'Fake Site', paused: false, autoPause: null,
      cursors: { movie: '', tv_show: '' }, nextDiscoveryAt: 0, pagesThisHour: 0,
      openRunId: null, errorStreak: 0, canaryStreak: 0, cycle: {},
      currentSiteNewReleases: 0, siteReady: true, avgRequestCost,
    });
    const noCost = buildSiteStatus('fake', store.engine(), liveCfg, state(null));
    assert.equal(noCost.etaHours, null, 'sem custo medido o ETA honesto é null');
    const page1 = buildSiteStatus('fake', store.engine(), liveCfg, state(1));
    assert.equal(page1.etaHours, 5, '5000 páginas × 1 req ÷ 1000 req/h');
    const series = buildSiteStatus('fake', store.engine(), liveCfg, state(9));
    assert.equal(series.etaHours, 45, 'série cara (9 req/página): o ETA reflete o custo real, não 1:1');
  });

  test('o ETA usa o custo do PRÓPRIO site: o inativo não herda o do ativo', () => {
    // O custo é medido POR SITE (requisições por página): com `a` ativo a 1
    // req/página e `b` inativo a 9 (página de série), o card de `b` recebia o
    // custo de `a` pelo estado escalar e prometia 1 h no lugar das 9 h.
    freshCrawl({ sites: ['a', 'b'], delayMs: 3600, maxPerHour: 1000 });
    const urls = Array.from({ length: 1000 }, (_, i) => movie(`/p${i}`));
    store.engine().upsertUrls('a', urls, 1);
    store.engine().upsertUrls('b', urls, 1);
    const liveCfg = live.effective();
    // `legacyView` é a forma canônica da vista de site que o motor entrega.
    const view = (id: string, label: string, avgRequestCost: number) =>
      legacyView({ activeLabel: label, siteReady: true, avgRequestCost, idleFraction: 1 }, liveCfg, id);
    const status = (custoB: number) => buildCrawlerStatus(store.engine(), liveCfg, ['a', 'b'], {
      active: 'a', sites: [view('a', 'Vaca Torrent', 1), view('b', 'NerdFilmes', custoB)],
    });
    const [a, b] = status(9).sites;
    assert.equal(a?.etaHours, 1, '1000 páginas × 1 req ÷ 1000 req/h');
    assert.equal(b?.etaHours, 9, 'o site inativo usa o custo DELE: 1000 × 9 ÷ 1000');
    assert.equal(b?.etaBasis, 'medido');
    assert.equal(b?.ratePerHour, 1000, 'mesmo teto: a diferença do ETA é só o custo');
    // Sem custo medido não pega o do vizinho: "—" com o motivo declarado.
    const semCusto = status(0).sites.find((s) => s.id === 'b');
    assert.equal(semCusto?.etaHours, null);
    assert.equal(semCusto?.etaBasis, 'sem-custo-medido');
  });

  test('errorGroups no card agrupa series_truncated pelo motivo estável (M2)', () => {
    freshCrawl({ sites: ['fake'] });
    store.engine().upsertUrls('fake', [movie('/a'), movie('/b'), movie('/c'), movie('/d')], 1);
    store.engine().markResult('fake', '/a', { status: 'error', error: 'series_truncated: teto de série atingido (cards 2/4, botões 40/40)' }, 10, { maxTries: 5 });
    store.engine().markResult('fake', '/b', { status: 'error', error: 'series_truncated: teto de série atingido (cards 1/9, botões 12/40)' }, 11, { maxTries: 5 });
    store.engine().markResult('fake', '/c', { status: 'error', error: 'HTTP 500' }, 12, { maxTries: 5 });
    store.engine().markResult('fake', '/d', { status: 'error', error: 'timeout' }, 13, { maxTries: 5 });
    const card = buildSiteStatus('fake', store.engine(), live.effective(), {
      activeSiteId: 'fake', activeLabel: 'Fake Site', paused: false, autoPause: null,
      cursors: { movie: '', tv_show: '' }, nextDiscoveryAt: 0, pagesThisHour: 0,
      openRunId: null, errorStreak: 0, canaryStreak: 0, cycle: {},
      currentSiteNewReleases: 0, siteReady: true,
    } as any);
    // Motivo ESTÁVEL: o detalhe (cards x/y) varia por página e viraria um
    // grupo por URL. O texto cru segue na lista de erros recentes.
    assert.deepEqual(card.errorGroups.map((g) => ({ reason: g.reason, count: g.count })), [
      { reason: 'series_truncated', count: 2 },
      { reason: 'HTTP 500', count: 1 },
      { reason: 'timeout', count: 1 },
    ]);
    assert.ok(
      card.errors.some((e) => /cards 2\/4/.test(e.error)),
      'o detalhe cru permanece visível na lista de erros',
    );
  });

  test('simulate sem adaptador TS: responde sem-adaptador e não toca a fila', async () => {
    store.engine().upsertUrls('fake', [movie('/done'), movie('/nostream')], 1);
    const before = store.engine().counters('fake');
    const result = await crawler.simulate(20);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'sem-adaptador');
    assert.equal(result.site, 'fake');
    assert.equal(result.pages, 0);
    const after = store.engine().counters('fake');
    assert.deepEqual(after.byStatus, before.byStatus, 'status da fila inalterado');
    assert.equal(after.byStatus.inflight, 0, 'nenhuma URL é reclamada');
  });
});

describe('crawl-status: custo e limites das consultas', () => {
  function motorState(activeSiteId = 'fake'): any {
    return {
      activeSiteId, activeLabel: 'Fake Site', paused: false, autoPause: null, cursors: { movie: '', tv_show: '' },
      pagesThisHour: 0, openRunId: null, errorStreak: 0, canaryStreak: 0, cycle: {},
      currentSiteNewReleases: 0, siteReady: true,
    };
  }

  /** Proxy que conta cada chamada de método ao motor real (memória). */
  function countingEngine() {
    const base = store.engine() as any;
    const calls: Record<string, number> = {};
    const proxy = new Proxy(base, {
      get(target: any, prop: string) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args: any[]) => {
          calls[prop] = (calls[prop] || 0) + 1;
          return value.apply(target, args);
        };
      },
    });
    return { engine: proxy as any, calls };
  }

  test('topo reusa o card do site ativo (sem repetir counters/latestRun)', () => {
    freshCrawl();
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    store.engine().markResult('fake', '/a', { status: 'done', releases: 1 }, 10);
    const { engine, calls } = countingEngine();

    const status = buildCrawlerStatus(engine, live.effective(), ['fake'], motorState());

    assert.equal(calls.counters, 1, 'counters do site ativo é consultado UMA vez');
    assert.equal(calls.latestRun, 1, 'latestRun é consultado UMA vez');
    assert.equal(calls.sumReleases, 1);
    assert.equal(calls.listByStatus, 4, 'done/no-work/error/partial (Fase 7 v2), um LIMIT cada');
    assert.equal(calls.errorGroups, 1);
    assert.equal(status.counters?.total, 1, 'o topo reusa o card do site ativo');
    assert.equal(status.latestRun?.phase ?? null, null);
  });

  test('as consultas crescem por site configurado, sem varredura extra', () => {
    freshCrawl({ sites: ['a', 'b', 'c'] });
    store.engine().upsertUrls('a', [movie('/a')], 1);
    store.engine().upsertUrls('b', [movie('/b')], 1);
    store.engine().upsertUrls('c', [movie('/c')], 1);
    const { engine, calls } = countingEngine();

    const status = buildCrawlerStatus(engine, live.effective(), ['a', 'b', 'c'], motorState('a'));
    assert.equal(status.sites.length, 3);
    assert.equal(calls.counters, 3);
    assert.equal(calls.latestRun, 3);
    assert.equal(calls.listByStatus, 12);
    assert.equal(calls.errorGroups, 3);
  });

  test('as listas do card respeitam o teto (não devolvem o site inteiro)', () => {
    freshCrawl({ sites: ['fake'] });
    const urls = Array.from({ length: 25 }, (_, i) => movie(`/p${i}`));
    store.engine().upsertUrls('fake', urls, 1);
    for (let i = 0; i < 25; i += 1) {
      store.engine().markResult('fake', `/p${i}`, { status: 'done', releases: 1 }, 100 + i);
    }
    const liveCfg = live.effective();
    const card = buildSiteStatus('fake', store.engine(), liveCfg, motorState());
    assert.equal(card.total, 25);
    assert.equal(card.recentWorks.length, STATUS_LIST_LIMIT);
    assert.ok(card.recentWorks.length < card.total, 'a lista é um resumo, não o site inteiro');
  });

  test('partial (Fase 7 v2): remaining/ETA incluem, partialWork traz x/y do progresso', () => {
    freshCrawl({ sites: ['fake'] });
    store.engine().upsertUrls('fake', [
      { url: '/s1', lastmod: 'x', kind: 'tv_show' as const },
      { url: '/s2', lastmod: 'x', kind: 'tv_show' as const },
    ], 1);
    store.engine().markResult('fake', '/s1', {
      status: 'partial', releases: 2,
      progress: '{"card":{"skip":1,"url":"/c3"},"doneCards":["/c1","/c2"],"totalCards":9,"v":1}',
    }, 100);
    const card = buildSiteStatus('fake', store.engine(), live.effective(), motorState());
    assert.equal(card.byStatus.partial, 1);
    assert.ok(card.pendingRemaining >= 1, 'partial é trabalho restante');
    assert.deepEqual(card.partialWork, [{ url: '/s1', done: 2, total: 9, checkedAt: card.partialWork[0]?.checkedAt }]);
  });

  test('stableErrorReason agrupa series_stall (estouro de progresso) pelo motivo estável', async () => {
    const { stableErrorReason } = await import('../src/providers/crawl-status.js');
    assert.equal(stableErrorReason('series_stall: progresso não avançou (cards 10/24)'), 'series_stall');
    assert.equal(stableErrorReason('series_truncated: teto (cards 2/4)'), 'series_truncated');
    assert.equal(stableErrorReason(''), 'erro');
  });

  test('status com o store FECHADO abre o crawl.db uma vez, só lê, e repovoa sites[]', () => {
    // O contrato mudou com a Fase 8: `CRAWL_ENABLED=false` (o default de
    // instalação) faz `start()` voltar antes de `primeSite`, e aí o store nunca
    // abria — o painel recebia `sites: []`/`engine: null` e não conseguia
    // mostrar "sonda não rodada" de um site que nunca rodou. O status agora
    // LÊ o store, abrindo o que não estiver aberto; o que ele NÃO faz é
    // GRAVAR (veredito é da sonda, e só com `--write`).
    store.resetForTests();
    assert.equal(store.currentEngine(), null, 'premissa: nada aberto');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-crawl-status-'));
    try {
      freshCrawl({ sites: ['fake', 'outro'], dbPath: path.join(dir, 'crawl.db') });
      const primeiro = crawler.status();
      const engine = store.currentEngine();
      assert.notEqual(engine, null, 'o status abriu o crawl.db');
      assert.notEqual(primeiro.engine, null, 'sem engine o painel não tem onde ler o veredito');
      assert.deepEqual(primeiro.sites.map((s) => s.id), ['fake', 'outro'], 'um card por site configurado');
      assert.equal(primeiro.counters?.total, 0);

      crawler.status();
      assert.equal(store.currentEngine(), engine, 'a engine existente é REUTILIZADA (nada de reabrir)');
      for (const id of ['fake', 'outro']) {
        assert.equal(engine?.counters(id).total, 0, `${id}: o status não enfileirou nada`);
        assert.equal(engine?.getState(id, PROBE_STATE_KEY), null, `${id}: o status não gravou veredito`);
        assert.equal(engine?.latestRun(id), null, `${id}: o status não abriu rodada`);
      }
    } finally {
      // Fecha a engine ANTES de apagar: no Windows o `crawl.db` aberto trava o
      // `unlink`, e a engine vazada contaminaria o caso seguinte.
      store.resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// T3-L3: o `crawl.db` é do sidecar. A vista do card deixou de ler o banco e
// passou a ser a última resposta de `GET /crawl/cursor?site=<id>`; o status é
// síncrono, então a leitura roda em fundo e o fallback local cobre a espera.
describe('cursorsView: o cursor do card vem da ponte com o sidecar', () => {
  test('GET por site, com token; a vista da ponte vence o cursor do crawl.db', async () => {
    freshCrawl({ sites: ['fake'] });
    store.engine().setState('fake', 'cursor:movie', '2026-01-01');
    const savedToken = config.jackett.testToken;
    config.jackett.testToken = 'tok-cursor';
    const stub = stubFetch(() => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, site: 'fake', movie: '2026-09-01', tv_show: '2026-09-05' }),
    }));
    try {
      await refreshCursorsView('fake');
      const card = crawler.status().sites.find((s) => s.id === 'fake');
      assert.deepEqual(card?.cursors, { movie: '2026-09-01', tv_show: '2026-09-05' });
      assert.equal(stub.calls[0]?.url, `http://127.0.0.1:${config.crawl.sidecarPort}/crawl/cursor?site=fake`);
      const headers = stub.calls[0]?.options.headers as Record<string, string>;
      assert.equal(headers['X-Indexer-Test-Token'], 'tok-cursor', 'mesmo token das rotas vizinhas');
    } finally {
      stub.restore();
      config.jackett.testToken = savedToken;
    }
  });

  test('ponte fora do ar (500 ou rede): o card cai na leitura local, sem quebrar o painel', async () => {
    freshCrawl({ sites: ['fake'] });
    store.engine().setState('fake', 'cursor:movie', '2026-08-01');
    store.engine().setState('fake', 'cursor:tv_show', '2026-08-02');
    const local = { movie: '2026-08-01', tv_show: '2026-08-02' };
    const sqlite = stubFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'sqlite' }) }));
    try {
      await refreshCursorsView('fake');
      assert.deepEqual(crawler.status().sites.find((s) => s.id === 'fake')?.cursors, local, '500 → fallback');
    } finally { sqlite.restore(); }
    const down = stubFetch(() => { throw new Error('ECONNREFUSED'); });
    try {
      await refreshCursorsView('fake');
      assert.deepEqual(crawler.status().sites.find((s) => s.id === 'fake')?.cursors, local, 'sem resposta → fallback');
    } finally { down.restore(); }
  });
});
