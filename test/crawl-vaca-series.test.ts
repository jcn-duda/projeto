// Fase 7 (séries) do Vaca: descoberta tv_show-sitemap (gated), adaptador de
// série (página → season-internal → cards → protetor), pack × episódio, tetos
// de cards/botões, custo REAL de requisições no teto horário e gravação por
// locação declarada (S/E, S, raiz). Fixtures reais do piloto filme + mínimos
// novos; adaptador é o PROFILE REAL com fetch dublê — sem rede, e o motor NUNCA
// roda contra o Vaca de verdade (dublês injetados).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
const {
  seasonFromCardSlug, groupSeriesReleases,
} = await import('../src/providers/crawl-sites/vaca-series.js');
const { declaredSeriesLocation } = await import('../src/providers/crawl-sites/vaca-series-locate.js');
const { createResolver } = await import('../resolvers/profiles/vacatorrent.js');
const { createVacaCrawlSite } = await import('../src/providers/crawl-sites/vaca.js');
import { stubFetch } from './helpers/stub.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow, CrawlSeriesLimits, CrawlWorkResult } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'crawl', 'vaca');
const FIX2 = path.join(__dirname, 'fixtures', 'vacatorrent');
const fixture = (name: string, base = FIX) => fs.readFileSync(path.join(base, name), 'utf8');

const SITE = 'https://vaqueirofilmes.com';
const SHOW = `${SITE}/pt/tv-shows/outer-banks/`;
const LIMITS: CrawlSeriesLimits = { enabled: true, maxCards: 10, maxButtons: 40 };

const MAG_E01 = 'magnet:?xt=urn:btih:' + 'a1'.repeat(20);
const MAG_E02 = 'magnet:?xt=urn:btih:' + 'b2'.repeat(20);
const MAG_BATCH = 'magnet:?xt=urn:btih:' + 'c3'.repeat(20);

function resolverSurface(): VacaResolverSurface {
  return createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: SITE, extraProtectors: [] });
}

/** Rotas da série: show → season-internal → cards → botões → magnet. */
function seriesRoutes(): Record<string, () => string> {
  return {
    'pt/tv-shows/outer-banks': () => fixture('tv-show-page.html'),
    'season-internal': () => fixture('season-internal-mixed.html'),
    '/season/': () => fixture('season-card-episodes.html'),
    'batch-sacrificio': () => fixture('batch.html', FIX2),
    'id=obx-s02e01': () => MAG_E01,
    'id=obx-s02e02': () => MAG_E02,
    'id=mDD': () => MAG_BATCH,
  };
}

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['fake'], delayMs: 0,
    maxPerHour: 1000, idleWindowMs: 0, maxTries: 2, layoutCanary: 10,
    seriesEnabled: false, seriesMaxCards: 10, seriesMaxButtons: 40,
  });
});

