// Adaptador do Apache Torrents (`crawl-sites/apachetorrent.ts`) contra as
// fixtures REAIS do site.
//
// As fixtures são recortes de capture de 2026-09-29 (o aviso está no cabeçalho
// de cada arquivo): o `ItemList` do topo + o card inteiro de cada card na
// listagem, e `<h1>` + `item-lead` + ficha + blocos de download no post. O
// `fetch` é substituído e o PROFILE REAL monta a superfície, então
// `parsePostMagnets` e `releaseTitle` exercitados são os de produção; a
// extração do card é a regra pura de `apachetorrent-discovery.ts`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  APACHE_BASE, apacheFixture, apacheItemListKinds, apacheListingUrls, listingRoute, withSite,
  type ApacheRoute,
} from './helpers/crawl-apachetorrent-fixtures.js';
import { parseImdbId } from '../src/providers/crawl-sites/apachetorrent-discovery.js';

const MOVIE_POST = `${APACHE_BASE}/as-rainhas-da-torcida-baixar-torrent/`;
const SERIES_POST = `${APACHE_BASE}/lanternas-1a-temporada-baixar-torrent/`;
const DESENHO_POST = `${APACHE_BASE}/presidente-curtis-1a-temporada-baixar-torrent/`;
/** Primeiro card da página 1 capturada (post mais novo do dia da captura). */
const NEWEST_POST = `${APACHE_BASE}/futurama-14a-temporada-baixar-torrent/`;
/** Slug `(Série de …)` SEM temporada — 2 de 120 cards de 6 páginas reais. */
const SERIES_WITHOUT_SEASON_SLUG = `${APACHE_BASE}/avante-nos-bastidores-de-x-men-97-legendada-baixar-torrent/`;

/** Limites de série que a opção do painel manda (o portão exige `enabled`). */
const SERIES_ON = { enabled: true, maxCards: 10, maxButtons: 40 };

const postRoute = (url: string, fixture: string): [string, ApacheRoute] => [url, { body: apacheFixture(fixture) }];

describe('ApacheTorrent: a regra pura do card', () => {
  test('o card 2× por post vira UMA linha, e o dedupe é o que fecha a contagem', () => {
    const html = apacheFixture('pagina-1-cheia');
    // 40 âncoras de obra (capa + título de cada card) para 20 cards: sem
    // dedupe a página pareceria com 40 linhas e NENHUMA página do acervo
    // passaria a ser reconhecida como calcanhar.
    const anchors = [...html.matchAll(/<a\b[^>]*?\bhref=["']([^"']*-baixar-torrent\/)["']/gi)];
    assert.equal(anchors.length, 40, 'a página real traz 2 links por card');
    assert.equal(anchors.filter((m) => m[1] === NEWEST_POST).length, 2, 'o mesmo post 2×');
    assert.equal(apacheListingUrls('pagina-1-cheia').length, 20, '20 obras únicas');
  });

  test('a taxonomia e a paginação NÃO são cards de obra', () => {
    for (const href of ['/filmes/', '/series/', '/desenhos/', '/genero/acao/', '/qualidade/4k/', '/pagina/2/', '/login.php']) {
      assert.doesNotMatch(href, /-baixar-torrent\/$/, `${href} é navegação`);
    }
    // A paginação mora DENTRO do recorte do último card (o split é pelo
    // `<div class="capa-item">` e a nav vem logo depois), então a regra tem que
    // recusar esses href pelo caminho, não por posição.
    const html = apacheFixture('pagina-1-cheia');
    assert.match(html, /<a class="page-link" href="https:\/\/apachetorrents\.com\/pagina\/2\/"/,
      'a nav do rodapé é parte do recorte');
    assert.ok(!apacheListingUrls('pagina-1-cheia').some((u) => u.includes('/pagina/')),
      'a paginação não entra como obra');
  });

  test('o tipo que o PRÓPRIO site publica no ItemList bate com o do card+slug', () => {
    // 20 cards: 11 `(Filme de …)` e 9 de série — 7 `(Série de …)` mais os 2
    // `(Desenho de …)` com temporada no slug, que é o caso que o desempate do
    // slug resolve. O `ItemList` de `ld+json` é a conferência independente: se
    // o tipo deduzido divergir do que o site declara, a regra errou.
    const declared = apacheItemListKinds('pagina-1-cheia');
    assert.equal(declared.length, 20);
    assert.equal(declared.filter((k) => k === 'movie').length, 11);
    assert.equal(declared.filter((k) => k === 'tv_show').length, 9);
  });
});

