// Adaptador do HDRTorrent (`crawl-sites/hdrtorrents.ts`) contra as fixtures
// REAIS do site.
//
// As fixtures são recortes de capture de 2026-09-29 (o aviso está no cabeçalho
// de cada arquivo): o bloco do card inteiro na listagem, e `<h1>` + ficha +
// `download-row` no post. O `fetch` é substituído e o PROFILE REAL monta a
// superfície, então `parseListingHtml`, `parseContentMagnets` e `releaseTitle`
// exercitados são os de produção.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hdrFixture, hdrListingUrls, listingRoute, withSite, type HdrRoute } from './helpers/crawl-hdrtorrents-fixtures.js';
import { parseImdbId } from '../src/providers/crawl-sites/hdrtorrents-discovery.js';

const SERIES_POST = 'https://hdrtorrents.net/os-irregulares-de-baker-street-1-temporada-completa-legendada-torrent-download/';
const SERIES_EP_POST = 'https://hdrtorrents.net/presidente-curtis-1a-temporada-torrent-download/';
const MOVIE_POST = 'https://hdrtorrents.net/codigo-de-conduta-torrent-download/';

/** Limites de série que a opção do painel manda (o portão exige `enabled`). */
const SERIES_ON = { enabled: true, maxCards: 10, maxButtons: 40 };

describe('HDRTorrent: descoberta pela listagem', () => {
  test('a página 1 real é MISTA: 11 filmes + 9 séries, e o PRIMEIRO é o post mais novo', async () => {
    // Guarda de regressão do bug do `<a>` do logo roubando o primeiro card:
    // com o `[\s\S]*?` do parser, o `[0]` saía com o href da home e o título
    // do card seguinte — e o acervo inteiro perdia 1 post por página.
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      const expected = hdrListingUrls('pagina-1-cheia');
      assert.equal(expected.length, 20);
      assert.equal(found.urls.length, 20, 'a página cheia tem 20 cards');
      assert.deepEqual(found.urls.map((u) => u.url), expected);
      assert.match(found.urls[0].url, /futurama-14a-temporada-torrent-download/,
        'o primeiro card é o post mais novo da página, não a home');
      // 20 de 20 = página INTEIRA, e isso NÃO é fim de catálogo: o acervo tem
      // 2123 páginas (medido). Uma varredura de uma página não pode afirmar que
      // cobriu — a página 2 nem existe no dublê, e ela virar `failures` é o
      // comportamento honesto.
      assert.equal(found.complete, false);
      assert.equal(found.failures.length, 1, 'a página 2 foi pedida e não existe');
      assert.equal(found.requestCost, 2, 'duas páginas lidas: a que existe e a que faltou');
    });
  });

  test('nenhum card traz lastmod: o `datePublished` do card é o ANO da obra', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      for (const u of found.urls) assert.equal(u.lastmod, '');
    });
  });

  test('o tipo vem do card: temporada no slug é `tv_show`, sem é `movie`', async () => {
    // Medido na página 1 real: 20 cards, 9 com `-Nª-temporada` no slug
    // (todos `Série`/`Desenho`) e 11 sem (todos `Filmes`).
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      const series = found.urls.filter((u) => /-\d{1,2}a?-temporada/i.test(u.url));
      assert.equal(series.length, 9);
      assert.ok(series.every((u) => u.kind === 'tv_show'), 'temporada no slug é série');
      const filmes = found.urls.filter((u) => !/-\d{1,2}a?-temporada/i.test(u.url));
      assert.equal(filmes.length, 11);
      assert.ok(filmes.every((u) => u.kind === 'movie'), 'sem temporada no slug é filme');
      // E o `badge-tipo` do card concorda com o slug: "Desenho" (Futurama) é
      // série porque o slug declara a 14ª temporada.
      assert.equal(series.find((u) => u.url.includes('futurama'))?.kind, 'tv_show');
    });
  });

  test('a ÚLTIMA página real (15 de 20) fecha a varredura como fim de acervo', async () => {
    await withSite([listingRoute('pagina-fim-calcanhar')], async ({ site }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      assert.equal(found.urls.length, 15);
      assert.equal(found.complete, true, 'página incompleta É o fim do acervo');
      assert.deepEqual(found.failures, []);
    });
  });

  test('a página fora de faixa (o site devolve o rabo) não estende o acervo', async () => {
    await withSite([listingRoute('pagina-fora-de-faixa')], async ({ site }) => {
      const found = await site.discover(null);
      assert.equal(found.complete, true);
      assert.equal(found.requestCost, 1, 'parou na primeira página: ela já era a última');
    });
  });

  test('séries desligadas: só os filmes da página mista entram na fila', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null);
      assert.equal(found.urls.length, 11, 'os 11 filmes da página');
      assert.equal(found.urls.filter((u) => u.kind === 'tv_show').length, 0);
      assert.equal(found.requestCost, 2, 'a página inteira foi lida (o custo foi gasto)');
    });
  });

  test('o cursor de listagem é gravado: a segunda rodada NÃO volta à página 1', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site, urls }) => {
      const first = await site.discover(null);
      // Duas requisições: a página 1 (que existe) e a 2 (que o dublê não tem).
      assert.equal(first.requestCost, 2);
      const second = await site.discover(null);
      // A segunda rodada começa na página 2 (o cursor foi gravado) e ela não
      // existe no dublê: 404. O importante é QUE ELA FOI PEDIDA — voltar à
      // página 1 releria o mesmo acervo para sempre.
      assert.match(urls.at(-1) ?? '', /\/pagina\/2\//);
      assert.equal(second.urls.length, 0);
      assert.equal(second.failures.length, 1);
    });
  });
});

