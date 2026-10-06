// Adaptador de raspagem do ComandoTorrents contra o sitemap Yoast medido
// (post-sitemap, homepage fora, temporada no slug) e os posts já commitados
// do resolver. Fetch dublê: zero rede, zero crawl.db. A amostra de temporada
// mora em `crawl-comandotorrents-series.test.ts`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { comandotorrentsCrawlSite } from '../src/providers/crawl-sites/comandotorrents.js';
import { kindFromSlug, parseImdbId, workTitleYear } from '../src/providers/crawl-sites/comandotorrents-discovery.js';
import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import {
  MOVIE,
  SERIES,
  SITE,
  STUB_BTIH,
  hostsOf,
  pageRoutes,
  pathsOf,
  postFixture,
  probeSite,
  site,
  withStub,
} from './helpers/crawl-comandotorrents-fixtures.js';

const slugsOf = (urls: { url: string }[]): string[] =>
  urls.map((u) => new URL(u.url).pathname.replace(/^\/|\/$/g, ''));

describe('crawl-sites/comandotorrents: kind por slug', () => {
  test('temporada no slug é tv_show; o resto, inclusive mini-série sem a palavra, é filme', () => {
    assert.equal(kindFromSlug(`${SITE}/ate-que-amanheca-2026-dual-audio-web-dl-1080p/`), 'movie');
    assert.equal(kindFromSlug(`${SITE}/among-us-1a-temporada-torrent-2026/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/o-cacador-1a-temporada-completa-mini-serie-2014/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/uma-mini-serie-2014/`), 'movie');
    assert.equal(kindFromSlug(`${SITE}/`), 'movie', 'a homepage nem é obra; o kind default não a emite');
  });
});

describe('crawl-sites/comandotorrents: título do h1', () => {
  test('o ano no meio sai, e a vitrine não vai para o TMDB', () => {
    const measured = workTitleYear('<h1>Até Que Amanheça (2026) Dual Áudio WEB-DL 1080p</h1>');
    assert.deepEqual(measured, { title: 'Até Que Amanheça', year: 2026 });
    const furiosa = workTitleYear(postFixture('comandotorrents-post.html'));
    assert.equal(furiosa.year, 2024);
    assert.equal(furiosa.title, 'Furiosa: Uma Saga Mad Max');
    const loose = workTitleYear('<h1>Blade Runner 2049 Torrent</h1>');
    assert.equal(loose.year, null, 'ano solto não é declaração do site');
    assert.equal(loose.title, 'Blade Runner 2049');
  });

  test('um tt só é o da obra; dois ou nenhum é null', () => {
    assert.equal(parseImdbId('<p>IMDb : <a href="https://www.imdb.com/title/tt1234567/">x</a></p>'), 'tt1234567');
    assert.equal(parseImdbId(
      '<a href="https://www.imdb.com/title/tt1234567/"></a><a href="https://www.imdb.com/title/tt7654321/"></a>',
    ), null);
    assert.equal(parseImdbId(postFixture('comandotorrents-post.html')), null);
  });

  test('link do plugin de nota do IMDb (obra alheia) não é a obra da página', () => {
    // Recorte real de "Curvas da Vida (2012)": o widget colado é "Refém (2005)",
    // o link aponta `tt1959490` ("Noé") e não há outro tt na página.
    const plugin = '<span data-style="t1" data-title="tt0340163" data-user="ur48790360">'
      + '<a href="https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt">'
      + '<img alt="Refém (2005) on IMDb" src="https://comandotorrents.to/core/views/ComandoFilmes/images/IMDB.jpg"></a></span>';
    assert.equal(parseImdbId(`<p>Gênero: Drama</p>${plugin}`), null, 'só o plugin: identificação por título');
    const ficha = '<strong>IMDb</strong>: <a href="https://www.imdb.com/title/tt2083383/">7,0</a>';
    assert.equal(parseImdbId(`${ficha}${plugin}`), 'tt2083383', 'a ficha vence; o plugin não empata');
  });
});