describe('ApacheTorrent: descoberta pela listagem', () => {
  test('a página 1 real entrega 20 cards, sem lastmod, e a página 2 é pedida', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site, urls }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      const expected = apacheListingUrls('pagina-1-cheia');
      assert.equal(expected.length, 20);
      assert.equal(found.urls.length, 20, 'a página cheia tem 20 cards (o dedupe conta)');
      assert.deepEqual(found.urls.map((u) => u.url), expected);
      assert.equal(found.urls[0].url, NEWEST_POST, 'o primeiro card é o post mais novo');
      // 20 de 20 = página INTEIRA, e isso NÃO é fim de catálogo: o acervo tem
      // 2123 páginas (medido). Uma varredura de uma página não pode afirmar que
      // cobriu — a página 2 nem existe no dublê, e ela virar `failures` é o
      // comportamento honesto.
      assert.equal(found.complete, false);
      assert.equal(found.failures.length, 1, 'a página 2 foi pedida e não existe');
      assert.equal(found.requestCost, 2, 'duas páginas lidas: a que existe e a que faltou');
      assert.ok(urls.some((u) => /\/pagina\/2\/$/.test(u)), 'a paginação avança pelo cursor');
    });
  });

  test('nenhum card traz lastmod: o "(Filme de 2019)" do card é o ANO DA OBRA', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      for (const u of found.urls) assert.equal(u.lastmod, '');
    });
  });

  test('o tipo vem do card; a página 1 é MISTA e o desenho desempata pelo slug', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null, { series: SERIES_ON });
      const series = found.urls.filter((u) => u.kind === 'tv_show');
      const movies = found.urls.filter((u) => u.kind === 'movie');
      assert.equal(movies.length, 11);
      assert.equal(series.length, 9);
      // "Presidente Curtis" e "Futurama" são os dois `(Desenho de 2026)` da
      // página: o badge é ambíguo (série de desenho E desenho que é filme) e
      // quem desempata é o slug, que declara a temporada.
      const desenhos = series.filter((u) => /presidente-curtis|futurama/.test(u.url));
      assert.equal(desenhos.length, 2, 'os dois desenhos com temporada no slug são série');
      assert.ok(desenhos.every((u) => u.kind === 'tv_show'));
      // E o kind deduzido bate card a card com o que o site publica no
      // `ItemList` da MESMA página (conferência independente).
      assert.deepEqual(
        found.urls.map((u) => u.kind),
        apacheItemListKinds('pagina-1-cheia'),
      );
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
    // Medido: `/pagina/2124/` devolve a MESMA página que `/pagina/2123/`, com
    // os mesmos 15 cards. O cursor é semeado em 2124 para a rodada começar
    // JÁ na página fora de faixa — é esse o caso que a trava de fim tem de
    // fechar, e ele não aparece se a varredura partir da página 1.
    await withSite([[`${APACHE_BASE}/pagina/2124/`, { body: apacheFixture('pagina-fim-calcanhar') }]], async ({ site, urls }) => {
      const { startListingCursor } = await import('../src/providers/crawl-cursor.js');
      const { saveListingCursorForSeries } = await import('../src/providers/crawl-listing-series.js');
      const cursor = startListingCursor('apachetorrent-cardigann', 'movie', '/pagina/', Date.now());
      cursor.page = 2124;
      saveListingCursorForSeries(cursor, true);
      const found = await site.discover(null, { series: SERIES_ON });
      assert.equal(urls[0], `${APACHE_BASE}/pagina/2124/`, 'a rodada começa na página do cursor');
      assert.equal(found.urls.length, 15);
      assert.equal(found.complete, true, 'o rabo do site é o fim, não mais acervo');
      assert.equal(found.requestCost, 1, 'parou na primeira página: ela já era a última');
    });
  });

  test('séries desligadas: só os filmes da página mista entram na fila', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site }) => {
      const found = await site.discover(null);
      assert.equal(found.urls.length, 11, 'os 11 filmes da página');
      assert.equal(found.urls.filter((u) => u.kind === 'tv_show').length, 0);
      // A completude de série é `false` (e não `true`) porque as URLs foram
      // lidas e DESCARTADAS: a listagem é a MESMA fonte dos dois kinds.
      assert.equal(found.completeByKind?.tv_show, false);
      assert.equal(found.completeByKind?.movie, false, 'a página 2 faltou, então filme também não cobriu');
      assert.equal(found.requestCost, 2, 'a página inteira foi lida (o custo foi gasto)');
    });
  });

  test('o cursor de listagem é gravado: a segunda rodada NÃO volta à página 1', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site, urls }) => {
      const first = await site.discover(null);
      assert.equal(first.requestCost, 2);
      const second = await site.discover(null);
      assert.match(urls.at(-1) ?? '', /\/pagina\/2\//);
      assert.equal(second.urls.length, 0);
      assert.equal(second.failures.length, 1);
    });
  });
});

