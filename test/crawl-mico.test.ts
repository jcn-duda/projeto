// Adaptador de raspagem do Mico Leão Dublado (`crawl-sites/mico.ts`, Fase 1:
// SÓ filmes) contra fixtures no formato REAL da API. O Mico NÃO é card do
// Jackett — é um addon Stremio consultado por IMDb, e o adaptador devolve o
// IMDb PRONTO (o `crawl-page` pula a identificação por TMDB). Cobre:
//   - `parseMicoUrl` e `bucketLastmod` (funções puras, exportadas);
//   - `discover` por PAGINAÇÃO SIMPLES (o filtro de gênero da API está
//     QUEBRADO — ver cabeçalho do adaptador): skip dinâmico, dedupe por IMDb,
//     falha de uma página (best-effort) e falha total (lança);
//   - `fetchWork`: done/no-torrent/429-com-custo e recusas SEM rede;
//   - throttle PRÓPRIO (não reutiliza o breaker da busca ao vivo);
//   - integração com `processCrawlPage` + recorder dublê (NÃO chama identify,
//     grava com a fonte `mico`);
//   - colhedor: `mico` coberto pula FILME e SÉRIE (Fase 2 emite `tv_show`).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const micoCrawl = await import('../src/providers/crawl-sites/mico.js');
const { stubFetch } = await import('./helpers/stub.js');
const store = await import('../src/utils/crawl-store.js');
const live = await import('../src/utils/crawler-live.js');
const { _resetCoverageMemoForTest } = await import('../src/providers/crawl-coverage.js');
const { CURSOR_STATE_KEY } = await import('../src/providers/crawl-cursor.js');
const harvestWorker = await import('../src/providers/harvest-worker.js');
const cache = await import('../src/utils/cache.js');
import type { CrawlUrlRow } from '../src/providers/crawl-types.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'crawl', 'mico');
const read = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const HOST = config.mico.url;
const synthetic = (kind: 'movie' | 'series', tt: string) => `${HOST}/crawl/${kind}/${tt}/`;
const DAY = 86_400_000;

const savedMico = { ...config.mico };

beforeEach(() => {
  // O throttle padrão (1 s) deixaria os testes lentos; zera aqui e o teste de
  // throttle o restaura localmente. O estado module-level é isolado a cada caso.
  config.mico.enabled = true;
  config.mico.crawlMinGapMs = 0;
  config.mico.crawlRereadDays = 14;
  micoCrawl._resetThrottleForTest();
});

after(() => {
  Object.assign(config.mico, savedMico);
  micoCrawl._resetThrottleForTest();
});