describe('crawl-sites/comandotorrents: discover', () => {
  test('séries desligadas: só filme, sem homepage, sem host alheio', () => withStub(pageRoutes(), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.complete, true);
    assert.deepEqual(disc.failures, []);
    assert.equal(disc.requestCost, 3, 'índice + dois post-sitemaps');
    assert.deepEqual(slugsOf(disc.urls), [
      'furiosa-uma-saga-mad-max',
      'filme-antigo',
      'ate-que-amanheca-2026',
    ]);
    assert.ok(disc.urls.every((u) => u.kind === 'movie'));
    assert.deepEqual(hostsOf(stub).filter((h) => h !== 'comandotorrents.to'), []);
    assert.ok(!pathsOf(stub).some((p) => /page-sitemap|category-sitemap|attachment-sitemap/.test(p)));
  }));

  test('modo amostra emite a temporada com o tipo do slug', () => withStub(pageRoutes(), async () => {
    const disc = await probeSite().discover();
    const season = disc.urls.find((u) => u.url.includes('temporada'));
    assert.equal(season?.kind, 'tv_show');
    assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 3);
  }));

  test('séries ligadas emitem a temporada; desligadas, só filme', () => withStub(pageRoutes(), async () => {
    const on = await site().discover(null, { series: { enabled: true, maxCards: 4, maxButtons: 4 } });
    assert.equal(on.urls.filter((u) => u.kind === 'tv_show').length, 1, 'a temporada do sitemap entra na fila');
    const off = await site().discover(null, { series: { enabled: false, maxCards: 4, maxButtons: 4 } });
    assert.ok(off.urls.every((u) => u.kind === 'movie'));
  }));

  test('lastmod incremental corta por kind', () => withStub(pageRoutes(), async () => {
    const disc = await site().discover(null, { sinceByKind: { movie: '2026-09-28T12:00:00+00:00' } });
    assert.deepEqual(slugsOf(disc.urls), ['ate-que-amanheca-2026']);
  }));

  test('sitemap.xml vazio cai no índice Yoast', () => withStub(pageRoutes({
    '/sitemap.xml': () => '<sitemapindex></sitemapindex>',
  }), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.complete, true);
    assert.ok(pathsOf(stub).includes('/sitemap.xml'));
    assert.ok(pathsOf(stub).includes('/sitemap_index.xml'));
  }));

  test('redirect do /sitemap.xml é seguido dentro da allowlist', () => withStub(pageRoutes({
    '/sitemap.xml': () => ({ status: 302, body: '', location: `${SITE}/sitemap_index.xml` }),
  }), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.complete, true);
    assert.ok(slugsOf(disc.urls).includes('furiosa-uma-saga-mad-max'));
    assert.deepEqual(pathsOf(stub).slice(0, 2), ['/sitemap.xml', '/sitemap_index.xml']);
  }));

  test('índice ilegível nos dois caminhos é erro do site', () => withStub(pageRoutes({
    '/sitemap.xml': () => { throw new Error('http_500'); },
    '/sitemap_index.xml': () => { throw new Error('http_500'); },
  }), async (stub) => {
    await assert.rejects(() => site().discover(), (err: Error & { requestCost?: number }) => {
      assert.match(err.message, /índice de sitemaps ilegível/);
      assert.equal(err.requestCost, pathsOf(stub).length);
      return true;
    });
  }));

  test('um post-sitemap que falha deixa a descoberta parcial', () => withStub(pageRoutes({
    '/post-sitemap2.xml': () => { throw new Error('http_500'); },
  }), async () => {
    const disc = await site().discover();
    assert.equal(disc.complete, false);
    assert.equal(disc.failures.length, 1);
    assert.ok(slugsOf(disc.urls).includes('furiosa-uma-saga-mad-max'));
    assert.equal(disc.completeByKind?.tv_show, false, 'arquivo misto ilegível não prova completude do cursor tv_show');
  }));
});

describe('crawl-sites/comandotorrents: fetchWork de filme', () => {
  test('post de filme: um magnet, título limpo, custo da página mais os botões', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(MOVIE);
    assert.equal(result.status, 'done');
    assert.equal(result.type, 'movie');
    assert.equal(result.title, 'Furiosa: Uma Saga Mad Max');
    assert.equal(result.year, 2024);
    assert.equal(result.imdb, null);
    assert.equal(result.releases?.length, 1);
    assert.equal(result.releases?.[0].indexer, 'comandotorrents');
    assert.equal(result.releases?.[0].isBr, true);
    assert.equal(result.releases?.[0].seeders, 1);
    assert.match(result.releases?.[0].magnet ?? '', new RegExp(STUB_BTIH, 'i'));
    assert.equal(result.requestCost, 4, 'página + 3 botões');
    assert.ok(!stub.calls.some((c) => /flaresolverr|8191/i.test(c.url)));
  }));

  test('post sem botão é no-torrent', () => withStub(pageRoutes({
    [MOVIE]: () => '<h1>Filme Sem Botao (2020)</h1>',
  }), async (stub) => {
    const result = await site().fetchWork(MOVIE);
    assert.equal(result.status, 'no-torrent');
    assert.equal(result.title, 'Filme Sem Botao');
    assert.equal(result.year, 2020);
    assert.equal(result.requestCost, 1);
    assert.equal(stub.calls.length, 1);
  }));

  test('botão terminal em todos os saltos é no-torrent, sem retry eterno', () => withStub(
    pageRoutes({
      '/redirect': () => ({ status: 400, body: 'Link inválido ou expirado' }),
    }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.requestCost, 4);
    },
    () => ({ status: 400, body: 'Link inválido ou expirado' }),
  ));

  test('rede caída no botão continua retentável e leva o custo', () => withStub(
    pageRoutes({
      '/redirect': () => { throw new Error('rede'); },
    }),
    async () => {
      await assert.rejects(
        () => site().fetchWork(MOVIE),
        (err: unknown) => {
          assert.match(String(err), /rede/);
          assert.equal((err as { requestCost?: number }).requestCost, 4, 'página + os três botões que falharam');
          return true;
        },
      );
    },
    () => { throw new Error('rede'); },
  ));

  test('página de temporada pedida como filme é recusada antes da rede', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, { kind: 'movie' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /temporada_com_kind_movie/);
    assert.equal(stub.calls.length, 0);
  }));

  test('kind tv_show com séries desligadas é erro e zero rede', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, { kind: 'tv_show' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /séries desligadas/);
    assert.equal(stub.calls.length, 0);
  }));

  test('página sem h1 é quebra de layout', () => withStub(pageRoutes({
    [MOVIE]: () => '<html><body><p>sem titulo</p></body></html>',
  }), async () => {
    const result = await site().fetchWork(MOVIE);
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /layout/);
  }));

  test('host de fora e caminho que não é obra são rejeitados', () => withStub(pageRoutes(), async (stub) => {
    await assert.rejects(() => site().fetchWork('https://evil.example/filme/'), /blocked_host:evil\.example/);
    await assert.rejects(() => site().fetchWork(`${SITE}/feed/`), /not_a_work_page/);
    assert.equal(stub.calls.length, 0);
  }));
});

describe('crawl-sites/comandotorrents: instância de produção', () => {
  test('a fábrica do registry não liga o modo amostra', () => {
    assert.throws(() => comandotorrentsCrawlSite(), /resolvedor embutido não carregado/);
  });

  test('a flag por chamada cabe no contrato sem campo novo', () => {
    const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
    assert.equal(opts.kind, 'tv_show');
  });
});
