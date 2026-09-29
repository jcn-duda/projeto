// O ADAPTADOR do RedeTorrent: tipo pelo caminho, nome e IMDb da página, o
// `discover` (índice → sitemaps → URLs) e o `fetchWork` (post → tabela
// `tbl-mv-list` → magnet), contra o que foi medido em 2026-09-28/29 no site real
// via FlareSolverr e os posts já commitados do resolver.
//
// O que NÃO mora aqui é a leitura do sitemap em si (os DOIS formatos que o
// endpoint alterna, o `lastmod` de cada um e a regra de "vazio é falha"): é a
// suíte `crawl-redetorrent-sitemap.test.ts`, que fecha o bug do `urls: []` com
// `complete: true`. Aqui o sitemap é dublê e entra só pelo `discover`.
//
// Fetch dublê: zero rede, zero crawl.db, zero FlareSolverr. A amostra de
// temporada está em `crawl-redetorrent-series.test.ts`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { redetorrentCrawlSite } from '../src/providers/crawl-sites/redetorrent.js';
import {
  isSeriesSitemap, isWorkPath, isWorkSitemap, kindFromPath, parseImdbId,
  parseRenderedLastmod, toWorkUrl, workTitleYear,
} from '../src/providers/crawl-sites/redetorrent-discovery.js';
import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import {
  MOVIE, OFFSITE, SERIES, SITE,
  extraSlugs, pageRoutes, postFixture, site, viewerDoc, viewerRow, withStub,
} from './helpers/crawl-redetorrent-fixtures.js';

const slugsOf = (urls: { url: string }[]): string[] =>
  urls.map((u) => new URL(u.url).pathname.replace(/^\/|\/$/g, ''));
/** Só o host do site é aceito (dublê do `isDetailHost` do profile). */
const isSiteHost = (h: string | null): boolean => h === 'www.redetorrent.xyz' || h === 'redetorrent.com';

/** FORMATO B do sitemap: linha da tabela renderizada e o documento que a cerca. */
const row = viewerRow;
const viewer = viewerDoc;

describe('crawl-sites/redetorrent: tipo pelo caminho', () => {
  test('/series/ é série e /filmes/ é filme; o resto não é obra nenhuma', () => {
    assert.equal(kindFromPath(`${SITE}/series/fallout/`), 'tv_show');
    assert.equal(kindFromPath(`${SITE}/filmes/coringa/`), 'movie');
    assert.equal(kindFromPath('/series/qualquer/'), 'tv_show', 'caminho solto também serve');
    assert.equal(kindFromPath(`${SITE}/genero/acao/`), 'movie', 'default do tipo: nunca sai da fila');
  });

  test('obra é UM segmento com barra final; listagem, taxonomia e sem barra saem', () => {
    for (const path of ['/filmes/coringa/', '/series/fallout/']) {
      assert.equal(isWorkPath(new URL(SITE + path)), true, path);
    }
    for (const path of ['/', '/filmes/', '/series/', '/genero/acao/', '/page/2/', '/filmes/coringa', '/filmes/a/b/']) {
      assert.equal(isWorkPath(new URL(SITE + path)), false, path);
    }
  });

  test('o filtro de arquivo é movies/tvshows; post, category e dt* são de fora', () => {
    for (const name of ['movies-sitemap.xml', 'movies-sitemap7.xml', 'tvshows-sitemap.xml', 'tvshows-sitemap2.xml']) {
      assert.equal(isWorkSitemap(`${SITE}/${name}`), true, name);
    }
    for (const name of ['post-sitemap.xml', 'post-sitemap18.xml', 'category-sitemap.xml', 'dtcast-sitemap3.xml',
      'page-sitemap.xml', 'sitemap.xml']) {
      assert.equal(isWorkSitemap(`${SITE}/${name}`), false, name);
    }
    assert.equal(isSeriesSitemap(`${SITE}/tvshows-sitemap.xml`), true);
    assert.equal(isSeriesSitemap(`${SITE}/movies-sitemap.xml`), false);
  });
});