/** Dublê de fetch que roteia catálogo (por skip) e stream (por tt). */
function micoStub(routes: {
  catalog?: Record<number, any>;
  stream?: Record<string, any>;
}) {
  return stubFetch((url) => {
    const cat = /\/catalog\/movie\/MicoFilmes\/skip=(\d+)\.json/.exec(url);
    if (cat) {
      const r = routes.catalog?.[Number(cat[1])];
      if (r && typeof r.status === 'number') return { ok: false, status: r.status, json: async () => ({}) };
      if (r) return { ok: true, status: 200, json: async () => r };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const st = /\/stream\/movie\/(tt\d+)\.json/.exec(url);
    if (st) {
      const r = routes.stream?.[st[1]];
      if (r && typeof r.status === 'number') {
        return { ok: false, status: r.status, json: async () => ({}), headers: { get: () => r.retryAfter ?? null } } as any;
      }
      if (r) return { ok: true, status: 200, json: async () => r };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('parseMicoUrl (pura)', () => {
  test('aceita URL sintética de filme e de série', () => {
    assert.deepEqual(micoCrawl.parseMicoUrl(synthetic('movie', 'tt0133093')), { kind: 'movie', imdb: 'tt0133093' });
    assert.deepEqual(micoCrawl.parseMicoUrl(synthetic('series', 'tt0944947')), { kind: 'series', imdb: 'tt0944947' });
  });

  test('rejeita host estranho, caminho inválido e tt malformado', () => {
    assert.equal(micoCrawl.parseMicoUrl('https://inimigo.test/crawl/movie/tt0133093/'), null, 'host de fora');
    assert.equal(micoCrawl.parseMicoUrl(`${HOST}/filme/tt0133093/`), null, 'caminho que não é /crawl/');
    assert.equal(micoCrawl.parseMicoUrl(`${HOST}/crawl/movie/12345/`), null, 'tt sem prefixo');
    assert.equal(micoCrawl.parseMicoUrl(`${HOST}/crawl/movie/tt0133093`), null, 'sem barra final');
    assert.equal(micoCrawl.parseMicoUrl(`${HOST}/crawl/tv/tt0133093/`), null, 'kind desconhecido');
    assert.equal(micoCrawl.parseMicoUrl('não é url'), null);
    assert.equal(micoCrawl.parseMicoUrl(''), null);
  });
});

describe('bucketLastmod (pura): o lastmod é um balde de releitura', () => {
  const base = Date.UTC(2026, 9, 2); // 2026-10-02

  test('1. ESTÁVEL dentro do período: o mesmo balde de 14 dias → mesmo lastmod', () => {
    const l0 = micoCrawl.bucketLastmod('tt0133093', base, 14);
    const startDay = Date.parse(`${l0}T00:00:00Z`) / DAY;
    for (let d = 0; d < 14; d += 1) {
      const now = (startDay + d) * DAY + 43_210; // meio do dia
      assert.equal(micoCrawl.bucketLastmod('tt0133093', now, 14), l0, `dia +${d} ainda no mesmo balde`);
    }
  });

  test('2. MUDA no período seguinte: avançando 14 dias, o lastmod vira (reenfileira)', () => {
    const l1 = micoCrawl.bucketLastmod('tt0468569', base, 14);
    const l2 = micoCrawl.bucketLastmod('tt0468569', base + 14 * DAY, 14);
    assert.notEqual(l1, l2, 'o próximo período produz outro lastmod');
    assert.ok(l2 > l1, 'e ele anda para frente');
  });

  test('3. ESPALHA as obras: ~1/14 do catálogo "vira" por dia', () => {
    const n = 2800;
    const ids = Array.from({ length: n }, (_, i) => `tt${1_000_000 + i}`);
    const at = (now: number) => ids.map((tt) => micoCrawl.bucketLastmod(tt, now, 14));
    // Num dado dia os lastmods se espalham em exatamente `period` baldes.
    const distinct = new Set(at(base));
    assert.equal(distinct.size, 14, 'as 2800 obras caem em 14 baldes distintos');
    // E entre um dia e o seguinte só ~1/14 muda de lastmod (a fase do dia).
    const today = at(base);
    const tomorrow = at(base + DAY);
    const turned = today.filter((v, i) => v !== tomorrow[i]).length;
    const share = turned / n;
    assert.ok(share > 0.04 && share < 0.12, `~1/14 (7,1%) vira por dia; medido ${(share * 100).toFixed(1)}%`);
  });

  test('4. MÁXIMO MONOTÔNICO: o max do catálogo não anda para trás com o tempo', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `tt${2_000_000 + i}`);
    let prev = '';
    for (let d = 0; d < 40; d += 1) {
      const now = base + d * DAY;
      const max = ids.map((tt) => micoCrawl.bucketLastmod(tt, now, 14)).sort().at(-1) as string;
      assert.ok(max >= prev, `dia +${d}: max ${max} >= ${prev} (ISO compara lexicográfico)`);
      prev = max;
    }
  });
});

describe('discover: PAGINAÇÃO SIMPLES (gênero está quebrado)', () => {
  test('skip DINÂMICO pelo nº real de metas + dedupe por IMDb', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({
      catalog: { 0: read('catalog-skip-0.json'), 5: read('catalog-skip-5.json'), 8: read('catalog-empty.json') },
    });
    try {
      const found = await site.discover(null);
      // 5 (página 1) + 3 (página 2, com tt0133093 duplicado) = 7 únicos.
      assert.equal(found.urls.length, 7, 'dedupe por IMDb remove a repetição entre páginas');
      assert.equal(found.complete, true);
      assert.deepEqual(found.completeByKind, { movie: true, tv_show: true }, 'Fase 1 não emite série');
      assert.equal(found.requestCost, 3, 'três páginas de catálogo lidas');
      // O skip avançou pelo tamanho REAL (5, depois 3), não por passo fixo 40.
      const skips = stub.calls.map((c) => Number(/skip=(\d+)/.exec(c.url)?.[1]));
      assert.deepEqual(skips, [0, 5, 8], 'skip += metas.length até a página vazia');
      assert.ok(found.urls.every((u) => u.kind === 'movie'), 'todas movie');
      assert.ok(found.urls.every((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.lastmod)), 'lastmod é o balde ISO');
      assert.equal(found.urls[0].url, synthetic('movie', 'tt33100314'), 'URL sintética estável');
    } finally {
      stub.restore();
    }
  });

  test('falha de UMA página → complete:false (movie:false) mas SEGUE varrendo', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    // skip=0 ok (5 metas); skip=5 → 500; salta passo nominal 40 → skip=45 vazio.
    const stub = micoStub({
      catalog: { 0: read('catalog-skip-0.json'), 5: { status: 500 }, 45: read('catalog-empty.json') },
    });
    try {
      const found = await site.discover(null);
      assert.equal(found.complete, false, 'uma página falhou → descoberta incompleta');
      assert.equal(found.completeByKind?.movie, false);
      assert.equal(found.completeByKind?.tv_show, true, 'série não depende do catálogo de filme');
      assert.equal(found.failures.length, 1);
      assert.equal(found.urls.length, 5, 'best-effort: as 5 obras da página boa entraram');
    } finally {
      stub.restore();
    }
  });

  test('falha TOTAL (primeira página cai) → LANÇA erro com custo medido', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ catalog: { 0: { status: 503 } } });
    try {
      await assert.rejects(
        () => site.discover(null),
        (err: Error & { requestCost?: number }) => {
          assert.ok(typeof err.requestCost === 'number' && err.requestCost >= 1, 'throw carrega withRequestCost');
          return true;
        },
      );
    } finally {
      stub.restore();
    }
  });

  test('catálogo SEM nenhuma obra → LANÇA, nunca urls:[] com complete:true', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ catalog: { 0: read('catalog-empty.json') } });
    try {
      await assert.rejects(() => site.discover(null));
    } finally {
      stub.restore();
    }
  });
});

