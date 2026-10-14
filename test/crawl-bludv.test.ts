// O ADAPTADOR do BLUDV: tipo pelo slug, nome/IMDb/ficha da página, o `discover`
// (índice Yoast → 18 `post-sitemap*` → URLs) e o `fetchWork` (post → bloco de
// downloads → magnet), contra o que foi medido em 2026-09-29 no site real.
//
// O que NÃO mora aqui é a política de "vazio é FALHA" do sitemap (formato não
// reconhecido, arquivo sem entrada, arquivo sem URL de obra): é a suíte
// `crawl-bludv-sitemap.test.ts`. Aqui o sitemap entra pelo `discover` e o
// recorte real é o que prova a régua do slug.
//
// Fetch dublê: zero rede, zero crawl.db, zero FlareSolverr. A série (locação por
// `seasonPageGroups`) está em `crawl-bludv-series.test.ts`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bludvCrawlSite } from '../src/providers/crawl-sites/bludv.js';
import {
  isSitemapXml, isWorkPath, kindFromSlug, parseImdbId, parseOriginalTitle, parseSitemapIndexLocs, workTitleYear,
} from '../src/providers/crawl-sites/bludv-discovery.js';
import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import {
  MOVIE, OFFSITE, SERIES, SITE,
  extraSlugs, fixture, pageRoutes, site, withStub,
} from './helpers/crawl-bludv-fixtures.js';

const slugsOf = (urls: { url: string }[]): string[] =>
  urls.map((u) => new URL(u.url).pathname.replace(/^\/|\/$/g, ''));
/** Só o host do site é aceito (dublê do `isDetailHost` do profile). */
const isSiteHost = (h: string | null): boolean => h === 'bludvfilmes1.xyz' || h === 'bludvfilmes.xyz';