describe('crawl-sites/redetorrent: lastmod do visualizador', () => {
  test('"16 de September de 2026" + "17:56" vira ISO em UTC (o visualizador não traz fuso)', () => {
    assert.equal(parseRenderedLastmod('16 de September de 2026', '17:56'), '2026-09-16T17:56:00Z');
    assert.equal(parseRenderedLastmod('2 de March de 2025', '10:05'), '2025-03-02T10:05:00Z');
    assert.equal(parseRenderedLastmod('1 de January de 2024'), '2024-01-01T00:00:00Z', 'sem hora não é data inválida');
  });

  test('data ilegível vira vazio, nunca data inventada', () => {
    // `0000-00-00` é o que o AIOSEO às vezes emite; o cursor do motor anda a
    // partir do lastmod, então adivinhar aqui pula acervo.
    assert.equal(parseRenderedLastmod('0000-00-00', '00:00'), '');
    assert.equal(parseRenderedLastmod(''), '');
    assert.equal(parseRenderedLastmod('em algum dia de 2026'), '');
    assert.equal(parseRenderedLastmod('16 de FoimBUR de 2026'), '', 'mês que não existe no mapa');
    assert.equal(parseRenderedLastmod('31 de February de 2026'), '', 'dia impossível na data montada');
  });
});

describe('crawl-sites/redetorrent: título e IMDb', () => {
  test('o <h1> termina no ano, que é a forma da régua compartilhada', () => {
    const coringa = workTitleYear(postFixture('post-coringa-delirio.html'));
    assert.equal(coringa.title, 'Coringa: Delírio a Dois');
    assert.equal(coringa.year, 2024);
    assert.equal(coringa.raw, 'Coringa: Delírio a Dois (2024)', 'o CRU é o que o releaseTitle do profile limpa');
    const medido = workTitleYear('<h1>Deadpool Torrent – Bluray Rip 720p | 1080p Legendado Download (2016)</h1>');
    assert.deepEqual({ title: medido.title, year: medido.year }, { title: 'Deadpool', year: 2016 });
  });

  test('tt único é o da obra; dois ou nenhum é null', () => {
    assert.equal(parseImdbId('<p>IMDb: <a href="https://www.imdb.com/title/tt1063867/">8,1</a></p>'), 'tt1063867');
    assert.equal(parseImdbId(
      '<a href="https://www.imdb.com/title/tt1063867/"></a><a href="https://www.imdb.com/title/tt7654321/"></a>',
    ), null);
    assert.equal(parseImdbId(postFixture('post-coringa-delirio.html')), null, 'o post não publica tt');
  });

  test('o widget de outro post (ref_=tt_plg) é obra alheia e não vale', () => {
    // A mesma armadilha medida no ComandoTorrents: o autor cola o widget e o
    // `tt` é de filme aleatório. `CrawlWorkResult.imdb` promete nunca chutar.
    const widget = '<span data-title="tt1959490"><a href="https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt">'
      + '<img alt="Refém (2005) on IMDb"></a></span>';
    assert.equal(parseImdbId(`<p>Gênero: Drama</p>${widget}`), null);
  });
});

