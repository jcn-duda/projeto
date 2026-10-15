// Correções da revisão adversarial da Fase 7 (séries do Vaca) — ADAPTADOR:
//   F1 desfechos honestos (cards falhos × sem torrent × terminal), com o
//      requestCost medido carregado também nos throws;
//   F3 custo REAL por HOP (redirect/protetor contam cada um via `onRequest`);
//   F6 `blocked_host` em card sobe erro diagnosticável;
//   F2 descoberta com corte POR KIND (`sinceByKind`) e `completeByKind`.
// Adaptador REAL do profile com fetch dublê — sem rede.
// ORDEM DAS ROTAS IMPORTA: 'season-internal' vem ANTES do prefixo da página.
// Os testes do MOTOR (cursor por kind, truncagem, rótulo F4) estão em
// `crawl-cursor-kinds.test.ts`; os do 2º VETO (B1/B2/magnet/M1) em
// `crawl-series-veto2.test.ts`.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const { createVacaCrawlSite } = await import('../src/providers/crawl-sites/vaca.js');
const { createResolver } = await import('../resolvers/profiles/vacatorrent.js');
import { stubFetch } from './helpers/stub.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { CrawlDiscovery, CrawlSeriesLimits, CrawlWorkResult } from '../src/providers/crawl-types.js';

const SITE = 'https://vaqueirofilmes.com';
const SHOW = `${SITE}/pt/tv-shows/outer-banks/`;
const LIMITS: CrawlSeriesLimits = { enabled: true, maxCards: 10, maxButtons: 40 };
const MAG_T3 = 'magnet:?xt=urn:btih:' + 'd4'.repeat(20);

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
function fail(message: string): never {
  throw new Error(message);
}
function runStub(routes: Record<string, RouteEntry>) {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return typeof body === 'function' ? body(url) : body;
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

function seriesRoutes(opts: {
  internal: string;
  card?: string;
  cardFail?: string;
  button?: (url: string) => RouteResult;
}) {
  const routes: Record<string, RouteEntry> = {
    'season-internal': ok(opts.internal),
    'pt/tv-shows/outer-banks': ok(
      `<html><body><h1>Outer Banks (2020)</h1>`
      + `Avalia&#231;&#227;o da IMDb: <a href="https://www.imdb.com/title/tt13616986/">IMDb</a>`
      + `<a href="${SITE}/pt/season-internal/?show=62658">Temporadas</a></body></html>`,
    ),
  };
  if (opts.card !== undefined) routes['/season/'] = ok(opts.card);
  if (opts.cardFail !== undefined) {
    const message = opts.cardFail;
    routes['/season/'] = () => fail(message);
  }
  if (opts.button) routes['id='] = opts.button;
  return routes;
}

const internalHtml = (cards: string) => `<html><body><div class="sa-grid">${cards}</div></body></html>`;
const cardHtml = (buttons: string) => `<html><body>${buttons}</body></html>`;
const dlBtn = (id: string) =>
  `<div class="dl-btn-wrap"><a href="https://systemtech.space/enc/go.php?id=${id}" class="ss-ep-btn ss-ep-btn-dl">1080p 2 GB</a></div>`;
const CARD_T2 = internalHtml(`<a class="sa-card" href="${SITE}/tv/outer-banks/season/temporada-2/">T2</a>`);
const CARD_T3 = internalHtml(`<a class="sa-card" href="${SITE}/tv/outer-banks/season/temporada-3/">T3</a>`);

describe('F1: desfechos honestos na série (cards falhos × sem torrent)', () => {
  test('cards TODOS falhando → ERRO retentável com o custo medido, nunca no-torrent por 0===0', async () => {
    const stub = runStub(seriesRoutes({ internal: CARD_T2, cardFail: 'http_503' }));
    try {
      const site = createVacaCrawlSite(resolverSurface());
      await assert.rejects(
        () => site.fetchWork(SHOW, { kind: 'tv_show', series: LIMITS }),
        (err: unknown) => {
          assert.match(err instanceof Error ? err.message : String(err), /http_503/, 'o erro real do transporte é a causa');
          assert.equal((err as { requestCost?: number }).requestCost, 3, 'F1: o throw carrega o custo medido (página + internal + card falho)');
          return true;
        },
      );
    } finally { stub.restore(); }
  });

  test('cards OK e NENHUM botão publicado → no-torrent honesto', async () => {
    const stub = runStub(seriesRoutes({
      internal: CARD_T2,
      card: cardHtml('<p>Só player de streaming, sem download.</p>'),
    }));
    try {
      const r: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(r.status, 'no-torrent', 'cards lidos e sem botão é acervo vazio, não erro');
      assert.ok((r.requestCost ?? 0) >= 3, 'custo real da leitura (página + internal + card)');
    } finally { stub.restore(); }
  });

  test('botões TODOS terminais non_magnet (gate-2 com download direto) → no-torrent, sem retry', async () => {
    const driveB64 = Buffer.from('https://drive.google.com/file/d/QATA/view').toString('base64');
    const stub = runStub(seriesRoutes({
      internal: CARD_T3,
      card: cardHtml(dlBtn('gate')),
      button: () => ok(`<html><body><div class="bl" data-link="${driveB64}">Baixar</div></body></html>`),
    }));
    try {
      const r: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(r.status, 'no-torrent', 'non_magnet total é terminal como o expirado (F1)');
    } finally { stub.restore(); }
  });

  test('mistura terminal com falha de rede → erro retentável (a série mantém a régua do filme)', async () => {
    const stub = runStub(seriesRoutes({
      internal: CARD_T3,
      card: cardHtml(dlBtn('gate1') + dlBtn('gate2')),
      button: (url) => (url.includes('gate1')
        ? ok('<html><body>Link inválido ou expirado</body></html>')
        : fail('http_500')),
    }));
    try {
      const site = createVacaCrawlSite(resolverSurface());
      await assert.rejects(
        () => site.fetchWork(SHOW, { kind: 'tv_show', series: LIMITS }),
        (err: unknown) => {
          assert.match(err instanceof Error ? err.message : String(err), /http_500/,
            'terminal misturado com rede NÃO é no-torrent: há torrent talvez vivo');
          assert.equal((err as { requestCost?: number }).requestCost, 5);
          return true;
        },
      );
    } finally { stub.restore(); }
  });
});

describe('F3: custo REAL por HOP (redirect e protetor contam cada um)', () => {
  test('cadeia com redirect: 1 página + 1 internal + 1 card + 2 hops = 5', async () => {
    const stub = runStub(seriesRoutes({
      internal: CARD_T3,
      card: cardHtml(dlBtn('hop')),
      button: (url) => (url.includes('go.php')
        ? redirect(`${SITE}/enc/relay.php?id=hop`)
        : ok(MAG_T3)),
    }));
    try {
      const r: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(r.status, 'done');
      assert.equal(r.requestCost, 5, 'cada fetch do laço conta — o redirect dobra o custo do botão');
    } finally { stub.restore(); }
  });

  test('erro no meio da cadeia: o throw carrega o custo dos hops já gastos', async () => {
    const stub = runStub(seriesRoutes({
      internal: CARD_T3,
      card: cardHtml(dlBtn('boom')),
      button: (url) => (url.includes('go.php')
        ? redirect(`${SITE}/enc/relay.php?id=boom`)
        : fail('http_503')),
    }));
    try {
      const site = createVacaCrawlSite(resolverSurface());
      await assert.rejects(
        () => site.fetchWork(SHOW, { kind: 'tv_show', series: LIMITS }),
        (err: unknown) => {
          assert.match(err instanceof Error ? err.message : String(err), /http_503/);
          assert.equal((err as { requestCost?: number }).requestCost, 5, 'página + internal + card + 2 hops contados antes da falha');
          return true;
        },
      );
    } finally { stub.restore(); }
  });
});

describe('F6: blocked_host em card sobe diagnosticável', () => {
  test('card com host de fora no season-internal → erro blocked_host:<host> na porta', async () => {
    const stub = runStub(seriesRoutes({
      internal: internalHtml(
        `<a class="sa-card" href="https://evil.example/tv/plantada/season/temporada-1/">T1 plantada</a>`
        + `<a class="sa-card" href="${SITE}/tv/outer-banks/season/temporada-2/">T2</a>`,
      ),
    }));
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(SHOW, { kind: 'tv_show', series: LIMITS }),
        /blocked_host:evil\.example/,
        'card adulterado é sintoma de página envenenada: erro de página (site-level), não card tolerado',
      );
    } finally { stub.restore(); }
  });
});