describe('HDRTorrent: o post', () => {
  const postRoute = (url: string, fixture: string): [string, HdrRoute] => [url, { body: hdrFixture(fixture) }];

  test('IMDb: widget não é identidade; âncora canônica sobrevive e comentários são ignorados', () => {
    const widget = '<a href="https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt">7.0</a>';
    assert.equal(parseImdbId(widget), null, 'plugin isolado não deve identificar a obra');
    assert.equal(parseImdbId(`${widget}<a href="https://www.imdb.com/title/tt0340163/">IMDb</a>`), 'tt0340163');
    assert.equal(parseImdbId('<a href="https://www.imdb.com/title/tt0340163/">IMDb</a>'
      + '<a href="https://www.imdb.com/title/tt1234567/">IMDb</a>'), null, 'âncoras canônicas ambíguas seguem null');
    assert.equal(parseImdbId('<!-- <a href="https://www.imdb.com/title/tt1959490/">widget</a> -->'), null);
    assert.equal(parseImdbId('<a href="https://notimdb.com/title/tt1234567/">falso domínio</a>'), null);
    for (const query of ['?REF_=tt_plg_rt', '?ref%5F=tt_plg_rt', '?ref_=TT_PLG_RT']) {
      assert.equal(parseImdbId(`<a href="https://www.imdb.com/title/tt1959490/${query}">plugin</a>`), null, query);
    }
    for (const path of ['list?x=1', 'listicle?x=1', 'ref_?x=1']) {
      assert.equal(parseImdbId(`<a href="https://www.imdb.com/title/tt1959490/${path}">widget</a>`), null, path);
    }
    assert.equal(parseImdbId('<a href="https://www.imdb.com/title/tt0340163/listend">IMDb</a>'), 'tt0340163');
    assert.equal(parseImdbId('<a href="https://m.imdb.com/title/tt0340163/">IMDb</a>'), 'tt0340163');
    assert.equal(parseImdbId('<a href="https://www.imdb.com/title/tt1959490/?x=1&amp;ref_=tt_plg_rt">widget</a>'), null);
    assert.equal(parseImdbId('<a href="https://www.imdb.com/title/tt1234567/?ref_=tt_review">obra</a>'), 'tt1234567');
  });

  test('fetchWork não devolve IMDb de widget; mantém metadados para identificação por título/ano', async () => {
    const html = hdrFixture('post-filme')
      .replaceAll('https://www.imdb.com/title/tt1197624/', 'https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt');
    await withSite([[MOVIE_POST, { body: html }]], async ({ site }) => {
      const work = await site.fetchWork(MOVIE_POST, { kind: 'movie' });
      assert.equal(work.status, 'done');
      assert.equal(work.imdb, null);
      assert.equal(work.title, 'Código de Conduta');
      assert.equal(work.year, 2009);
      assert.equal(work.releases?.length, 1);
    });
  });

  test('filme: releases com magnet, tamanho da ficha e o título do profile', async () => {
    await withSite([postRoute(MOVIE_POST, 'post-filme')], async ({ site }) => {
      const work = await site.fetchWork(MOVIE_POST, { kind: 'movie' });
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'movie');
      assert.equal(work.title, 'Código de Conduta');
      assert.equal(work.year, 2009);
      assert.equal(work.imdb, 'tt1197624');
      assert.equal(work.requestCost, 1, 'post = 1 requisição (magnet direto, sem protetor)');
      const releases = work.releases ?? [];
      assert.equal(releases.length, 1);
      assert.match(releases[0].infoHash ?? '', /^[a-f0-9]{40}$/);
      assert.match(String(releases[0].magnet), /[?&]dn=/, 'o filme também leva o magnet com `dn=`');
      assert.equal(releases[0].seeders, 1, 'fonte BR não publica seeder');
      assert.equal(releases[0].isBr, true);
      assert.equal(releases[0].size, Math.round(1.01 * 1024 ** 3));
      assert.match(releases[0].title ?? '', /Código de Conduta/);
      assert.match(releases[0].title ?? '', /\[.*DUBLADO.*\]/, 'o profile decide o áudio do rótulo');
    });
  });

  test('série de temporada: grupos por locação, com a temporada do `<h1>`', async () => {
    await withSite([postRoute(SERIES_POST, 'post-serie')], async ({ site }) => {
      const work = await site.fetchWork(SERIES_POST, { kind: 'tv_show', series: SERIES_ON });
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'series');
      assert.equal(work.title, 'Os Irregulares de Baker Street');
      assert.equal(work.year, 2021);
      assert.equal(work.season, 1, 'a temporada vem do `<h1>`, e não do `datePublished`');
      assert.equal(work.imdb, 'tt10893694');
      const groups = work.groups ?? [];
      assert.equal(groups.length, 1);
      assert.equal(groups[0].season, 1);
      assert.equal(groups[0].releases.length, 2);
    });
  });

  test('série com AVULSOS por episódio: a locação sai do `dn=` de cada magnet', async () => {
    await withSite([postRoute(SERIES_EP_POST, 'post-serie-episodios')], async ({ site }) => {
      const work = await site.fetchWork(SERIES_EP_POST, { kind: 'tv_show', series: SERIES_ON });
      assert.equal(work.status, 'done');
      assert.equal(work.season, 1);
      const groups = work.groups ?? [];
      // O `dn=` de cada magnet declara o episódio (`Presidente Curtis S01E03 …`)
      // e o rótulo do profile não ("Presidente Curtis [1080p WEB-DL DUAL]"):
      // sem o magnet na release, os 9 botões caíam TODOS no grupo da temporada
      // e cada episódio avulso virava pack de todo episódio.
      const locations = groups.map((g) => `S${g.season}E${g.episode ?? '*'}:${g.releases.length}`);
      assert.deepEqual(locations, [
        // `S01E01-02` é arquivo de DOIS episódios: temporada, a régua do Vaca.
        'S1E*:1',
        'S1E3:1', 'S1E4:1', 'S1E5:1', 'S1E6:1', 'S1E7:1', 'S1E8:1', 'S1E9:1', 'S1E10:1',
      ]);
      for (const release of groups.flatMap((g) => g.releases)) {
        assert.match(String(release.magnet), /^magnet:\?xt=urn:btih:/i, 'o magnet inteiro viaja (dn + trackers)');
      }
    });
  });

  test('série SEM temporada no slug agrega a série: uma temporada por magnet, pelo `dn=`', async () => {
    // Castle real: era recusada como "página de filme" (filme_com_kind_tv_show),
    // e 1.624 séries ficaram fora do acervo na VPS (2026-10-01).
    const AGG = 'https://hdrtorrents.net/castle-torrent-download/';
    await withSite([postRoute(AGG, 'post-serie-agregada')], async ({ site }) => {
      const work = await site.fetchWork(AGG, { kind: 'tv_show', series: SERIES_ON });
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'series');
      assert.equal(work.season, 7, 'a maior temporada declarada abre a janela da identificação');
      const seasons = (work.groups ?? []).map((g) => `S${g.season}E${g.episode ?? '*'}`);
      assert.deepEqual(seasons, ['S1E*', 'S2E*', 'S3E*', 'S4E*', 'S5E*', 'S6E*', 'S7E*']);
    });
  });

  test('séries desligadas: `kind:tv_show` é recusado com ZERO rede', async () => {
    // SEM `series` na chamada: é o estado real do painel com séries desligadas.
    await withSite([postRoute(SERIES_POST, 'post-serie')], async ({ site, urls }) => {
      const work = await site.fetchWork(SERIES_POST, { kind: 'tv_show' });
      assert.equal(work.status, 'error');
      assert.match(String(work.error), /séries desligadas/);
      assert.equal(urls.length, 0, 'a recusa é do portão, não do site');
    });
  });

  test('página de série pedida como filme é recusada ANTES de qualquer fetch', async () => {
    await withSite([postRoute(SERIES_POST, 'post-serie')], async ({ site, urls }) => {
      const work = await site.fetchWork(SERIES_POST, { kind: 'movie' });
      assert.equal(work.status, 'error');
      assert.match(String(work.error), /temporada_com_kind_movie/);
      assert.equal(urls.length, 0, 'zero rede: gravar pack de temporada como filme é obra errada');
    });
  });

  test('host de fora do site é recusado na porta (defesa em profundidade)', async () => {
    await withSite([], async ({ site, urls }) => {
      await assert.rejects(() => site.fetchWork('https://exemplo.inimigo/x-torrent-download/', { kind: 'movie' }));
      assert.equal(urls.length, 0);
    });
  });

  test('página que não é de obra (taxonomia do site) é recusada', async () => {
    await withSite([], async ({ site, urls }) => {
      // `/filmes/` e `/series/` são navegação, e terminam sem `-torrent-download`.
      await assert.rejects(() => site.fetchWork('https://hdrtorrents.net/filmes/', { kind: 'movie' }));
      assert.equal(urls.length, 0);
    });
  });

  test('erro do site carrega o custo MEDIDO, não 1 (F1)', async () => {
    await withSite([], async ({ site }) => {
      await assert.rejects(
        () => site.fetchWork('https://hdrtorrents.net/slug-que-nao-existe-torrent-download/', { kind: 'movie' }),
        (err: Error & { requestCost?: number }) => {
          assert.equal(err.requestCost, 1, 'uma página foi pedida antes de falhar');
          assert.ok(err.message.length > 0);
          return true;
        },
      );
    });
  });
});

