// Adaptador de raspagem do Mico Leão Dublado — SÉRIES (Fase 2,
// `crawl-sites/mico-series.ts` + orquestração em `mico.ts`). Cobre, contra
// fixtures no formato REAL da API:
//   - `listTargetEpisodes` (pura): episódios NÃO exibidos (sem data ou data
//     futura) ficam FORA e o teto de temporadas mais recentes é respeitado;
//   - `fetchWork` de série: groups na locação certa (S/E), progresso retomável
//     MONOTÔNICO (`partial` → resume → `done`, doneCards só cresce), série sem
//     episódio-alvo e série sem meta (erro retentável, nunca no-torrent);
//   - `discover`: emite `tv_show` SÓ com `opts.series.enabled`, com dedupe por
//     IMDb, skip DINÂMICO e `bucketLastmod` de 30 dias (mais longo que filme);
//     honra `Retry-After` num 429 (review FIX 2) e NÃO dá por completa uma
//     descoberta que saiu truncada pelo teto de páginas (review FIX 5).
// O colhedor (pula filme E série quando coberto) é testado em crawl-mico.test.ts.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const micoCrawl = await import('../src/providers/crawl-sites/mico.js');
const micoSeries = await import('../src/providers/crawl-sites/mico-series.js');
const { stubFetch } = await import('./helpers/stub.js');
const { strideAt } = await import('../src/providers/crawl-sites/mico-shared.js');

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'crawl', 'mico');
const read = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const HOST = config.mico.url;
const synthetic = (kind: 'movie' | 'series', tt: string) => `${HOST}/crawl/${kind}/${tt}/`;
const REREAD = micoSeries.SERIES_REREAD_DAYS; // 30 (séries)

const savedMico = { ...config.mico };

beforeEach(() => {
  config.mico.enabled = true;
  config.mico.crawlMinGapMs = 0;
  config.mico.crawlRereadDays = 14;
  config.mico.crawlSeriesMaxSeasons = 2;
  micoCrawl._resetThrottleForTest();
});

after(() => {
  Object.assign(config.mico, savedMico);
  micoCrawl._resetThrottleForTest();
});

/** Resposta do dublê: `{status:N}` vira erro; qualquer outro corpo vira 200. */
function resp(r: any) {
  if (r == null) return { ok: false, status: 404, json: async () => ({}) };
  if (typeof r.status === 'number') {
    return { ok: false, status: r.status, json: async () => ({}), headers: { get: () => r.retryAfter ?? null } } as any;
  }
  return { ok: true, status: 200, json: async () => r };
}

/** Dublê que roteia catálogo (filme/série por skip), stream de episódio e a
 * meta de série da Cinemeta (getMeta bate em v3-cinemeta.strem.io). */