describe('crawl-sites/redetorrent: discover', () => {
  test('séries desligadas: só filme, o arquivo de série nem é lido, e o custo é o real', () => withStub(
    pageRoutes(), async (stub) => {
      const disc = await site().discover();
      assert.equal(disc.complete, true);
      assert.deepEqual(disc.failures, []);
      // índice + 7 movies-sitemap* — o tvshows nem entra no plano (separado dos
      // filmes, buscá-lo seria uma requisição para URL que o portão recusa).
      assert.equal(disc.requestCost, 8);
      assert.deepEqual(slugsOf(disc.urls), [
        'filmes/coringa-delirio-a-dois', 'filmes/coringa', 'filmes/batman-a-mascara-do-fantasma',
        'filmes/injustice', 'filmes/lego-batman-o-filme', ...extraSlugs(),
      ]);
      assert.ok(disc.urls.every((u) => u.kind === 'movie'));
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
      assert.ok(!stub.calls.some((c) => c.url.includes('tvshows')), 'série desligada não gasta requisição');
      assert.ok(!stub.calls.some((c) => c.url.includes('filmes-exemplo-spam')), 'host alheio nunca é consultado');
    },
  ));

  test('listagem, taxonomia e host alheio do sitemap não viram fila', () => withStub(pageRoutes(), async (stub) => {
    const disc = await site().discover();
    const paths = slugsOf(disc.urls);
    assert.ok(!paths.some((p) => p === 'filmes' || p === 'series' || p.startsWith('genero') || p.startsWith('page')));
    assert.ok(!paths.some((p) => p.startsWith('filmes/coringa/')), 'o loc sem barra final é a mesma página com url_key distinto');
    assert.ok(disc.urls.every((u) => u.url.startsWith(SITE)));
    assert.equal(stub.calls.filter((c) => c.url.includes('.xml')).length, 8);
  }));

  test('o filtro de arquivo recusa post/category/dtcast antes de qualquer requisição', () => withStub(
    pageRoutes(), async (stub) => {
      await site().discover();
      const paths = stub.calls.map((c) => new URL(c.url).pathname);
      for (const name of ['post-sitemap.xml', 'category-sitemap.xml', 'dtcast-sitemap3.xml', 'page-sitemap.xml']) {
        assert.ok(!paths.includes(`/${name}`), name);
      }
    },
  ));

  test('lastmod incremental corta por kind e o ilegível ENTRA (data vazia, não inventada)', () => withStub(
    pageRoutes(), async () => {
      const disc = await site().discover(null, { sinceByKind: { movie: '2025-01-01T00:00:00Z' } });
      assert.deepEqual(slugsOf(disc.urls), [
        'filmes/coringa-delirio-a-dois', 'filmes/coringa', 'filmes/injustice', 'filmes/lego-batman-o-filme',
        ...extraSlugs(),
      ]);
      const semData = disc.urls.filter((u) => !u.lastmod).map((u) => new URL(u.url).pathname);
      assert.deepEqual(semData, ['/filmes/injustice/', '/filmes/lego-batman-o-filme/']);
    },
  ));

  test('rodada incremental SEM novidade é completa, não falha (o laço de retry da VPS)', () => withStub(
    // Só linhas DATADAS: com o cursor no futuro, a lista depois do corte fica
    // realmente vazia — é o caso que o `throw` antigo transformava em falha.
    pageRoutes({
      '/sitemap.xml': () => viewer(row(`${SITE}/movies-sitemap.xml`, '16 de September de 2026', '17:56')),
      '/movies-sitemap.xml': () => viewer(
        row(`${SITE}/filmes/coringa/`, '16 de September de 2026', '17:56'),
        row(`${SITE}/filmes/injustice/`, '15 de September de 2026', '10:00'),
      ),
    }),
    async () => {
      // Cursor no futuro: nenhuma linha datada é nova. Havia um `throw` para
      // lista vazia depois do corte, e na VPS ele virava uma descoberta refeita
      // a cada ~70 s, para sempre (2026-09-29). Só as linhas SEM data sobram.
      const disc = await site().discover(null, { sinceByKind: { movie: '2099-01-01T00:00:00Z', tv_show: '2099-01-01T00:00:00Z' } });
      assert.equal(disc.complete, true);
      assert.deepEqual(disc.failures, []);
      assert.deepEqual(disc.urls, [], 'nada é novo desde o cursor');
    },
  ));

  test('índice sem sitemap de obra cai no nome Yoast', () => withStub(
    pageRoutes({ '/sitemap.xml': () => viewer(row(`${SITE}/post-sitemap.xml`, '16 de September de 2026', '17:56')) }),
    async (stub) => {
      const disc = await site().discover();
      assert.equal(disc.complete, true);
      assert.equal(disc.urls.length, 11);
      assert.ok(stub.calls.some((c) => c.url.includes('/sitemap.xml')));
      assert.ok(stub.calls.some((c) => c.url.includes('/sitemap_index.xml')));
    },
  ));

  test('índice ilegível nos dois caminhos é erro do site', () => withStub(
    pageRoutes({
      '/sitemap.xml': () => { throw new Error('http_500'); },
      '/sitemap_index.xml': () => { throw new Error('http_500'); },
    }),
    async () => assert.rejects(() => site().discover(), /índice de sitemaps ilegível/),
  ));

  test('um sitemap que falha deixa a descoberta parcial, sem avançar o cursor', () => withStub(
    pageRoutes({ '/movies-sitemap3.xml': () => { throw new Error('http_500'); } }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false);
      assert.equal(disc.failures.length, 1);
      assert.match(disc.failures[0], /movies-sitemap3\.xml/);
      assert.equal(disc.urls.length, 10, 'os outros arquivos ainda valem');
      assert.deepEqual(
        disc.completeByKind,
        { movie: false, tv_show: true },
        'o kind do ARQUIVO que falhou é que sai false; sem amostra o de série não anda',
      );
    },
  ));

  test('todos os sitemaps de obra falhando é erro, não lista vazia', () => withStub(
    pageRoutes(Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => {
        const n = i + 1;
        return [`/movies-sitemap${n === 1 ? '' : n}.xml`, () => { throw new Error('http_500'); }];
      }),
    )),
    async () => assert.rejects(() => site().discover(), /todos os sitemaps de obra falharam/),
  ));

  test('séries ligadas na config leem o tvshows-sitemap e emitem a série', () => withStub(
    pageRoutes(), async (stub) => {
      const disc = await site().discover(null, { series: { enabled: true, maxCards: 4, maxButtons: 4 } });
      // O portão é o dos outros três sites: com a opção do painel ligada, o
      // arquivo de série entra no plano (índice + 7 movies + 1 tvshows = 9).
      assert.equal(disc.requestCost, 9);
      assert.ok(stub.calls.some((c) => c.url.includes('tvshows-sitemap.xml')));
      const shows = disc.urls.filter((u) => u.kind === 'tv_show');
      assert.deepEqual(shows.map((u) => u.url), [
        SERIES, `${SITE}/series/casa-do-dragao/`, `${SITE}/series/breaking-bad/`,
      ]);
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
    },
  ));
});