describe('fetchWork', () => {
  test('filme com streams → done, IMDb pronto, magnet COM trackers e SEM dn=', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt7286456: read('stream-movie.json') } });
    try {
      const work = await site.fetchWork(synthetic('movie', 'tt7286456'), { kind: 'movie' });
      assert.equal(work.status, 'done');
      assert.equal(work.imdb, 'tt7286456', 'o IMDb vem pronto (pula o TMDB)');
      assert.equal(work.type, 'movie');
      assert.equal(work.requestCost, 1, 'uma chamada de stream');
      const releases = work.releases ?? [];
      assert.ok(releases.length >= 1, 'a fixture real tem streams');
      assert.equal(releases[0].indexer, 'mico');
      const withTr = releases.find((r) => String(r.magnet).includes('&tr='));
      assert.ok(withTr, 'ao menos um magnet leva os trackers de `sources`');
      assert.match(String(withTr!.magnet), /^magnet:\?xt=urn:btih:[a-f0-9]{40}&tr=/);
      assert.doesNotMatch(String(withTr!.magnet), /[?&]dn=/, 'o título do Mico não vira dn=');
    } finally {
      stub.restore();
    }
  });

  test('stream vazio → no-torrent (o próximo balde de releitura relê)', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt0000009: read('stream-empty.json') } });
    try {
      const work = await site.fetchWork(synthetic('movie', 'tt0000009'), { kind: 'movie' });
      assert.equal(work.status, 'no-torrent');
      assert.equal(work.imdb, 'tt0000009');
      assert.equal(work.requestCost, 1);
    } finally {
      stub.restore();
    }
  });

  test('429 → LANÇA erro com requestCost (withRequestCost) para o backoff do motor', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt0000429: { status: 429, retryAfter: '3' } } });
    try {
      await assert.rejects(
        () => site.fetchWork(synthetic('movie', 'tt0000429'), { kind: 'movie' }),
        (err: Error & { requestCost?: number; status?: number }) => {
          assert.equal(err.requestCost, 1, 'custo medido anexado ao erro');
          assert.equal(err.status, 429);
          return true;
        },
      );
    } finally {
      stub.restore();
      micoCrawl._resetThrottleForTest();
    }
  });

  test('URL que não é do Mico → erro sem NENHUMA rede', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({});
    try {
      const work = await site.fetchWork('https://inimigo.test/crawl/movie/tt0133093/', { kind: 'movie' });
      assert.equal(work.status, 'error');
      assert.equal(work.requestCost, 0);
      assert.equal(stub.calls.length, 0, 'recusa na porta, antes de qualquer fetch');
    } finally {
      stub.restore();
    }
  });

  test('kind divergente (url série, fila filme) → erro sem rede', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({});
    try {
      const work = await site.fetchWork(synthetic('series', 'tt0944947'), { kind: 'movie' });
      assert.equal(work.status, 'error');
      assert.match(String(work.error), /kind divergente/);
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
});