describe('crawl-sites/bludv: tipo pelo slug', () => {
  test('"temporada" no slug é série; o resto é filme', () => {
    // Medido no acervo inteiro: 3.236 das 17.860 linhas (18,1%).
    assert.equal(kindFromSlug(`${SITE}/smallville-10a-temporada-torrent-blu-ray-rip-720p-dublado-2010/`), 'tv_show');
    assert.equal(kindFromSlug(SERIES), 'tv_show');
    assert.equal(kindFromSlug('/friends-4a-temporada-torrent-1997/'), 'tv_show', 'caminho solto também serve');
    assert.equal(kindFromSlug(MOVIE), 'movie');
    assert.equal(kindFromSlug(`${SITE}/qualquer-outra-pagina/`), 'movie', 'default do tipo: nunca sai da fila');
  });

  test('obra é UM segmento com barra final; home, taxonomia e sem barra saem', () => {
    for (const p of [MOVIE, SERIES, `${SITE}/lar-doce-inferno-torrent-2015/`]) {
      assert.equal(isWorkPath(new URL(p)), true, p);
    }
    // A home é a PRIMEIRA linha do `post-sitemap.xml` real: sem esta guarda ela
    // entraria na fila como obra.
    for (const p of ['/', '/filmes/', '/series/', '/generos/acao/', '/genero/acao/', '/resolucao/1080p/',
      '/lancamento/2026/', '/page/2/', '/tag/torrent/', '/author/alguem/', '/qualquer-post',
      '/algum/dobrado/']) {
      assert.equal(isWorkPath(new URL(SITE + p)), false, p);
    }
  });

  test('o filtro de arquivo é post-sitemap; category, post_tag, page e author são de fora', () => {
    // 54 entradas no índice real: 18 `post-sitemap*` e 36 de taxonomia/página.
    const locs = parseSitemapIndexLocs(fixture('sitemap-index.xml'), SITE, isSiteHost);
    assert.equal(locs.length, 18);
    assert.ok(locs.every((l) => /\/post-sitemap\d*\.xml$/.test(new URL(l).pathname)));
    const caminhos = [...fixture('sitemap-index.xml').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
      .map((m) => new URL(m[1].trim()).pathname);
    for (const nome of ['/category-sitemap.xml', '/post_tag-sitemap.xml', '/post_tag-sitemap33.xml',
      '/page-sitemap.xml', '/author-sitemap.xml']) {
      assert.ok(caminhos.includes(nome), `o índice real declara ${nome}`);
    }
  });
});

describe('crawl-sites/bludv: título, ficha e IMDb', () => {
  test('o <h1> termina no ano, que é a forma da régua compartilhada', () => {
    // Medido no post real: "O Final da Turnê Torrent – Blu-ray Rip 720p e 1080p
    // Dublado (2016)" e "O Exterminador do Futuro: Crônicas de Sarah Connor 2ª
    // Temporada Torrent – Blu-ray Rip 720p Dublado (2009)". A régua do
    // TorrentDosFilmes (ano no meio) não seria copiada aqui.
    const filme = workTitleYear(fixture('post-movie.html'));
    assert.equal(filme.title, 'O Final da Turnê');
    assert.equal(filme.year, 2016);
    assert.equal(filme.raw, 'O Final da Turnê Torrent – Blu-ray Rip 720p e 1080p Dublado (2016)');
    const serie = workTitleYear(fixture('post-series.html'));
    assert.equal(serie.title, 'O Exterminador do Futuro: Crônicas de Sarah Connor');
    assert.equal(serie.year, 2009);
    // A lista de vitrine sai inteira: nome, e não "O Exterminador do Futuro:
    // Crônicas de Sarah Connor 2ª Temporada".
    assert.ok(!serie.title.includes('Temporada'));
  });

  test('o tt vem da ficha, e o que está fora dela não vale', () => {
    // Medido em 14 páginas: 12 com tt único e ancorado no rótulo "IMDb"
    // (36–41 caracteres), 2 sem tt, ZERO com dois. Nenhum "solto" na página.
    assert.equal(parseImdbId(fixture('post-movie.html')), 'tt3416744', 'The End of the Tour = O Final da Turnê');
    assert.equal(parseImdbId(fixture('post-series.html')), 'tt0851851', 'Terminator: The Sarah Connor Chronicles');
    // O `?ref_=tt_plg_rt` é o plugin de nota da PRÓPRIA ficha, não o widget alheio
    // do ComandoTorrents: por isso o filtro `ref_=tt_` dos outros sites aqui
    // descartaria o tt CORRETO.
    const comRef = '<b>Classificação:</b> 12 Anos<br> <strong>IMDb</strong>: '
      + '<a href="https://www.imdb.com/title/tt0279600/?ref_=tt_plg_rt">7.5</a>';
    assert.equal(parseImdbId(comRef), 'tt0279600', 'Smallville: o `ref_` é do plugin, não widget alheio');
    // Fora da ficha (o widget colado de outro post) não vale: é a armadilha que a
    // âncora fecha, e obra errada é pior que obra nenhuma.
    const widget = '<h1>Busca Implacável 3 (2015)</h1>'
      + '<span data-title="tt1959490"><a href="https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt">Noé</a></span>';
    assert.equal(parseImdbId(widget), null);
    // Dois tt dentro da ficha é ambíguo; nenhum é ausência.
    const dois = '<strong>IMDb</strong>: <a href="https://www.imdb.com/title/tt0120667/">x</a> '
      + '<a href="https://www.imdb.com/title/tt9999999/">y</a>';
    assert.equal(parseImdbId(dois), null);
    assert.equal(parseImdbId('<h1>Sem IMDb (2020)</h1>'), null);
  });

  test('o título original sai nas DUAS formas que o site publica', () => {
    // Forma `<b>` (7 de 12 posts medidos) e forma `<strong><em>` (5 de 12). O
    // helper COMPARTILHADO devolve ":" na segunda — sem a normalização da tag.
    assert.equal(parseOriginalTitle(fixture('post-movie.html')), 'The End of the Tour');
    assert.equal(
      parseOriginalTitle(fixture('post-series.html')),
      'Terminator: The Sarah Connor Chronicles',
    );
    // Regras do helper compartilhado preservadas pela delegação (nada copiado).
    assert.equal(parseOriginalTitle('<b>Título Original:</b> Paradox / Sha po lang<br>'), null, 'dois nomes');
    assert.equal(
      parseOriginalTitle('<b>Título Original:</b> A Gangster&#8217;s Life<br>'),
      'A Gangster’s Life',
      'entidade decodificada',
    );
    assert.equal(parseOriginalTitle('<b>Lançamento:</b> 2015 sem original'), null, 'ausente é null');
  });
});

describe('crawl-sites/bludv: discover', () => {
  test('lê o índice e os 18 post-sitemap, e o custo é o real', () => withStub(
    pageRoutes(), async (stub) => {
      const disc = await site().discover();
      assert.equal(disc.complete, true);
      assert.deepEqual(disc.failures, []);
      // índice + 18 `post-sitemap*`. O `post-sitemap*` é MISTO, então não há
      // arquivo de série a pular: com séries desligadas ele é lido do mesmo jeito.
      assert.equal(disc.requestCost, 19);
      // Sem séries, as 130 linhas de temporada do acervo (126 no arquivo real + 4
      // no recorte) saem: 1.021 lidas − 130 = 891 entregues. E a PRIMEIRA linha do
      // `post-sitemap.xml` real é a home `/` (excluída), então a lista começa no
      // primeiro POST.
      assert.equal(disc.urls.length, 891);
      assert.ok(disc.urls.every((u) => u.kind === 'movie'), 'sem séries, só filme sai');
      assert.deepEqual(slugsOf(disc.urls).slice(0, 4), [
        'lar-doce-inferno-torrent-blu-ray-rip-1080p-dual-audio-2015',
        'quarteto-fantastico-torrent-blu-ray-rip-1080p-dublado-2005',
        'quarteto-fantastico-torrent-blu-ray-rip-720p-dublado-2005',
        'lego-liga-da-justica-o-ataque-da-legiao-do-mal-torrent-blu-ray-rip-1080p-dublado-2015',
      ]);
      assert.ok(!slugsOf(disc.urls).some((s) => /temporada/.test(s)), 'temporada é o que o portão tirou');
      assert.deepEqual(slugsOf(disc.urls).slice(-16), extraSlugs(), 'os 16 sintéticos, no fim');
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
      assert.ok(!stub.calls.some((c) => c.url.includes('filmes-exemplo-spam')), 'host alheio nunca é consultado');
      // Nenhum arquivo de taxonomia é lido: 36 das 54 entradas do índice saem pelo
      // NOME, antes de qualquer requisição.
      for (const nome of ['category-sitemap', 'post_tag-sitemap', 'page-sitemap', 'author-sitemap']) {
        assert.ok(!stub.calls.some((c) => c.url.includes(nome)), nome);
      }
    },
  ));

  test('a home `/` e o `image:loc` (capa) não viram fila', () => withStub(pageRoutes(), async (stub) => {
    const disc = await site().discover();
    const paths = slugsOf(disc.urls);
    assert.ok(!paths.includes(''), 'a home é a primeira linha do sitemap e não é obra');
    assert.ok(!disc.urls.some((u) => u.url.includes('/wp-content/uploads/')), 'capa não é página');
    // A linha real que traz `image:image` (a de "Espírito de Lobo") continua
    // sendo a obra, com o `<loc>` da PÁGINA.
    assert.ok(paths.includes('espirito-de-lobo-torrent-blu-ray-rip-720p-e-1080p-dublado-2015'));
    assert.ok(disc.urls.every((u) => u.url.startsWith(SITE)));
    assert.equal(stub.calls.filter((c) => c.url.includes('.xml')).length, 19);
  }));

  test('séries ligadas emitem `tv_show` pelo slug, no MESMO arquivo', () => withStub(
    pageRoutes(), async () => {
      const disc = await site().discover(null, { series: { enabled: true, maxCards: 4, maxButtons: 4 } });
      const shows = disc.urls.filter((u) => u.kind === 'tv_show');
      // 126 no arquivo real (medido: 3.236 nos 18 arquivos) + 4 no recorte.
      assert.equal(shows.length, 130);
      assert.ok(shows.every((u) => /temporada/i.test(u.url)));
      assert.ok(shows.some((u) => u.url === SERIES));
      assert.equal(disc.urls.length - shows.length, 891);
      // O portão é o dos outros sites, e o custo é o MESMO: o arquivo é misto.
      assert.equal(disc.requestCost, 19);
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
    },
  ));

  test('lastmod incremental corta por kind e o ilegível ENTRA (data vazia, não inventada)', () => withStub(
    pageRoutes(), async () => {
      const disc = await site().discover('2015-08-09T03:00:45+00:00', {
        sinceByKind: { movie: '2015-01-01T00:00:00Z' },
      });
      // `movie` usa o cursor do mapa; `tv_show` cai no `since` solto (o mapa tem a
      // chave, e é ela que manda) — nenhuma linha de filme sobra, e as de
      // temporada saem todas por terem `lastmod` de 2015-08-09 ou menos.
      const shows = disc.urls.filter((u) => u.kind === 'tv_show');
      assert.equal(shows.length, 0, 'temporadas de 2015-08-09 foram cortadas pelo cursor solto');
      assert.ok(disc.urls.length > 0, 'os sintéticos de 2026 sobrevivem');
      assert.ok(disc.urls.every((u) => u.lastmod === '' || Date.parse(u.lastmod) > Date.parse('2015-01-01T00:00:00Z')));
    },
  ));

  test('índice ilegível nos três caminhos é erro do site', () => withStub(
    pageRoutes({
      '/sitemap_index.xml': () => { throw new Error('http_500'); },
      '/sitemap.xml': () => { throw new Error('http_500'); },
      '/wp-sitemap.xml': () => { throw new Error('http_500'); },
    }),
    async () => assert.rejects(() => site().discover(), /índice de sitemaps ilegível/),
  ));

  test('índice sem post-sitemap é erro, não rodada vazia', () => withStub(
    pageRoutes({
      '/sitemap_index.xml': () => '<?xml version="1.0"?><sitemapindex>'
        + '<sitemap><loc>' + `${SITE}/category-sitemap.xml` + '</loc></sitemap></sitemapindex>',
      '/sitemap.xml': () => '<?xml version="1.0"?><sitemapindex>'
        + '<sitemap><loc>' + `${SITE}/category-sitemap.xml` + '</loc></sitemap></sitemapindex>',
      '/wp-sitemap.xml': () => '<?xml version="1.0"?><sitemapindex>'
        + '<sitemap><loc>' + `${SITE}/category-sitemap.xml` + '</loc></sitemap></sitemapindex>',
    }),
    async () => assert.rejects(() => site().discover(), /índice de sitemaps ilegível/),
  ));

  test('um sitemap que falha deixa a descoberta parcial, sem avançar o cursor', () => withStub(
    pageRoutes({ '/post-sitemap3.xml': () => { throw new Error('http_500'); } }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false);
      assert.equal(disc.failures.length, 1);
      assert.match(disc.failures[0], /post-sitemap3\.xml/);
      assert.ok(disc.urls.length > 0, 'os outros arquivos ainda valem');
      // O `post-sitemap*` é MISTO: um arquivo que falhou tira a fonte dos DOIS
      // kinds, porque não dá para dizer qual deles ele alimentava.
      assert.deepEqual(disc.completeByKind, { movie: false, tv_show: true },
        'séries desligadas: o cursor de série não anda por decisão, não por falha');
      const ligado = await site().discover(null, { series: { enabled: true, maxCards: 4, maxButtons: 4 } });
      assert.deepEqual(ligado.completeByKind, { movie: false, tv_show: false },
        'com séries ligadas, o kind que o arquivo perdia é que sai false');
    },
  ));
});

