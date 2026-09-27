// 2º VETO da Fase 7 (séries do Vaca) — correções obrigatórias e melhorias:
//   B1 `sinceOf` distingue mapa presente com null EXPLÍCITO — provado na
//      CHAMADA REAL do motor (cursor de filme !=null, tv null): o corte de
//      filme não pode filtrar a carga inicial de séries;
//   B2 QUALQUER truncagem vira `series_truncated` (erro retentável) ANTES de
//      no-torrent — inclusive entries=0, cards sem botões e terminal expirado;
//      sondas A (truncado → erro) e B (controle sem truncagem → no-torrent);
//   terminal REAL do protetor: HTTP 400 com "Link inválido ou expirado";
//   magnet: não paga hop (a cadeia que resolve em Location magnet: custa só
//      os hops feitos);
//   M1 o `requestCost` medido acompanha TODOS os desfechos pós-adaptador
//      (TMDB indisponível, sem obra, defensivo) — série cara custa o real.
// Adaptador e motor REAIS com fetch dublê — sem rede.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
const { createVacaCrawlSite } = await import('../src/providers/crawl-sites/vaca.js');
const { createResolver } = await import('../resolvers/profiles/vacatorrent.js');
import { stubFetch } from './helpers/stub.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { CrawlSeriesLimits, CrawlUrlRow, CrawlWorkResult } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const SITE = 'https://vaqueirofilmes.com';
const SHOW = `${SITE}/pt/tv-shows/outer-banks/`;
const LIMITS: CrawlSeriesLimits = { enabled: true, maxCards: 10, maxButtons: 40 };
const MAG_E5 = 'magnet:?xt=urn:btih:' + 'e5'.repeat(20);

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

function resolverSurface(): VacaResolverSurface {
  return createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: SITE, extraProtectors: [] });
}