describe('throttle PRÓPRIO do raspador (não reutiliza o breaker ao vivo)', () => {
  test('duas chamadas seguidas respeitam MICO_CRAWL_MIN_GAP_MS', async () => {
    config.mico.crawlMinGapMs = 60;
    micoCrawl._resetThrottleForTest();
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt0000001: read('stream-empty.json'), tt0000002: read('stream-empty.json') } });
    try {
      const t0 = Date.now();
      await site.fetchWork(synthetic('movie', 'tt0000001'), { kind: 'movie' });
      await site.fetchWork(synthetic('movie', 'tt0000002'), { kind: 'movie' });
      const elapsed = Date.now() - t0;
      // Margem folgada de relógio real: o gap é 60 ms, cobra >= 45.
      assert.ok(elapsed >= 45, `respeitou o intervalo mínimo (~60 ms): ${elapsed} ms`);
    } finally {
      stub.restore();
      config.mico.crawlMinGapMs = 0;
      micoCrawl._resetThrottleForTest();
    }
  });
});

describe('integração: processCrawlPage + recorder dublê', () => {
  test('IMDb pronto → NÃO chama identify e grava com a fonte mico', async () => {
    const { createPageProcessor } = await import('../src/providers/crawl-page.js');
    let identifyCalled = false;
    const recorded: Array<{ siteId: string; imdb: string; releases: number }> = [];
    const process = createPageProcessor({
      identify: async () => { identifyCalled = true; return { outcome: 'identified', imdb: 'ttXXXXXXX' } as any; },
      record: async (siteId, obra, releases) => {
        recorded.push({ siteId, imdb: obra.imdb, releases: releases.length });
        return { added: releases.length } as any;
      },
    });
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt7286456: read('stream-movie.json') } });
    try {
      const row = { url: synthetic('movie', 'tt7286456'), kind: 'movie' } as unknown as CrawlUrlRow;
      const outcome = await process(site, row, { dryRun: false, noPersist: true });
      assert.equal(outcome.kind, 'done');
      assert.equal(identifyCalled, false, 'o IMDb pronto pula a identificação (TMDB/Cinemeta)');
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].siteId, 'mico', 'grava com a fonte mico');
      assert.equal(recorded[0].imdb, 'tt7286456');
      assert.ok(recorded[0].releases >= 1);
    } finally {
      stub.restore();
    }
  });
});

describe('colhedor: mico coberto pelo raspador', () => {
  const savedCrawl = { ...config.crawl };
  const savedJackett = config.jackett.indexers;
  const savedTmdb = config.tmdb.apiKey;
  const savedBludv = config.bludv.enabled;

  beforeEach(() => {
    live._resetForTest();
    store.resetForTests();
    store.open(undefined, { forceMemory: true });
    _resetCoverageMemoForTest();
    Object.assign(config.crawl, {
      enabled: true, dryRun: false, sites: ['mico'], siteOverrides: {},
      coverHarvest: true, coverMaxPending: 50, dbPath: savedCrawl.dbPath,
    });
    config.mico.harvest = true;
    config.jackett.indexers = [];
    config.tmdb.apiKey = '';
    config.bludv.enabled = false;
    // Carga inicial concluída + fila vazia → mico COBERTO pelo raspador.
    store.engine().setState('mico', CURSOR_STATE_KEY.movie, '2026-10-01T00:00:00Z');
    _resetCoverageMemoForTest();
  });

  after(() => {
    live._resetForTest();
    store.resetForTests();
    Object.assign(config.crawl, savedCrawl);
    config.jackett.indexers = savedJackett;
    config.tmdb.apiKey = savedTmdb;
    config.bludv.enabled = savedBludv;
  });

  test('mico coberto → pula FILME e SÉRIE (Fase 2 emite tv_show)', async () => {
    cache.set('meta:movie:tt9600001', { name: 'Coringa', year: '2019', type: 'movie' }, 3600);
    cache.set('meta:series:tt9600002', { name: 'Gotham', year: '2014', type: 'series' }, 3600);
    const stub = stubFetch((url) => {
      if (url.includes('/stream/')) return { ok: true, status: 200, json: async () => ({ streams: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    try {
      const movieCalls = () => stub.calls.filter((c) => c.url.includes('/stream/movie/')).length;
      const seriesCalls = () => stub.calls.filter((c) => c.url.includes('/stream/series/')).length;

      await harvestWorker.harvestOne({ imdbId: 'tt9600001', type: 'movie', reason: `mico-movie-${Date.now()}` } as any);
      assert.equal(movieCalls(), 0, 'filme coberto pelo raspador NÃO consulta o Mico');

      await harvestWorker.harvestOne({ imdbId: 'tt9600002', type: 'series', season: 1, episode: 1, reason: `mico-series-${Date.now()}` } as any);
      assert.equal(seriesCalls(), 0, 'série coberta pelo raspador também NÃO consulta o Mico');
    } finally {
      stub.restore();
    }
  });
});