describe('crawl-sites/bludv: fetchWork de filme', () => {
  test('post de filme: 1 requisição, magnet direto, origem BR e título do profile', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'movie');
      assert.equal(result.title, 'O Final da Turnê');
      assert.equal(result.year, 2016);
      assert.equal(result.imdb, 'tt3416744');
      assert.equal(result.originalTitle, 'The End of the Tour');
      assert.equal(result.groups, undefined, 'filme não tem locação');
      // O magnet é DIRETO no HTML: uma requisição só, e o dublê estoura em
      // qualquer URL fora do mapa — um salto seria erro de rota, não número.
      assert.equal(result.requestCost, 1);
      assert.equal(stub.calls.length, 1);

      const releases = result.releases ?? [];
      assert.equal(releases.length, 2, 'as 2 âncoras de magnet do post real');
      const first = releases[0];
      assert.equal(first.indexer, 'bludv-cardigann', 'o id do CARD, não o do profile');
      assert.equal(first.tracker, 'BLUDV');
      assert.equal(first.isBr, true);
      assert.equal(first.seeders, 1, 'fonte BR não publica swarm; 1 sobrevive ao MIN_SEEDERS');
      assert.match(first.magnet ?? '', /^magnet:\?xt=urn:btih:fdeeac2ec61e28d90f24500c3543d9e6ad2db0ab/i);
      // O `.torrent` de `torcache.net` NÃO vira release: não é magnet nem protetor
      // na allowlist do profile, e é o que o card vivo também descarta.
      assert.ok(!releases.some((r) => r.magnet?.includes('.torrent')));
      // Título montado pelo `releaseTitle` do profile a partir do `<h1>` CRU.
      assert.equal(first.title, 'O Final da Turnê Rip e (2016) [720p BLU-RAY DUBLADO]');
      // As duas qualidades saem do TÍTULO do servidor do post ("SERVIDORES PARA
      // DOWNLOAD … 720p" e "… 1080p"), não do texto do botão.
      assert.equal(releases[1]?.title, 'O Final da Turnê Rip e (2016) [1080p BLU-RAY DUBLADO]');
    },
  ));

  test('o mesmo magnet em dois botões vira uma release só (dedupe por hash)', () => withStub(
    pageRoutes({
      [MOVIE]: () => `<h1>Repetido (2020)</h1><p>SERVIDORES PARA DOWNLOAD 720p</p>`
        + '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=x">m</a>'
        + '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=x">m</a>',
    }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'done');
      assert.equal(result.releases?.length, 1);
      assert.equal(result.requestCost, 1);
    },
  ));

  test('post sem botão de torrent é no-torrent, com o custo da página', () => withStub(
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

  test('página de série pedida como filme é recusada antes da rede', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(SERIES, { kind: 'movie' });
      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /temporada_com_kind_movie/);
      assert.equal(stub.calls.length, 0);
    },
  ));

  test('`kind: tv_show` em página de FILME é recusado com ZERO rede', () => withStub(
    pageRoutes(), async (stub) => {
      // O motor classifica pelo slug (única fonte de tipo: o `post-sitemap*` é
      // misto), então esta linha só existe com o store editado. Gravar o filme na
      // chave de série é a mesma obra errada do outro lado, e sai antes da rede.
      const result = await site().fetchWork(MOVIE, { kind: 'tv_show', series: { enabled: true, maxCards: 4, maxButtons: 4 } });
      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /filme_com_kind_tv_show/);
      assert.equal(stub.calls.length, 0);
    },
  ));

  test('host de fora e caminho que não é obra são rejeitados na porta', () => withStub(
    pageRoutes(), async (stub) => {
      await assert.rejects(() => site().fetchWork(`${OFFSITE}/qualquer-post/`), /blocked_host:filmes-exemplo-spam\.test/);
      await assert.rejects(() => site().fetchWork(`${SITE}/generos/acao/`), /not_a_work_page/);
      await assert.rejects(() => site().fetchWork(`${SITE}/filmes/`), /not_a_work_page/);
      assert.equal(stub.calls.length, 0);
    },
  ));
});

describe('crawl-sites/bludv: instância de produção', () => {
  test('a fábrica do registry não liga o modo amostra', () => {
    assert.throws(() => bludvCrawlSite(), /resolvedor embutido não carregado/);
  });

  test('a flag por chamada cabe no contrato compartilhado sem campo novo', () => {
    const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
    assert.equal(opts.kind, 'tv_show');
  });
});

describe('crawl-sites/bludv: o registro do catálogo', () => {
  test('o corpo de um sitemap só é reconhecido como XML de sitemap', () => {
    assert.equal(isSitemapXml(fixture('post-sitemap.xml')), true);
    assert.equal(isSitemapXml(fixture('sitemap-index.xml')), true);
    assert.equal(isSitemapXml(fixture('post-sitemap-recorte.xml')), true);
    // Um HTML 200 que não é sitemap precisa ser RECONHECIDO como tal, senão volta
    // lista vazia e o motor acha que leu o acervo inteiro.
    assert.equal(isSitemapXml('<html><body>Just a moment...</body></html>'), false);
    assert.equal(isSitemapXml(''), false);
  });
});