describe('ApacheTorrent: o post', () => {
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
    const html = apacheFixture('post-filme')
      .replaceAll('https://www.imdb.com/title/tt5125894/', 'https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt');
    await withSite([[MOVIE_POST, { body: html }]], async ({ site }) => {
      const work = await site.fetchWork(MOVIE_POST, { kind: 'movie' });
      assert.equal(work.status, 'done');
      assert.equal(work.imdb, null);
      assert.equal(work.title, 'As Rainhas da Torcida');
      assert.equal(work.year, 2019);
      assert.equal(work.releases?.length, 3);
    });
  });

  test('filme: releases com magnet, tamanho da ficha, IMDb e o original sem rótulo', async () => {
    await withSite([postRoute(MOVIE_POST, 'post-filme')], async ({ site }) => {
      const work = await site.fetchWork(MOVIE_POST, { kind: 'movie' });
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'movie');
      assert.equal(work.title, 'As Rainhas da Torcida');
      assert.equal(work.year, 2019);
      assert.equal(work.imdb, 'tt5125894');
      // O Apache NÃO rotula o título original: é o primeiro `<strong>` da
      // ficha, o único sem `:` depois. O helper compartilhado dos WordPress
      // não o enxergaria.
      assert.equal(work.originalTitle, 'Poms');
      assert.equal(work.requestCost, 1, 'post = 1 requisição (magnet direto, sem protetor)');
      const releases = work.releases ?? [];
      assert.equal(releases.length, 3, 'os 3 blocos de download do post');
      // O MESMO post publica as duas formas de hash (medido na fixture: 2 em
      // hex de 40 e 1 em base32 de 32) — `magnetHash` tem de aceitar as duas,
      // senão um terço do acervo some da lista.
      assert.equal(releases.filter((r) => /^[a-f0-9]{40}$/.test(r.infoHash ?? '')).length, 2);
      assert.equal(releases.filter((r) => /^[a-z0-9]{32}$/.test(r.infoHash ?? '')).length, 1);
      assert.equal(releases[0].seeders, 1, 'fonte BR não publica seeder');
      assert.equal(releases[0].isBr, true);
      // Um tamanho por POST na ficha (`<strong>Tamanho</strong>: 1.78 GB`),
      // repetido nas 3 linhas: o botão do site não traz, a ficha traz.
      assert.equal(releases[0].size, Math.round(1.78 * 1024 ** 3));
      assert.ok(releases.every((r) => r.size === releases[0].size));
      assert.match(releases[0].title ?? '', /As Rainhas da Torcida/);
      // O rótulo é do PROFILE, e o site escreve "Dublado / Dual Áudio" na
      // ficha — o `classifyAudio` dele dá DUAL a prioridade (a faixa é dual),
      // e é essa a tag que sai. Medido nas 3 linhas: 1080p WEB-DL, 720p, 1080p.
      assert.deepEqual(releases.map((r) => r.title), [
        'As Rainhas da Torcida [1080p WEB-DL DUAL]',
        'As Rainhas da Torcida [720p DUAL]',
        'As Rainhas da Torcida [1080p DUAL]',
      ]);
    });
  });

  test('série de temporada: grupos por locação, com a temporada do `<h1>`', async () => {
    await withSite([postRoute(SERIES_POST, 'post-serie')], async ({ site }) => {
      const work = await site.fetchWork(SERIES_POST, { kind: 'tv_show', series: SERIES_ON });
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'series');
      assert.equal(work.title, 'Lanternas');
      assert.equal(work.year, 2026);
      assert.equal(work.season, 1, 'a temporada vem do `<h1>`, e não do ano do card');
      // Este post é o que NÃO tem IMDb: `null` é o comportamento honesto e a
      // identificação cai para título+ano.
      assert.equal(work.imdb, null);
      // O `S01` colado no original da ficha é o código da temporada, não parte
      // do nome — sem tira-lo, "Lanterns S01" não casaria com o
      // `original_title` do catálogo ("Lanterns").
      assert.equal(work.originalTitle, 'Lanterns');
      // Cada botão é UM episódio pelo `dn=` do magnet (`Lanternas S01E03 …`);
      // o rótulo não traz episódio, e sem o magnet na release os 7 caíam
      // juntos no grupo da temporada, como pack de todo episódio.
      const locations = (work.groups ?? []).map((g) => `S${g.season}E${g.episode ?? '*'}:${g.releases.length}`);
      assert.deepEqual(locations, ['S1E1:1', 'S1E2:1', 'S1E3:1', 'S1E4:1', 'S1E5:1', 'S1E6:1', 'S1E7:1']);
      for (const release of (work.groups ?? []).flatMap((g) => g.releases)) {
        assert.match(String(release.magnet), /^magnet:\?xt=urn:btih:/i, 'o magnet inteiro viaja (dn + trackers)');
      }
    });
  });

  test('desenho de temporada: o tipo do `<h1>` não decide, o post declara série', async () => {
    await withSite([postRoute(DESENHO_POST, 'post-serie-desenho')], async ({ site }) => {
      const work = await site.fetchWork(DESENHO_POST, { kind: 'tv_show', series: SERIES_ON });
      assert.equal(work.status, 'done');
      assert.equal(work.type, 'series');
      assert.equal(work.title, 'Presidente Curtis');
      assert.equal(work.season, 1);
      assert.equal(work.imdb, 'tt37692332', 'o site usa a forma `/pt/title/`');
      // A ficha deste post NÃO publica tamanho: ausente é `undefined`, nunca 0
      // (que o filtro de tamanho leria como torrent de tamanho zero).
      const releases = (work.groups ?? []).flatMap((g) => g.releases);
      assert.equal(releases.length, 9);
      assert.ok(releases.every((r) => r.size === undefined));
      // Post de desenho com os 9 hashes em base32 (medido na fixture): a outra
      // forma da mesma medida de hash, e ela tem de chegar inteira.
      assert.ok(releases.every((r) => /^[a-z0-9]{32}$/.test(r.infoHash ?? '')));
    });
  });

  test('séries desligadas: `kind:tv_show` é recusado com ZERO rede', async () => {
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

  test('filme pedido como série: a recusa sai do POST, e a rede gasta é reportada', async () => {
    // FASE 2 da coerência de tipo, e a razão de ela não ser decidida pela
    // URL: 2 de 120 cards de 6 páginas reais declaram `(Série de …)` SEM
    // temporada no slug, então "sem temporada no slug ⇒ é filme" mataria
    // série real na porta. O post é quem declara o tipo.
    await withSite([postRoute(MOVIE_POST, 'post-filme')], async ({ site, urls }) => {
      const work = await site.fetchWork(MOVIE_POST, { kind: 'tv_show', series: SERIES_ON });
      assert.equal(work.status, 'error');
      assert.match(String(work.error), /filme_com_kind_tv_show/);
      assert.equal(work.requestCost, 1, 'a página foi lida: o custo real, não 0');
      assert.equal(urls.length, 1, 'uma requisição, e ela é a do post');
    });
  });

  test('host de fora do site é recusado na porta (defesa em profundidade)', async () => {
    await withSite([], async ({ site, urls }) => {
      await assert.rejects(() => site.fetchWork('https://exemplo.inimigo/x-baixar-torrent/', { kind: 'movie' }));
      assert.equal(urls.length, 0);
    });
  });

  test('página que não é de obra (taxonomia do site) é recusada', async () => {
    await withSite([], async ({ site, urls }) => {
      // `/filmes/`, `/series/` e `/genero/acao/` são navegação: nenhuma
      // termina em `-baixar-torrent`.
      await assert.rejects(() => site.fetchWork(`${APACHE_BASE}/filmes/`, { kind: 'movie' }));
      await assert.rejects(() => site.fetchWork(`${APACHE_BASE}/genero/acao/`, { kind: 'movie' }));
      assert.equal(urls.length, 0);
    });
  });

  test('erro do site carrega o custo MEDIDO, não 1 (F1)', async () => {
    await withSite([], async ({ site }) => {
      await assert.rejects(
        () => site.fetchWork(`${APACHE_BASE}/slug-que-nao-existe-baixar-torrent/`, { kind: 'movie' }),
        (err: Error & { requestCost?: number }) => {
          assert.equal(err.requestCost, 1, 'uma página foi pedida antes de falhar');
          assert.ok(err.message.length > 0);
          return true;
        },
      );
    });
  });

  test('o slug sem temporada NÃO é recusado por série: a decisão é do post', async () => {
    // Guarda do item acima pelo outro lado: a recusa por "não é temporada" é o
    // que mataria esta linha, e ela existe porque o site tem série sem
    // temporada no slug. Aqui a rota não existe no dublê, então o que se mede
    // é que a página foi PEDIDA (nenhuma recusa de porta aconteceu).
    await withSite([], async ({ site, urls }) => {
      await assert.rejects(() => site.fetchWork(SERIES_WITHOUT_SEASON_SLUG, { kind: 'tv_show', series: SERIES_ON }));
      assert.equal(urls.length, 1, 'pediu o post: a série sem temporada no slug não é recusada');
    });
  });
});