describe('F2 no adaptador: descoberta POR KIND', () => {
  const index = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>${SITE}/movie-sitemap.xml</loc><lastmod>2026-09-01T00:00:00+00:00</lastmod></sitemap>
      <sitemap><loc>${SITE}/tv_show-sitemap.xml</loc><lastmod>2026-09-01T00:00:00+00:00</lastmod></sitemap>
    </sitemapindex>`;

  test('sinceByKind: cada sitemap recebe o SEU corte; tv falho marca só o tv', async () => {
    const stub = runStub({
      'sitemap_index.xml': ok(index),
      'movie-sitemap.xml': ok(`<?xml version="1.0"?><urlset>
        <url><loc>${SITE}/pt/movie/interestelar/</loc><lastmod>2026-09-25T10:00:00+00:00</lastmod></url>
      </urlset>`),
      'tv_show-sitemap.xml': () => fail('http_503'),
    });
    try {
      const disc: CrawlDiscovery = await createVacaCrawlSite(resolverSurface()).discover(
        null,
        { series: LIMITS, sinceByKind: { movie: '2026-09-20T00:00:00+00:00', tv_show: null } },
      );
      assert.equal(disc.complete, false);
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: false }, 'a falha é do tv, não do kind inteiro');
      assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 1, 'filme com lastmod novo passa no SEU corte');
    } finally { stub.restore(); }
  });

  test('since vencido por kind: filme com lastmod velho fica fora (corte do movie)', async () => {
    const stub = runStub({
      'sitemap_index.xml': ok(index),
      'movie-sitemap.xml': ok(`<?xml version="1.0"?><urlset>
        <url><loc>${SITE}/pt/movie/velha/</loc><lastmod>2026-01-01T10:00:00+00:00</lastmod></url>
      </urlset>`),
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover(null, {
        sinceByKind: { movie: '2026-09-20T00:00:00+00:00', tv_show: null },
      });
      assert.equal(disc.urls.length, 0, 'o corte do movie usa o cursor do movie');
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
    } finally { stub.restore(); }
  });
});