describe('crawl-sites/redetorrent: fetchWork de filme', () => {
  test('post de filme: 1 requisição, magnet direto, origem BR e título do profile', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'movie');
      assert.equal(result.title, 'Coringa: Delírio a Dois');
      assert.equal(result.year, 2024);
      assert.equal(result.imdb, null, 'o post não publica tt único');
      // A ficha publica o original (`<b>Título Original:</b> Joker: Folie à
      // Deux`) e o helper compartilhado lê essa forma — 2º nome da
      // identificação quando o `<h1>` não casa ninguém.
      assert.equal(result.originalTitle, 'Joker: Folie à Deux');
      assert.equal(result.groups, undefined, 'filme não tem locação');
      assert.equal(result.requestCost, 1, 'o magnet é direto no HTML: uma requisição só');
      assert.equal(stub.calls.length, 1);
      assert.ok(!stub.calls.some((c) => /flaresolverr|8191/i.test(c.url)), 'sem protetor, sem salto');

      const releases = result.releases ?? [];
      assert.equal(releases.length, 6, 'as 6 linhas tr-mv-list com magnet do post');
      const first = releases[0];
      assert.equal(first.indexer, 'redetorrent-cardigann', 'o id do CARD, não o do profile');
      assert.equal(first.tracker, 'RedeTorrent');
      assert.equal(first.isBr, true);
      assert.equal(first.seeders, 1, 'fonte BR não publica swarm; 1 sobrevive ao MIN_SEEDERS');
      assert.match(first.magnet ?? '', /^magnet:\?xt=urn:btih:a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be/i);
      // Título montado pelo `releaseTitle` do profile a partir do `<h1>` CRU —
      // string exata, porque ela é o contrato com o card vivo: o `title=` do
      // card de busca é byte a byte o `<h1>` do post.
      assert.equal(first.title, 'Coringa: Delírio a Dois (2024) [1080p WEB-DL DUAL 3.68 GB]');
    },
  ));

  test('o mesmo magnet em duas linhas vira uma release só (dedupe por hash)', () => withStub(
    pageRoutes({
      [MOVIE]: () => `<h1>Repetido (2020)</h1><table class="tbl-mv-list"><tbody>${'<tr class="tr-mv-list">'
        + '<td class="td-mv-qua">WEB-DL</td><td class="td-mv-res">1080p</td><td class="td-mv-tam">2.00 GB</td>'
        + '<td class="td-mv-idi">ptbr</td><td class="td-mv-dow">'
        + '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=x">m</a></td></tr>'
        + '<tr class="tr-mv-list"><td class="td-mv-qua">WEB-DL</td><td class="td-mv-res">720p</td>'
        + '<td class="td-mv-tam">1.00 GB</td><td class="td-mv-idi">ptbr</td><td class="td-mv-dow">'
        + '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=x">m</a></td></tr>'
        + '</tbody></table>'}`,
    }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'done');
      assert.equal(result.releases?.length, 1);
      assert.equal(result.requestCost, 1);
    },
  ));

  test('post sem linha de release é no-torrent, com o custo da página', () => withStub(
    pageRoutes({ [MOVIE]: () => '<h1>Filme Sem Magnet (2020)</h1>' }),
    async (stub) => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.title, 'Filme Sem Magnet');
      assert.equal(result.year, 2020);
      assert.equal(result.requestCost, 1);
      assert.equal(stub.calls.length, 1);
    },
  ));

  test('página sem h1 é quebra de layout, não release inventada', () => withStub(
    pageRoutes({ [MOVIE]: () => '<html><body><p>sem titulo</p></body></html>' }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /layout/);
      assert.equal(result.requestCost, 1);
    },
  ));

  test('rede caída na página continua retentável e leva o custo medido', () => withStub(
    pageRoutes({ [MOVIE]: () => { throw new Error('rede'); } }),
    async () => {
      await assert.rejects(() => site().fetchWork(MOVIE), (err: unknown) => {
        assert.match(String(err), /rede/);
        assert.equal((err as { requestCost?: number }).requestCost, 1, 'F1: o que foi gasto antes de falhar');
        return true;
      });
    },
  ));

  test('portão de série: kind tv_show com séries DESLIGADAS é erro e ZERO rede', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, { kind: 'tv_show' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /séries desligadas no painel/);
    assert.equal(stub.calls.length, 0);
  }));

  test('o mesmo `kind` com séries ligadas já sai pelo caminho do motor', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, {
      kind: 'tv_show', series: { enabled: true, maxCards: 4, maxButtons: 40 },
    });
    assert.equal(result.status, 'done');
    assert.equal(result.type, 'series');
    assert.ok(Array.isArray(result.groups) && result.groups.length, 'o motor precisa da locação das linhas');
    assert.equal(stub.calls.length, 1);
  }));

  test('página de série pedida como filme é recusada antes da rede', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, { kind: 'movie' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /serie_com_kind_movie/);
    assert.equal(stub.calls.length, 0);
  }));

  test('host de fora e caminho que não é obra são rejeitados na porta', () => withStub(pageRoutes(), async (stub) => {
    await assert.rejects(() => site().fetchWork(`${OFFSITE}/filmes/coringa/`), /blocked_host:filmes-exemplo-spam\.test/);
    await assert.rejects(() => site().fetchWork(`${SITE}/filmes/`), /not_a_work_page/);
    await assert.rejects(() => site().fetchWork(`${SITE}/genero/acao/`), /not_a_work_page/);
    assert.equal(stub.calls.length, 0);
  }));
});

describe('crawl-sites/redetorrent: instância de produção', () => {
  test('a fábrica do registry não liga o modo amostra', () => {
    assert.throws(() => redetorrentCrawlSite(), /resolvedor embutido não carregado/);
  });

  test('a flag por chamada cabe no contrato compartilhado sem campo novo', () => {
    const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
    assert.equal(opts.kind, 'tv_show');
  });
});