interface RouteResult { ok: boolean; status: number; headers: { get(k: string): string | null }; text(): Promise<string> }
type RouteEntry = RouteResult | ((url: string) => RouteResult);
function ok(body: string): RouteResult {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
}
function redirect(location: string): RouteResult {
  return {
    ok: false, status: 302,
    headers: { get: (k: string) => (String(k).toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  };
}
function runStub(routes: Record<string, RouteEntry>) {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return typeof body === 'function' ? body(url) : body;
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

function seriesRoutes(opts: { internal: string; card?: string; button?: (url: string) => RouteResult }) {
  const routes: Record<string, RouteEntry> = {
    'season-internal': ok(opts.internal),
    'pt/tv-shows/outer-banks': ok(
      `<html><body><h1>Outer Banks (2020)</h1>`
      + `Avalia&#231;&#227;o da IMDb: <a href="https://www.imdb.com/title/tt13616986/">IMDb</a>`
      + `<a href="${SITE}/pt/season-internal/?show=62658">Temporadas</a></body></html>`,
    ),
  };
  if (opts.card !== undefined) routes['/season/'] = ok(opts.card);
  if (opts.button) routes['id='] = opts.button;
  return routes;
}

const internalHtml = (cards: string) => `<html><body><div class="sa-grid">${cards}</div></body></html>`;
const cardHtml = (buttons: string) => `<html><body>${buttons}</body></html>`;
const dlBtn = (id: string) =>
  `<div class="dl-btn-wrap"><a href="https://systemtech.space/enc/go.php?id=${id}" class="ss-ep-btn ss-ep-btn-dl">1080p 2 GB</a></div>`;
const CARD_T2 = internalHtml(`<a class="sa-card" href="${SITE}/tv/outer-banks/season/temporada-2/">T2</a>`);
const CARD_T3 = internalHtml(`<a class="sa-card" href="${SITE}/tv/outer-banks/season/temporada-3/">T3</a>`);
const TWO_CARDS = internalHtml(
  CARD_T2 + `<a class="sa-card" href="${SITE}/tv/outer-banks/season/temporada-3/">T3</a>`,
);
const PROTECTOR_400_EXPIRED: RouteResult = {
  ok: false, status: 400,
  headers: { get: () => null },
  text: async () => '<html><body>Link inválido ou expirado</body></html>',
};

describe('B1 na CHAMADA REAL do motor: cursor de filme NÃO vira corte de série', () => {
  test('movie cursor !=null + tv null: série com lastmod ANTERIOR ao cursor de filme entra na fila', async () => {
    const index = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>${SITE}/movie-sitemap.xml</loc><lastmod>2026-09-01T00:00:00+00:00</lastmod></sitemap>
      <sitemap><loc>${SITE}/tv_show-sitemap.xml</loc><lastmod>2026-09-01T00:00:00+00:00</lastmod></sitemap>
    </sitemapindex>`;
    const stub = runStub({
      'sitemap_index.xml': ok(index),
      'movie-sitemap.xml': ok(`<?xml version="1.0"?><urlset>
        <url><loc>${SITE}/pt/movie/nova/</loc><lastmod>2026-09-25T10:00:00+00:00</lastmod></url>
        <url><loc>${SITE}/pt/movie/velha/</loc><lastmod>2026-09-01T10:00:00+00:00</lastmod></url>
      </urlset>`),
      'tv_show-sitemap.xml': ok(`<?xml version="1.0"?><urlset>
        <url><loc>${SITE}/pt/tv-shows/outer-banks/</loc><lastmod>2026-09-01T10:00:00+00:00</lastmod></url>
      </urlset>`),
    });
    try {
      // Estado REAL de uma instalação com filmes já cargados: cursor:movie
      // persistido, séries ainda sem cursor (carga inicial do kind).
      store.engine().setState('vacatorrent', 'cursor:movie', '2026-09-20T00:00:00+00:00');
      Object.assign(config.crawl, {
        sites: ['vacatorrent'],
        seriesEnabled: true, seriesMaxCards: 10, seriesMaxButtons: 40,
      });
      crawler._setSitesForTest((id) => (id === 'vacatorrent' ? createVacaCrawlSite(resolverSurface()) : null));
      crawler.start();
      assert.equal(crawler.status().cursors.movie, '2026-09-20T00:00:00+00:00');
      assert.equal(crawler.status().cursors.tv_show, '');
      crawler._forceDiscoveryForTest();
      await crawler.tick();
      // O motor chama discover(sinceByKind.movie, { sinceByKind }) — ou seja,
      // `since` solto = cursor de filme. B1: o tv_show com null EXPLÍCITO não
      // herda esse corte; o filme com lastmod velho continua fora do SEU.
      assert.ok(
        store.engine().getUrl('vacatorrent', `${SITE}/pt/tv-shows/outer-banks/`),
        'série com lastmod anterior ao cursor de FILME entra na fila (carga inicial de série)',
      );
      assert.ok(store.engine().getUrl('vacatorrent', `${SITE}/pt/movie/nova/`), 'filme novo entra');
      assert.equal(
        store.engine().getUrl('vacatorrent', `${SITE}/pt/movie/velha/`),
        null,
        'filme com lastmod dentro do corte do movie fica fora',
      );
      assert.equal(store.engine().counters('vacatorrent').total, 2);
    } finally { stub.restore(); }
  });
});

describe('B2: QUALQUER truncagem vira series_truncated ANTES de no-torrent', () => {
  test('SONDA A: truncado com 0 magnets e botão terminal expirado → series_truncated, nunca no-torrent', async () => {
    const stub = runStub(seriesRoutes({
      internal: TWO_CARDS,
      card: cardHtml(dlBtn('gate')),
      button: () => PROTECTOR_400_EXPIRED,
    }));
    try {
      const r: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: { enabled: true, maxCards: 1, maxButtons: 40 } });
      assert.equal(r.status, 'error', 'o card NÃO visitado pode ter o torrent — truncagem não vira no-torrent');
      assert.match(r.error || '', /^series_truncated:/);
      assert.match(r.error || '', /cards 1\/2/, 'declara o card que ficou de fora');
    } finally { stub.restore(); }
  });

  test('SONDA B (controle): SEM truncagem, terminal expirado total continua no-torrent honesto', async () => {
    const stub = runStub(seriesRoutes({
      internal: CARD_T2,
      card: cardHtml(dlBtn('gate')),
      button: () => PROTECTOR_400_EXPIRED,
    }));
    try {
      const r: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(r.status, 'no-torrent', 'protetor 400 real = terminal expirado (não é http_400 retentável)');
    } finally { stub.restore(); }
  });
});

describe('F3 complementar: resolver em magnet não paga hop', () => {
  test('cadeia que termina em Location magnet: custa os hops feitos, sem fetch extra', async () => {
    const stub = runStub(seriesRoutes({
      internal: CARD_T3,
      card: cardHtml(dlBtn('mag')),
      button: () => redirect(MAG_E5),
    }));
    try {
      const r: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(r.status, 'done');
      assert.equal(r.requestCost, 4, '1 página + 1 internal + 1 card + 1 hop — o magnet em si custa 0');
    } finally { stub.restore(); }
  });
});

describe('M1: o custo medido acompanha TODOS os desfechos pós-adaptador', () => {
  function claimedTvRow(): CrawlUrlRow {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: '2026-01-01', kind: 'tv_show' }], 1);
    return store.engine().takeNext('fake', 1) as CrawlUrlRow;
  }
  const rel = (hash: string): RawItem => ({
    title: 'Outer Banks (2020) S02E01 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1,
  });
  /** Série CARA (9 requests medidos) — `over` injeta o desfecho do caso. */
  const seriesSite = (over: Record<string, unknown> = {}): any => ({
    id: 'fake', label: 'Fake',
    discover: async () => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async () => ({
      url: SHOW, status: 'done', imdb: null, title: 'Outer Banks', year: 2020, type: 'series',
      groups: [{ season: 2, episode: 1, releases: [rel('a1'.repeat(20))] }],
      requestCost: 9,
      ...over,
    }),
  });
  const collabs = {
    identify: async (): Promise<import('../src/providers/crawl-identify.js').IdentifyResult> =>
      ({ outcome: 'identified', imdb: 'tt1', reason: 'ok' }),
    record: async (): Promise<import('../src/providers/crawl-recorder.js').RecordReport> =>
      ({ kept: 0, added: 0, transition: 'none', cleared: 0 }),
  };

  test('TMDB indisponível: erro retentável carrega o custo real da série cara', async () => {
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'unavailable', imdb: null, reason: 'timeout' }),
      record: collabs.record,
    });
    const outcome = await process(seriesSite(), claimedTvRow(), { dryRun: false });
    assert.equal(outcome.kind, 'error');
    assert.match(outcome.detail || '', /tmdb-indisponivel/);
    assert.equal(outcome.requestCost, 9, 'a falha DEPOIS do adaptador não perde o que a página gastou');
  });

  test('sem obra (unidentified): no-work carrega o custo real', async () => {
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'unidentified', imdb: null, reason: 'ambiguous' }),
      record: collabs.record,
    });
    const outcome = await process(seriesSite(), claimedTvRow(), { dryRun: false });
    assert.equal(outcome.kind, 'no-work');
    assert.equal(outcome.requestCost, 9, 'série cara sem obra custa o que custou — não 1');
  });

  test('defensivo (done sem release nenhuma): no-torrent carrega o custo real', async () => {
    const process = createPageProcessor({ ...collabs });
    const outcome = await process(seriesSite({ groups: [] }), claimedTvRow(), { dryRun: false });
    assert.equal(outcome.kind, 'no-torrent');
    assert.equal(outcome.requestCost, 9);
  });
});