describe('ApacheTorrent: card post no registro', () => {
  test('o registry aponta para o módulo real (não mais "adaptador pendente")', async () => {
    const { ensureSite, tableIds, adapterIds, siteInfo, SITE_TABLE } = await import('../src/providers/crawl-sites/registry.js');
    const entry = SITE_TABLE.find((e) => e.id === 'apachetorrent-cardigann');
    assert.ok(entry, 'o card está na tabela');
    assert.equal(typeof entry.module, 'function', 'tem módulo lazy');
    assert.equal(entry.exportName, 'apachetorrentCrawlSite');
    assert.equal(entry.note, undefined, 'não é mais pendência');
    assert.ok(tableIds().includes('apachetorrent-cardigann'));
    assert.ok(adapterIds().includes('apachetorrent-cardigann'), 'conta como site com adaptador');
    assert.deepEqual(siteInfo('apachetorrent-cardigann'), {
      id: 'apachetorrent-cardigann', label: 'ApacheTorrent', known: true, adapter: true, note: null,
    });
    // Sem o profile carregado, `ensureSite` devolve `null` EXPLÍCITO (e não
    // lança, e não devolve um adaptador meio morto): o motor marca o site como
    // `sem-adaptador` e o painel mostra o motivo.
    assert.equal(await ensureSite('apachetorrent-cardigann'), null);
  });
});