function seriesStub(routes: {
  movieCatalog?: Record<number, any>;
  seriesCatalog?: Record<number, any>;
  episode?: (tt: string, s: number, e: number) => any;
  meta?: (tt: string) => any;
}) {
  return stubFetch((url) => {
    const mc = /\/catalog\/movie\/MicoFilmes\/skip=(\d+)\.json/.exec(url);
    // `skip` sem rota = catálogo esgotado (a API real responde 200 com `metas: []`).
    if (mc) return resp(routes.movieCatalog?.[Number(mc[1])] ?? { metas: [] });
    const sc = /\/catalog\/series\/MicoSeries\/skip=(\d+)\.json/.exec(url);
    if (sc) return resp(routes.seriesCatalog?.[Number(sc[1])] ?? { metas: [] });
    const ep = /\/stream\/series\/(tt\d+):(\d+):(\d+)\.json/.exec(url);
    if (ep) return resp(routes.episode?.(ep[1], Number(ep[2]), Number(ep[3])));
    const cm = /v3-cinemeta\.strem\.io\/meta\/series\/(tt\d+)\.json/.exec(url);
    if (cm) return resp(routes.meta?.(cm[1]));
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

const seriesOpts = (maxButtons: number, resume?: any) => ({
  kind: 'tv_show' as const,
  series: { enabled: true, maxCards: 0, maxButtons },
  ...(resume ? { resume } : {}),
});

describe('listTargetEpisodes (pura): filtro de exibidos + teto de temporadas', () => {
  // 3 temporadas; a 3 tem E03 futuro e E04 SEM data (não confirmado → fora).
  const meta = {
    episodes: { '3': 4, '2': 3, '1': 2 },
    episodeAired: {
      '3:1': '2022-05-27T00:00:00.000Z',
      '3:2': '2022-05-27T00:00:00.000Z',
      '3:3': '2099-01-01T00:00:00.000Z', // futura → fora
      // '3:4' ausente → sem data → fora
      '2:1': '2017-10-27T00:00:00.000Z',
      '2:2': '2017-10-27T00:00:00.000Z',
      '2:3': '2017-10-27T00:00:00.000Z',
      '1:1': '2016-07-15T00:00:00.000Z',
      '1:2': '2016-07-15T00:00:00.000Z',
    },
  };
  const now = Date.UTC(2026, 9, 2);
  const keys = (list: Array<{ season: number; episode: number }>) => list.map((x) => `${x.season}:${x.episode}`);

  test('episódios NÃO exibidos (data futura ou sem data) ficam FORA', () => {
    const got = keys(micoSeries.listTargetEpisodes(meta, 3, now));
    assert.ok(!got.includes('3:3'), 'data futura excluída');
    assert.ok(!got.includes('3:4'), 'sem episodeAired excluído');
  });

  test('teto de temporadas: só as N mais recentes, da mais nova para trás', () => {
    assert.deepEqual(keys(micoSeries.listTargetEpisodes(meta, 1, now)), ['3:1', '3:2']);
    assert.deepEqual(keys(micoSeries.listTargetEpisodes(meta, 2, now)), ['3:1', '3:2', '2:1', '2:2', '2:3']);
    assert.deepEqual(
      keys(micoSeries.listTargetEpisodes(meta, 3, now)),
      ['3:1', '3:2', '2:1', '2:2', '2:3', '1:1', '1:2'],
    );
  });

  test('meta vazia/sem episódios → nenhuma alvo', () => {
    assert.deepEqual(micoSeries.listTargetEpisodes(null, 2, now), []);
    assert.deepEqual(micoSeries.listTargetEpisodes({ episodes: {} }, 2, now), []);
  });
});

describe('fetchWork (série): groups por locação + progresso retomável', () => {
  test('todos os episódios-alvo cabem no passe → done, groups na locação certa', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({
      meta: () => read('meta-series.json'),
      episode: () => read('stream-episode.json'),
    });
    try {
      const work = await site.fetchWork(synthetic('series', 'tt4574334'), seriesOpts(10));
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'series');
      assert.equal(work.imdb, 'tt4574334');
      assert.equal(work.requestCost, 5, 'uma chamada de stream por episódio-alvo (5)');
      const groups = work.groups ?? [];
      assert.deepEqual(
        groups.map((g) => `${g.season}:${g.episode}`),
        ['3:1', '3:2', '2:1', '2:2', '2:3'],
        'cada grupo leva a locação S/E correta, sem os não exibidos',
      );
      assert.ok(groups.every((g) => g.releases.length >= 1), 'todo grupo tem releases');
      assert.equal(groups[0].releases[0].indexer, 'mico');
      assert.deepEqual(work.progress?.doneCards?.slice().sort(), ['2:1', '2:2', '2:3', '3:1', '3:2']);
      assert.equal(work.progress?.totalCards, 5);
      // Nenhuma chamada ao stream de episódio NÃO exibido (3:3 futuro, 3:4 sem data).
      const epSkips = stub.calls.filter((c) => c.url.includes('/stream/series/')).map((c) => /:(\d+):(\d+)\.json/.exec(c.url)!.slice(1).join(':'));
      assert.deepEqual(epSkips, ['3:1', '3:2', '2:1', '2:2', '2:3']);
    } finally {
      stub.restore();
    }
  });

  test('retomada: passe curto faz partial; o seguinte com resume continua e doneCards só cresce', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({
      meta: () => read('meta-series.json'),
      episode: () => read('stream-episode.json'),
    });
    try {
      // Passe 1: teto de 2 episódios → partial com 2 doneCards e 3 pendentes.
      const p1 = await site.fetchWork(synthetic('series', 'tt0944947'), seriesOpts(2));
      assert.equal(p1.status, 'partial');
      assert.equal(p1.requestCost, 2, 'só os 2 episódios do teto neste passe');
      assert.deepEqual(p1.progress?.doneCards, ['3:1', '3:2']);
      assert.equal(p1.progress?.totalCards, 5);
      assert.match(String(p1.error), /series_truncated/);

      // Passe 2: retoma do progresso; teto largo conclui os 3 pendentes.
      const p2 = await site.fetchWork(synthetic('series', 'tt0944947'), seriesOpts(10, p1.progress));
      assert.equal(p2.status, 'done');
      assert.equal(p2.requestCost, 3, 'só os 3 episódios que faltavam (os 2 feitos não repetem)');
      const done2 = p2.progress?.doneCards ?? [];
      assert.equal(done2.length, 5, 'doneCards cresceu para o total');
      for (const card of p1.progress?.doneCards ?? []) {
        assert.ok(done2.includes(card), `MONOTÔNICO: ${card} do passe 1 continua no passe 2`);
      }
      assert.deepEqual(done2.slice().sort(), ['2:1', '2:2', '2:3', '3:1', '3:2']);
    } finally {
      stub.restore();
    }
  });

  test('episódios sem stream (vazios) e sem resume → no-torrent, sem groups', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({
      meta: () => read('meta-series.json'),
      episode: () => read('stream-empty.json'),
    });
    try {
      const work = await site.fetchWork(synthetic('series', 'tt0903747'), seriesOpts(10));
      assert.equal(work.status, 'no-torrent');
      assert.equal(work.requestCost, 5, 'consultou os 5 episódios, nenhum tinha stream');
      assert.equal((work.groups ?? []).length, 0);
    } finally {
      stub.restore();
    }
  });

  test('série sem NENHUM episódio-alvo (meta sem vídeos) → no-torrent, sem rede de stream', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({
      meta: () => ({ meta: { name: 'Sem Vídeos', year: '2020', type: 'series', videos: [] } }),
      episode: () => read('stream-episode.json'),
    });
    try {
      const work = await site.fetchWork(synthetic('series', 'tt2861424'), seriesOpts(10));
      assert.equal(work.status, 'no-torrent');
      assert.equal(work.requestCost, 0, 'nenhuma chamada ao Mico (só a meta da Cinemeta)');
      assert.equal(stub.calls.filter((c) => c.url.includes('/stream/series/')).length, 0);
    } finally {
      stub.restore();
    }
  });

  test('série SEM meta da Cinemeta (404) → erro RETENTÁVEL com custo 0 (não no-torrent)', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({ meta: () => ({ status: 404 }), episode: () => read('stream-episode.json') });
    try {
      await assert.rejects(
        () => site.fetchWork(synthetic('series', 'tt0000404'), seriesOpts(10)),
        (err: Error & { requestCost?: number }) => {
          assert.equal(err.requestCost, 0, 'falha transitória não pode dormir a obra por 30 dias');
          return true;
        },
      );
    } finally {
      stub.restore();
    }
  });
});