after(() => {
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

function runStub(routes: Record<string, () => string>) {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => body() };
      }
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

describe('crawl-sites/vaca Fase 7: descoberta de séries (gated)', () => {
  test('OFF (default): tv_show-sitemap e batch-sitemap não são consultados', async () => {
    const stub = runStub({
      'sitemap_index.xml': () => fixture('sitemap-index-series.xml'),
      'movie-sitemap.xml': () => fixture('movie-sitemap-min.xml'),
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover();
      assert.equal(disc.complete, true);
      assert.ok(disc.urls.every((u) => u.kind === 'movie'));
      const fetched = stub.calls.map((c) => c.url);
      assert.ok(!fetched.some((u) => u.includes('tv_show-sitemap')), 'sitemap de série fora com knob off');
      assert.ok(!fetched.some((u) => u.includes('batch-sitemap')), 'batch-sitemap fica FORA explicitamente');
    } finally { stub.restore(); }
  });

  test('ON: séries entram com tipo tv_show; listagem /tv-shows/ e batch-sitemap ficam fora', async () => {
    const stub = runStub({
      'sitemap_index.xml': () => fixture('sitemap-index-series.xml'),
      'movie-sitemap.xml': () => fixture('movie-sitemap-min.xml'),
      'tv_show-sitemap.xml': () => fixture('tv-show-sitemap.xml'),
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover(null, { series: LIMITS });
      assert.equal(disc.complete, true);
      const tv = disc.urls.filter((u) => u.kind === 'tv_show');
      assert.equal(tv.length, 2, 'só séries com slug (a listagem /tv-shows/ fica fora)');
      assert.ok(tv.every((u) => /\/pt\/tv-shows\/[^/]+\/$/.test(new URL(u.url).pathname)));
      assert.ok(!disc.urls.some((u) => /\/tv-shows\/$/.test(new URL(u.url).pathname)), 'arquivo /tv-shows/ excluído');
      assert.equal(stub.calls.filter((c) => c.url.includes('batch-sitemap')).length, 0);
    } finally { stub.restore(); }
  });

  test('host safety: loc do índice fora do site NEM É consultado; loc adulterada no sitemap não entra na fila', async () => {
    const index = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://evil.example/tv_show-sitemap.xml</loc><lastmod>2026-09-26T21:00:00+00:00</lastmod></sitemap>
      <sitemap><loc>${SITE}/tv_show-sitemap2.xml</loc><lastmod>2026-09-26T21:00:00+00:00</lastmod></sitemap>
    </sitemapindex>`;
    const tvXml = `<?xml version="1.0"?><urlset>
      <url><loc>https://evil.example/pt/tv-shows/plantada/</loc><lastmod>2026-09-26T21:00:00+00:00</lastmod></url>
      <url><loc>${SITE}/pt/tv-shows/outer-banks/</loc><lastmod>2026-09-26T21:00:00+00:00</lastmod></url>
    </urlset>`;
    const stub = runStub({
      'sitemap_index.xml': () => index,
      'tv_show-sitemap2.xml': () => tvXml,
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover(null, { series: LIMITS });
      assert.equal(stub.calls.filter((c) => c.url.includes('evil.example')).length, 0, 'host de fora não é consultado');
      assert.deepEqual(disc.urls.map((u) => u.url), [`${SITE}/pt/tv-shows/outer-banks/`]);
    } finally { stub.restore(); }
  });

  test('parcial: tv_show-sitemap falho NÃO derruba a rodada (complete:false) e o movie entra', async () => {
    const stub = runStub({
      'sitemap_index.xml': () => fixture('sitemap-index-series.xml'),
      'movie-sitemap.xml': () => fixture('movie-sitemap-min.xml'),
      'tv_show-sitemap.xml': () => { throw new Error('http_503'); },
    });
    try {
      const disc: CrawlDiscovery = await createVacaCrawlSite(resolverSurface()).discover(null, { series: LIMITS });
      assert.equal(disc.complete, false, 'falha parcial: cursor não anda');
      assert.equal(disc.failures.length, 1);
      assert.ok(disc.failures[0].includes('tv_show-sitemap.xml'));
      assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 1, 'URLs colhidas seguem válidas');
    } finally { stub.restore(); }
  });
});

describe('crawl-sites/vaca Fase 7: slug de temporada e agrupamento por locação', () => {
  test('seasonFromCardSlug: temporada-N, ordinais pt e desconhecido conservador', () => {
    assert.equal(seasonFromCardSlug(`${SITE}/tv/x/season/temporada-5/`), 5);
    assert.equal(seasonFromCardSlug(`${SITE}/tv/x/season/2a-temporada/`), 2);
    assert.equal(seasonFromCardSlug(`${SITE}/tv/x/season/2%C2%AA-temporada/`), 2, 'ª URL-encodada');
    assert.equal(seasonFromCardSlug(`${SITE}/tv/x/season/10o-temporada/`), 10);
    assert.equal(seasonFromCardSlug(`${SITE}/tv/x/season/especial/`), null, 'slug sem temporada: null');
    assert.equal(seasonFromCardSlug(`${SITE}/batch/batch-sacrificio-de-sangue-s05/`), null, 'batch: null (conservador)');
    assert.equal(seasonFromCardSlug('lixo'), null);
  });

  test('groupSeriesReleases: episódio na chave S/E; pack só S; card sem temporada vai à raiz', () => {
    const rel = (hash: string, title: string): RawItem => ({
      title, magnet: `magnet:?xt=urn:btih:${hash}`, indexer: 'vacatorrent', tracker: 'Vaca', isBr: true, seeders: 1,
    });
    const groups = groupSeriesReleases([
      { release: rel('a1'.repeat(20), 'Série S02E01 1080p DUBLADO'), request: { season: 2, episode: 1 } },
      { release: rel('b2'.repeat(20), 'Série S02E02 1080p DUBLADO'), request: { season: 2, episode: 2 } },
      { release: rel('c3'.repeat(20), 'BATCH Série S02'), request: { season: 2, episode: null } },
      { release: rel('d4'.repeat(20), 'Série Especial'), request: { season: null, episode: null } },
    ]);
    const keyOf = (g: { season: number | null; episode: number | null }) => `${g.season}:${g.episode}`;
    const byKey = new Map(groups.map((g) => [keyOf(g), g]));
    assert.deepEqual([...byKey.keys()].sort(), ['2:1', '2:2', '2:null', 'null:null']);
    // Mesma régua do releaseWorkTargets: release de UM episódio só na chave
    // S/E (o lookup do índice a alcança por merge); pack fica na chave S.
    assert.equal(byKey.get('2:1')?.releases.length, 1);
    assert.equal(byKey.get('2:2')?.releases.length, 1);
    assert.equal(byKey.get('2:null')?.releases.length, 1, 'S só o pack');
    assert.equal(byKey.get('null:null')?.releases.length, 1, 'raiz só o card sem temporada');
  });
});

describe('crawl-sites/vaca Fase 7: fetchWork de série (fixtures reais, sem rede)', () => {
  test('página → season-internal → cards → protetor: grupos S/E e raiz, requestCost medido', async () => {
    const stub = runStub(seriesRoutes());
    try {
      const result: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'series');
      assert.equal(result.title, 'Outer Banks');
      assert.equal(result.year, 2020);
      assert.equal(result.imdb, 'tt13616986', 'IMDb ancorado na ficha técnica');
      const groups = result.groups ?? [];
      const byKey = new Map(groups.map((g) => [`${g.season}:${g.episode}`, g]));
      // Cards: temporada-2 (parser) + 2a-temporada (slug ordinal, mesma página
      // ⇒ mesmos hashes ⇒ dedupe no registro). O batch de OUTRA série declara
      // S05 no realTitle ("BATCH – Sacrifício de Sangue S05") — pela evidência
      // (Fase 7 v2) ele vai para {5,null}, não mais para a raiz. Episódio fica
      // na chave S/E (régua do releaseWorkTargets).
      const e01 = byKey.get('2:1');
      assert.ok(e01, 'grupo S02E01 existe');
      assert.match(e01!.releases[0].title || '', /Outer Banks \(2020\) S02E01/, 'título por-episódio sai SxxEyy');
      assert.match(e01!.releases[0].title || '', /2\.10 GB/, 'tamanho real do botão');
      assert.ok(byKey.has('2:2'), 'grupo S02E02 existe');
      assert.equal(byKey.has('2:null'), false, 'sem botão de pack não há grupo de temporada');
      const s5 = byKey.get('5:null');
      assert.ok(s5, 'batch com temporada declarada no realTitle vai para S05 (evidência v2)');
      assert.equal(byKey.has('null:null'), false, 'nada cai na raiz sem evidência de série inteira');
      // Custo REAL: 1 página + 1 season-internal + 4 cards + 7 botões (os
      // cards repetidos re-buscam o mesmo magnet; o dedupe por hash é no
      // registro, não na rede).
      assert.equal(result.requestCost, 13);
      assert.equal(stub.calls.length, 13, 'cada request do dublê é contado uma vez');
    } finally { stub.restore(); }
  });

  test('caps: teto de cards/botões corta a leitura e vira partial com progresso (NUNCA done) — F5 v2', async () => {
    const capped = runStub(seriesRoutes());
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const r2 = await site.fetchWork(SHOW, { kind: 'tv_show', series: { enabled: true, maxCards: 2, maxButtons: 40 } });
      const cardFetches = capped.calls.filter((c) => /\/season\/|batch-sacrificio/.test(c.url)).length;
      assert.equal(cardFetches, 2, 'só 2 cards visitados');
      // F5 v2: página cortada pelo teto NÃO é done silencioso nem erro de
      // site — é `partial` com progresso retomável e grupos preservados; a
      // retomada (resume) completa em passes sem recomeçar do zero.
      assert.equal(r2.status, 'partial');
      assert.match(r2.error || '', /^series_truncated:/);
      assert.match(r2.error || '', /cards 2\/4/, 'declara quanto ficou de fora');
      assert.ok(r2.progress, 'partial carrega progresso');
      assert.equal(r2.progress!.doneCards.length, 2, 'os 2 cards lidos entraram no checkpoint');
      assert.equal(r2.progress!.totalCards, 4);
      assert.ok((r2.groups ?? []).length > 0, 'grupos coletados NÃO são descartados');
    } finally { capped.restore(); }
    const btnCap = runStub(seriesRoutes());
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const r3 = await site.fetchWork(SHOW, { kind: 'tv_show', series: { enabled: true, maxCards: 10, maxButtons: 1 } });
      // 1 botão seguido ⇒ para antes do 2º botão e não visita mais cards.
      const buttons = btnCap.calls.filter((c) => c.url.includes('systemtech')).length;
      assert.equal(buttons, 1, 'teto de botões respeitado');
      assert.equal(r3.requestCost, 4, '1 página + 1 internal + 1 card + 1 botão');
      assert.equal(r3.status, 'partial', 'teto de botão atingido também não é done');
      assert.match(r3.error || '', /^series_truncated:/);
      assert.equal(r3.progress!.card?.skip, 1, 'checkpoint NO botão onde cortou');
    } finally { btnCap.restore(); }
    // O freio anti-loop de estagnação (series_stall) é exercitado em
    // test/crawl-series-resume.test.ts; aqui fica o contrato do ERRO puro do
    // motor — URL que falha de verdade acumula tries e dorme após maxTries.
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: '2026-01-01', kind: 'tv_show' }], 1);
    const truncSite: CrawlSite = {
      id: 'fake', label: 'Fake',
      discover: async () => ({ urls: [], complete: true, failures: [] }),
      fetchWork: async (u) => ({ url: u, status: 'error', error: 'series_stall: progresso não avançou (cards 2/4)', type: 'series' }),
    };
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'identified', imdb: 'tt1', reason: 'ok' }),
      record: async () => ({ kept: 0, added: 0, transition: 'none', cleared: 0 }),
    });
    for (let i = 0; i < 2; i += 1) {
      const row = store.engine().takeNext('fake', 1) as CrawlUrlRow;
      await process(truncSite, row, { dryRun: true, maxTries: 2 });
      if (i === 0) store.engine().requeueUrl('fake', SHOW);
    }
    const slept = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(slept.tries, 2, 'tentativas acumulam no erro de estagnação');
    assert.ok(slept.nextAt > Date.now(), 'após maxTries a URL dorme (backoff longo, sem loop eterno) — o operador usa "Reprocessar erros"');
  });

  test('host safety: season-internal apontando para host de fora é erro, nunca no-torrent', async () => {
    const EVIL = Buffer.from('https://evil.example/pt/season-internal/?show=62658').toString('base64');
    const evil = runStub({
      'pt/tv-shows/outer-banks': () => fixture('tv-show-page.html')
        .replace('aHR0cHM6Ly92YXF1ZWlyb2ZpbG1lcy5jb20vcHQvc2Vhc29uLWludGVybmFsLz9zaG93PTYyNjU4', EVIL),
    });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(SHOW, { kind: 'tv_show', series: LIMITS }),
        /blocked_host:evil\.example/,
      );
    } finally { evil.restore(); }
  });

  test('série sem season-internal: no-torrent honesto', async () => {
    const stub = runStub({ 'pt/tv-shows/outer-banks': () => '<html><body><h1>Sem links (2020)</h1></body></html>' });
    try {
      const r = await createVacaCrawlSite(resolverSurface()).fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(r.status, 'no-torrent');
      assert.equal(r.groups, undefined);
    } finally { stub.restore(); }
  });
});

describe('crawl-page Fase 7: gravação por locação (S/E, S, raiz), sempre partial', () => {
  /** Linha tv_show REAL no store (o markResult ignora URL desconhecida). */
  function claimedRow(kind: 'tv_show' | 'movie'): CrawlUrlRow {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: '2026-01-01', kind }], 1);
    return store.engine().takeNext('fake', 1) as CrawlUrlRow;
  }
  const rel = (hash: string): RawItem => ({
    title: 'Outer Banks (2020) S02 1080p DUBLADO', magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'vacatorrent', tracker: 'Vaca', isBr: true, seeders: 1,
  });
  const seriesSite = (over: Partial<CrawlSite> = {}): CrawlSite => ({
    id: 'fake', label: 'Fake',
    discover: async () => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async () => ({
      url: SHOW, status: 'done', imdb: 'tt1', title: 'Outer Banks', year: 2020, type: 'series',
      groups: [
        { season: 2, episode: 1, releases: [rel('a1'.repeat(20))] },
        { season: 2, episode: null, releases: [rel('b2'.repeat(20))] },
        { season: null, episode: null, releases: [rel('c3'.repeat(20))] },
      ],
      requestCost: 9,
    }),
    ...over,
  });

  test('UM registro por grupo com a locação declarada; partial+keepPartial sempre', async () => {
    const recorded: Array<{ location: unknown; items: number }> = [];
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'identified', imdb: 'tt1', reason: 'ok' }),
      record: async (_site, _obra, releases, location) => {
        recorded.push({ location, items: releases.length });
        return { kept: releases.length, added: releases.length, transition: 'none', cleared: 0 };
      },
    });
    const outcome = await process(seriesSite(), claimedRow('tv_show'), { dryRun: false });
    assert.equal(outcome.kind, 'done');
    assert.equal(outcome.releases, 3);
    assert.equal(outcome.addedNew, 3);
    assert.equal(outcome.requestCost, 9);
    assert.deepEqual(recorded, [
      { location: { season: 2, episode: 1 }, items: 1 },
      { location: { season: 2, episode: null }, items: 1 },
      { location: { season: null, episode: null }, items: 1 },
    ]);
    assert.equal(store.engine().getUrl('fake', SHOW)?.status, 'done');
    assert.equal(store.engine().getUrl('fake', SHOW)?.releases, 3);
  });

  test('recorder de produção: cada grupo grava na CHAVE da locação, partial e keepPartial', async () => {
    const rec = await import('../src/providers/crawl-recorder.js');
    const calls: Array<{ loc: unknown; partial: unknown; keep: unknown; ctx: unknown[] }> = [];
    const recorder = rec.createCrawlRecorder({
      buildContext: async () => ({ names: ['Outer Banks'], year: 2020, isSeries: true, season: 2, episode: 1 }),
      captureAndMark: (_e, _s, _i, ctx) => {
        assert.equal((ctx as { season: number }).season, 2, 'capture leva a locação no ctx');
        return true;
      },
      flush: () => ({ ok: true, written: 0 }),
      lookupQuiet: () => [],
      isPartial: () => false,
      record: (imdb, loc, _items, opts) => {
        calls.push({ loc, partial: opts.partial, keep: opts.keepPartial, ctx: [] });
        assert.equal(imdb, 'tt1');
        return 1;
      },
      transition: () => 'none', invalidate: () => 0, count: () => {},
    });
    await recorder.record('vacatorrent', { imdb: 'tt1', title: 'Outer Banks', year: 2020, kind: 'tv_show' }, [rel('a1'.repeat(20))], { season: 2, episode: 1 });
    assert.deepEqual(calls.map((c) => ({ loc: c.loc, partial: c.partial, keep: c.keep })), [
      { loc: { season: 2, episode: 1 }, partial: true, keep: true },
    ]);
  });

  test('dry-run: série fica `simulated` UMA vez com o total de releases; nada gravado', async () => {
    let recorded = 0;
    const process = createPageProcessor({
      identify: async () => ({ outcome: 'identified', imdb: 'tt1', reason: 'ok' }),
      record: async () => { recorded += 1; return { kept: 0, added: 0, transition: 'none', cleared: 0 }; },
    });
    const outcome = await process(seriesSite(), claimedRow('tv_show'), { dryRun: true });
    assert.equal(outcome.kind, 'simulated');
    assert.equal(outcome.releases, 3);
    assert.equal(recorded, 0, 'dry-run não grava locação nenhuma');
    assert.equal(store.engine().getUrl('fake', SHOW)?.status, 'simulated');
  });
});