describe('HDRTorrent: card post no registro', () => {
  test('o registry aponta para o módulo real (não mais "adaptador pendente")', async () => {
    const { ensureSite, tableIds, adapterIds, siteInfo, SITE_TABLE } = await import('../src/providers/crawl-sites/registry.js');
    const entry = SITE_TABLE.find((e) => e.id === 'hdrtorrent-cardigann');
    assert.ok(entry, 'o card está na tabela');
    assert.equal(typeof entry.module, 'function', 'tem módulo lazy');
    assert.equal(entry.exportName, 'hdrtorrentsCrawlSite');
    assert.equal(entry.note, undefined, 'não é mais pendência');
    assert.ok(tableIds().includes('hdrtorrent-cardigann'));
    assert.ok(adapterIds().includes('hdrtorrent-cardigann'), 'conta como site com adaptador');
    assert.deepEqual(siteInfo('hdrtorrent-cardigann'), {
      id: 'hdrtorrent-cardigann', label: 'HDRTorrent', known: true, adapter: true, note: null,
    });
    // Sem o profile carregado, `ensureSite` devolve `null` EXPLÍCITO (e não
    // lança, e não devolve um adaptador meio morto): o motor marca o site como
    // `sem-adaptador` e o painel mostra o motivo.
    assert.equal(await ensureSite('hdrtorrent-cardigann'), null);
  });
});