describe('discover (séries): tv_show só com opts.series.enabled', () => {
  const movieRoutes = { 0: read('catalog-skip-0.json') };
  const seriesRoutes = {
    0: read('catalog-series-skip-0.json'),
    25: read('catalog-series-skip-3.json'),
  };

  test('sem opts.series.enabled → NÃO emite tv_show nem consulta o catálogo de série', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({ movieCatalog: movieRoutes, seriesCatalog: seriesRoutes });
    try {
      const found = await site.discover(null);
      assert.ok(found.urls.length > 0);
      assert.ok(found.urls.every((u) => u.kind === 'movie'), 'nenhum tv_show sem séries habilitadas');
      assert.deepEqual(found.completeByKind, { movie: true, tv_show: true }, 'tv_show=true (fonte não consultada)');
      assert.equal(stub.calls.filter((c) => c.url.includes('/catalog/series/')).length, 0);
    } finally {
      stub.restore();
    }
  });

  test('com opts.series.enabled → tv_show com dedupe, passo fixo e bucketLastmod de 30 dias', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({ movieCatalog: movieRoutes, seriesCatalog: seriesRoutes });
    const now = Date.now();
    try {
      const found = await site.discover(null, { series: { enabled: true, maxCards: 0, maxButtons: 0 } });
      const shows = found.urls.filter((u) => u.kind === 'tv_show');
      // 3 (página 1) + 2 (página 2, tt0903747 duplicado) = 4 séries únicas.
      assert.equal(shows.length, 4, 'dedupe por IMDb remove a repetição entre páginas');
      const ids = shows.map((u) => /\/crawl\/series\/(tt\d+)\//.exec(u.url)![1]);
      assert.deepEqual(ids, ['tt4574334', 'tt0944947', 'tt0903747', 'tt2861424']);
      assert.equal(ids.filter((t) => t === 'tt0903747').length, 1, 'duplicata contada uma vez');
      assert.equal(shows[0].url, synthetic('series', 'tt4574334'), 'URL sintética de série');
      // lastmod de SÉRIE usa o balde de 30 dias (REREAD), não o de filme (14).
      for (const u of shows) {
        const tt = /\/crawl\/series\/(tt\d+)\//.exec(u.url)![1];
        assert.equal(u.lastmod, micoCrawl.bucketLastmod(tt, now, REREAD), `balde de ${REREAD} dias`);
      }
      assert.deepEqual(found.completeByKind, { movie: true, tv_show: true });
      // Passo fixo (25 abaixo de 1000): 0, 25 e depois as vazias do fim.
      const skips = [...new Set(stub.calls.filter((c) => c.url.includes('/catalog/series/')).map((c) => Number(/skip=(\d+)/.exec(c.url)![1])))];
      assert.deepEqual(skips, [0, 25, 50, 75, 100, 125]);
      // requestCost soma filme (1 página + 4 vazias x 3) e série (2 páginas + 4 vazias x 3).
      assert.equal(found.requestCost, (1 + 4 * 3) + (2 + 4 * 3));
    } finally {
      stub.restore();
    }
  });

  test('429 com Retry-After na descoberta → honra a espera antes da próxima página', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({
      movieCatalog: { 0: read('catalog-skip-0.json'), 5: read('catalog-empty.json') },
      // página 0 de série → 429 com Retry-After de 1 s; o catch chama
      // `honorRetryAfter` e o throttle adia a página seguinte (passo fixo).
      seriesCatalog: { 0: { status: 429, retryAfter: '1' } },
    });
    try {
      const t0 = Date.now();
      await site.discover(null, { series: { enabled: true, maxCards: 0, maxButtons: 0 } });
      const elapsed = Date.now() - t0;
      // Margem folgada de relógio real: Retry-After é 1000 ms, cobra >= 700.
      assert.ok(elapsed >= 700, `honrou o Retry-After (~1000 ms): ${elapsed} ms`);
    } finally {
      stub.restore();
      micoCrawl._resetThrottleForTest();
    }
  });

  test('429 SEM Retry-After → segue só com o minGap (não adia além)', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = seriesStub({
      movieCatalog: { 0: read('catalog-skip-0.json'), 5: read('catalog-empty.json') },
      seriesCatalog: { 0: { status: 429 } },
    });
    try {
      const t0 = Date.now();
      await site.discover(null, { series: { enabled: true, maxCards: 0, maxButtons: 0 } });
      const elapsed = Date.now() - t0;
      // Sem header não há `notBefore`: com minGap 0 a descoberta é imediata.
      assert.ok(elapsed < 500, `sem Retry-After não adia além do minGap: ${elapsed} ms`);
    } finally {
      stub.restore();
      micoCrawl._resetThrottleForTest();
    }
  });

  test('loop atinge o TETO sem página vazia → complete:false (descoberta truncada)', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    // Páginas de 1 obra pelos skips do passo fixo: NUNCA vem página vazia,
    // então o loop sai pelo teto config.mico.crawlMaxPages → descoberta TRUNCADA.
    const seriesCatalog: Record<number, any> = {};
    for (let i = 0, skip = 0; i < config.mico.crawlMaxPages; i += 1, skip += strideAt(skip)) seriesCatalog[skip] = { metas: [{ id: `tt${1_000_000 + i}` }] };
    const stub = seriesStub({
      movieCatalog: { 0: read('catalog-skip-0.json'), 5: read('catalog-empty.json') },
      seriesCatalog,
    });
    try {
      const found = await site.discover(null, { series: { enabled: true, maxCards: 0, maxButtons: 0 } });
      assert.equal(found.completeByKind?.tv_show, false, 'truncada pelo teto → série incompleta');
      assert.equal(found.complete, false, 'a truncagem de série torna a descoberta incompleta');
      assert.equal(found.urls.filter((u) => u.kind === 'tv_show').length, config.mico.crawlMaxPages, 'leu o teto de páginas');
    } finally {
      stub.restore();
    }
  });
});
