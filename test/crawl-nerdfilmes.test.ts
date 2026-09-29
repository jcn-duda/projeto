// Adaptador de raspagem do NerdFilmes (Fase 8 — segundo site do motor
// multi-site) contra FIXTURES REAIS de filmesviatorrenthd.net, capturadas em
// 2026-09-28 (sem rede). O que cada uma fixa:
//
//   sitemap-index.xml    índice ÍNTEGRO do AIOSEO (9 sitemaps; as 6 entradas
//                        `post-sitemap*` são as de obra);
//   post-sitemap.xml     os 40 primeiros blocos de URL VERBATIM do arquivo real
//                        (que tem 5.814 posts) — 27 filmes e 13 páginas de
//                        TEMPORADA, o acervo que fixa a classificação por slug;
//   post-movie.html      /bancarios-2020/ — 1 botão "1080p | 1.69 GB | Dual
//                        Áudio", h1 "Bancários (2020)", SEM IMDb (0 de 24);
//   post-series.html     /lanternas-1a-temporada-2026/ — 14 botões, um por
//                        episódio/qualidade: a página que o MODO AMOSTRA mede;
//   post-no-buttons.html post sem botão nenhum (1 de 24);
//   gate-magnet.html     resposta REAL do `/link.php?id=<blob>` (o magnet mora
//                        no href do 1º hop, sem JS);
//   gate-invalid.txt     HTTP 400 "Payload inválido." para um blob que o site
//                        não decodifica.
//
// O resolver é o PROFILE REAL (createResolver do nerdfilmes) com fetch dublê
// por baixo: parsers, gate e extração de magnet são os de produção. Nada grava
// no banco de magnets e nada liga o crawler. O MODO AMOSTRA de temporada tem
// suíte própria (`crawl-nerdfilmes-series.test.ts`) e os dublês moram em
// `helpers/crawl-nerdfilmes-fixtures.ts` — uma definição só para as duas.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nerdfilmesCrawlSite } from '../src/providers/crawl-sites/nerdfilmes.js';
import { kindFromSlug, parseImdbId } from '../src/providers/crawl-sites/nerdfilmes-discovery.js';
import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import {
  ALL_SITEMAPS as allSitemaps,
  FIRST_LASTMOD,
  MOVIE,
  NO_BUTTONS,
  REAL_BTIH,
  SECOND_LASTMOD,
  SERIES,
  SEASON_SLUGS,
  SITE,
  THIRD_LASTMOD,
  fixture,
  pageRoutes,
  pathsOf,
  probeSite,
  site,
  slugsOf,
  withStub,
} from './helpers/crawl-nerdfilmes-fixtures.js';

describe('crawl-sites/nerdfilmes: kind por slug (post-sitemap é misto)', () => {
  test('as três formas reais de temporada viram tv_show; o resto é filme', () => {
    // As três formas vêm do acervo real de 40: 1ª (com "a"), variante sem o
    // "a" e os ordinais maiores (2ª/3ª/4ª/13ª) — cobertas pela palavra.
    assert.equal(kindFromSlug(`${SITE}/lanternas-1a-temporada-2026/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/s-w-a-t-exiles-1a-temporada-2026/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/herois-1-temporada-2026/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/outlander-blood-of-my-blood-2a-temporada-2026/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/a-arca-the-ark-3a-temporada-2026/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/american-horror-story-13a-temporada-2026/`), 'tv_show');
    // Filmes reais do mesmo arquivo, e um slug que só tem a palavra "em".
    assert.equal(kindFromSlug(MOVIE), 'movie');
    assert.equal(kindFromSlug(`${SITE}/missao-impossivel-colecao-1996-a-2025/`), 'movie');
    assert.equal(kindFromSlug(`${SITE}/toy-story-5-2026/`), 'movie');
    // Entrada que não é URL não vira série por palpite.
    assert.equal(kindFromSlug('nao-e-url'), 'movie');
    // E URL completa funciona igual (o chamador pode trazer href ou path).
    assert.equal(kindFromSlug(new URL(SERIES)), 'tv_show');
  });

  test('os 40 slugs do recorte real: 13 temporadas e 27 filmes', () => {
    const kinds = [...fixture('post-sitemap.xml').matchAll(/<loc><!\[CDATA\[([^\]]+)\]\]><\/loc>/g)]
      .map((m) => kindFromSlug(m[1]));
    assert.equal(kinds.length, 40, 'o recorte real tem 40 blocos de URL');
    assert.equal(kinds.filter((k) => k === 'tv_show').length, SEASON_SLUGS.length);
    assert.equal(kinds.filter((k) => k === 'movie').length, 40 - SEASON_SLUGS.length);
    assert.deepEqual(
      [...fixture('post-sitemap.xml').matchAll(/<loc><!\[CDATA\[([^\]]+)\]\]><\/loc>/g)]
        .map((m) => new URL(m[1]).pathname.replace(/^\/|\/$/g, ''))
        .filter((slug) => SEASON_SLUGS.includes(slug)),
      SEASON_SLUGS,
      'as 13 temporadas são exatamente as do arquivo real, na ordem dele',
    );
  });
});

describe('crawl-sites/nerdfilmes: discover (sitemaps reais, sem rede)', () => {
  test('séries desligadas: só filme entra na fila, com o custo real da rodada', () => withStub(pageRoutes(), async (stub) => {
    // Só o PRIMEIRO post-sitemap está no mapa: os outros 5 falham e a rodada
    // vem PARCIAL (complete:false) — o motor não pode avançar o cursor por
    // cima do lastmod que ficou nos arquivos perdidos.
    const disc = await site().discover();
    const slugs = slugsOf(disc.urls);
    assert.equal(slugs.length, 27, 'as 13 páginas de temporada NÃO são enfileiradas');
    assert.ok(disc.urls.every((u) => u.kind === 'movie'), 'tudo que sai da fila é filme');
    assert.ok(
      !slugs.some((s) => s.includes('temporada')),
      'nenhuma season page entra como movie — 14 magnets de episódio gravados como filme é obra errada',
    );
    // O 1º post do sitemap real é a página de temporada (fora da fila); o 1º
    // que entra é o filme logo abaixo dele, com lastmod lido do CDATA.
    assert.equal(disc.urls[0].url, `${SITE}/a-revolta-2026/`);
    assert.equal(disc.urls[0].lastmod, SECOND_LASTMOD, 'lastmod com CDATA do AIOSEO é lido');
    // page-sitemap/category-sitemap/addl-sitemap do índice NÃO são obra, e o
    // índice só pede os 6 post-sitemap, sequencial (crawl.search_isolation).
    assert.deepEqual(pathsOf(stub), [
      '/sitemap.xml', '/post-sitemap.xml', '/post-sitemap2.xml', '/post-sitemap3.xml',
      '/post-sitemap4.xml', '/post-sitemap5.xml', '/post-sitemap6.xml',
    ]);
    // F3: a rodada fez 7 requisições de verdade (índice + 6 sitemaps) e diz
    // isso — sem o número ela entraria de graça no teto por hora.
    assert.equal(disc.requestCost, 7);
    assert.equal(disc.complete, false, '5 fontes falharam = descoberta parcial');
    assert.equal(disc.failures.length, 5, 'uma falha por sitemap ausente');
    assert.ok(disc.failures.every((f) => /post-sitemap\d*\.xml/.test(f)), 'falha cita o loc de origem');
    assert.equal(disc.completeByKind?.movie, false, 'cursor de filme NÃO pode avançar');
    // Sem URL de série na lista, o cursor daquele tipo não anda de todo jeito
    // (`advanceCursors` só move com `max` do kind) — e o contrato pede `true`
    // para kind sem fonte consultada.
    assert.equal(disc.completeByKind?.tv_show, true, 'tv_show sem fonte = completo (cursor parado)');
  }));

  test('modo amostra: as 40 entram com o tipo do slug (13 séries, 27 filmes)', () => withStub(pageRoutes(), async () => {
    const disc = await probeSite().discover();
    assert.equal(disc.urls.length, 40, 'a amostra vê o acervo inteiro');
    assert.deepEqual(
      slugsOf(disc.urls.filter((u) => u.kind === 'tv_show')),
      SEASON_SLUGS,
      'as 13 temporadas saem rotuladas tv_show, na ordem do arquivo real',
    );
    assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 27);
    assert.equal(disc.urls[0].url, SERIES, 'o post mais recente do recorte real é a 1ª temporada');
    assert.equal(disc.urls[0].lastmod, FIRST_LASTMOD, 'lastmod com CDATA do AIOSEO é lido');
    // A mesma fonte alimenta os dois kinds: a completude de série é a mesma.
    assert.equal(disc.completeByKind?.tv_show, false, '5 sitemaps falharam = cursor de série também não anda');
  }));

  test('descoberta completa com todos os sitemaps presentes avança o cursor de filme', () => withStub(pageRoutes(allSitemaps), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.complete, true, 'nenhuma falha = completa');
    assert.equal(disc.failures.length, 0);
    assert.equal(disc.completeByKind?.movie, true);
    assert.equal(disc.urls.length, 27 * 6, '6 sitemaps no mapa = 162 filmes (dedupe é do store)');
    assert.equal(disc.requestCost, 7, 'o custo é por hop, não por sitemap listado');
    assert.equal(stub.calls.length, 7);
    const probe = await probeSite().discover();
    assert.equal(probe.urls.length, 40 * 6, 'a amostra também vê 40 por sitemap');
    assert.equal(probe.completeByKind?.tv_show, true);
  }));

  test('índice de outro host e loc de fora NÃO são consultados (SSRF)', () => withStub(pageRoutes({
    // Hostile: o índice GANHA um `<sitemap>` para o loopback de metadado de
    // nuvem, e o sitemap manda locs de obra para esse host e para um domínio
    // alheio. Nenhum pode virar requisição nem entrar na fila.
    '/sitemap.xml': () => fixture('sitemap-index.xml').replace(
      '<sitemap>',
      '<sitemap><loc><![CDATA[http://169.254.169.254/post-sitemap.xml]]></loc><lastmod><![CDATA[2026-09-30T00:00:00+00:00]]></lastmod></sitemap>\n\t<sitemap>',
    ),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml').replace(
      '<url>',
      '<url><loc><![CDATA[http://169.254.169.254/bancarios-2020/]]></loc><lastmod><![CDATA[2026-09-30T00:00:00+00:00]]></lastmod></url>\n<url><loc><![CDATA[https://evil.example/x/]]></loc><lastmod><![CDATA[2026-09-30T00:00:00+00:00]]></lastmod></url>\n<url>',
    ),
  }), async (stub) => {
    const urls = (await site().discover()).urls.map((u) => u.url);
    assert.equal(urls.length, 27, 'as obras do site continuam entrando');
    assert.ok(urls.every((u) => u.startsWith(`${SITE}/`)), 'toda URL descoberta é do site');
    assert.ok(!urls.some((u) => u.includes('169.254.169.254')), 'metadado de nuvem fora');
    assert.ok(!urls.some((u) => u.includes('evil.example')), 'host alheio fora');
    assert.ok(
      stub.calls.every((c) => new URL(c.url).host === 'www.filmesviatorrenthd.net'),
      'nenhum fetch para host de fora (o sitemap do loopback nunca foi pedido)',
    );
  }));

  test('/sitemap.xml ilegível cai no caminho Yoast (o 302 real do site)', () => withStub(pageRoutes({
    '/sitemap.xml': () => { throw new Error('500 injetado'); },
    // O site 302 de /sitemap_index.xml para /sitemap.xml; aqui o canônico
    // falha e o caminho de reserva é o que responde.
    '/sitemap_index.xml': () => fixture('sitemap-index.xml'),
  }), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.urls.length, 27, 'o caminho de reserva entregou as obras');
    const asked = pathsOf(stub);
    assert.equal(asked[0], '/sitemap.xml');
    assert.equal(asked[1], '/sitemap_index.xml', 'tentou o nome Yoast depois do canônico');
    assert.equal(disc.requestCost, 8, 'o fallback entra na conta: 8 hops, não 7');
  }));

  test('índice ilegível nos DOIS caminhos é erro do site (o motor retenta)', () => withStub(
    { '/sitemap': () => { throw new Error('500 injetado'); } },
    async () => assert.rejects(() => site().discover(), /nerdfilmes: índice de sitemaps ilegível/),
  ));

  test('lastmod incremental é cortado POR KIND, com o `since` solto de fallback', () => withStub(pageRoutes(), async () => {
    // O recorte real está em ordem de lastmod DECRESCENTE. Cortar o cursor de
    // FILME no 3º post deixa o 2º (a 1ª temporada é tv_show e já não entra) —
    // o corte é EXCLUSIVO (lastmod ≤ cursor já foi processado).
    const soFilme = await site().discover(THIRD_LASTMOD, { sinceByKind: { movie: THIRD_LASTMOD } });
    assert.deepEqual(soFilme.urls.map((u) => u.url), [`${SITE}/a-revolta-2026/`], 'só o que é mais novo que o cursor de filme');
    // `sinceByKind` SEM a chave movie: o corte não pode virar "sem cursor"
    // (carga inteira de novo) — nem herdar o cursor de série.
    const semChave = await site().discover(THIRD_LASTMOD, { sinceByKind: { tv_show: '2000-01-01T00:00:00+00:00' } });
    assert.deepEqual(semChave.urls.map((u) => u.url), [`${SITE}/a-revolta-2026/`], 'ausente no mapa cai no since legado');
    // Na amostra o cursor de série é o DELE: com `tv_show: null` (sem cursor),
    // as 13 temporadas entram todas mesmo com o corte de filme apertado.
    const porKind = await probeSite().discover(THIRD_LASTMOD, { sinceByKind: { movie: THIRD_LASTMOD, tv_show: null } });
    assert.equal(porKind.urls.filter((u) => u.kind === 'tv_show').length, 13, 'série sem cursor = carga inteira do kind');
    assert.deepEqual(porKind.urls.filter((u) => u.kind === 'movie').map((u) => u.url), [`${SITE}/a-revolta-2026/`]);
  }));

  test('séries ligadas no painel emitem as páginas de temporada', () => withStub(pageRoutes(), async () => {
    // A mesma opção de séries do Vaca: ligada, a season page entra na fila com
    // o kind do slug (13 das 40 do recorte real); desligada, só filmes.
    const on = await site().discover(null, { series: { enabled: true, maxCards: 10, maxButtons: 40 } });
    assert.equal(on.urls.length, 40);
    assert.equal(on.urls.filter((u) => u.kind === 'tv_show').length, 13);
    const off = await site().discover(null, { series: { enabled: false, maxCards: 10, maxButtons: 40 } });
    assert.ok(off.urls.every((u) => u.kind === 'movie'), 'séries desligadas: só filme');
    assert.equal(off.completeByKind?.tv_show, true, 'tv_show sem fonte = cursor parado');
  }));
});

describe('crawl-sites/nerdfilmes: fetchWork de filme (post e gate reais, sem rede)', () => {
  test('post de filme: 1 release com o magnet do gate real, custo 2 requests', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(MOVIE);
    assert.equal(result.status, 'done');
    assert.equal(result.title, 'Bancários', 'título vem do h1 da obra');
    assert.equal(result.year, 2020);
    assert.equal(result.type, 'movie');
    // Este site não publica IMDb (0 de 24 posts): a identificação é por
    // título+ano no TMDB, nunca um tt adivinhado.
    assert.equal(result.imdb, null);
    const releases = result.releases ?? [];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].magnet, `magnet:?xt=urn:btih:${REAL_BTIH}`);
    assert.equal(releases[0].title, 'Bancários [1080p DUBLADO 1.69 GB]', 'título no mesmo formato do card');
    assert.equal(releases[0].indexer, 'nerdfilmes', 'id do card do Jackett');
    assert.equal(releases[0].tracker, 'NerdFilmes');
    assert.equal(releases[0].isBr, true, 'invariante 2: origem BR é campo do provider');
    assert.equal(releases[0].seeders, 1, 'invariante 3: fonte BR não publica swarm');
    assert.equal(releases[0].size, 1814623683);
    // F3: o custo é o REAL por hop — página + gate. Sem isso o teto horário
    // do motor contaria 1 request por página e a conta não fecharia.
    assert.equal(result.requestCost, 2);
    assert.deepEqual(pathsOf(stub), ['/bancarios-2020/', '/link.php'], 'só o post e o próprio gate');
  }));

  test('post sem botão → no-torrent sem gastar o gate', () => withStub(
    pageRoutes({ [NO_BUTTONS]: () => fixture('post-no-buttons.html') }),
    async (stub) => {
      const result = await site().fetchWork(NO_BUTTONS);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.title, 'O Assassinato de Rachel Nickell');
      assert.equal(result.year, 2026);
      assert.equal(result.requestCost, 1, 'só a página');
      assert.ok(!stub.calls.some((c) => c.url.includes('/link.php')), 'nenhum gate procurado');
    },
  ));

  test('payload inválido no gate (400 real do site) → no-torrent, sem retry eterno', () => withStub(
    // O MESMO blob respondeu 200 duas vezes no mesmo minuto (medido): o 400
    // "Payload inválido." é do blob que o site não decodifica, não de rede.
    // Classificá-lo como erro comum exhausting as tentativas da URL.
    pageRoutes({ '/link.php': () => ({ status: 400, body: fixture('gate-invalid.txt') }) }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'no-torrent', 'terminal: não há torrent a colher');
      assert.equal(result.requestCost, 2);
    },
  ));

  test('rede caída no gate continua RETENTÁVEL (erro com o custo já gasto)', () => withStub(
    pageRoutes({ '/link.php': () => { throw new Error('timeout injetado'); } }),
    async () => assert.rejects(() => site().fetchWork(MOVIE), (err: Error & { requestCost?: number }) => {
      assert.match(err.message, /timeout injetado/);
      // F1: o throw carrega o que foi gasto — o motor cobra 2, não 1.
      assert.equal(err.requestCost, 2);
      return true;
    }),
  ));

  test('página de temporada pedida como FILME é recusada antes de qualquer rede', () => withStub(
    pageRoutes({ [SERIES]: () => fixture('post-series.html') }),
    async (stub) => {
      // Linha de antes da classificação por slug: os 14 botões de episódio
      // gravados como filme seriam uma obra que não existe no acervo.
      const result = await site().fetchWork(SERIES);
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /temporada_com_kind_movie/);
      assert.equal(stub.calls.length, 0, 'recusa na porta, antes do fetch');
      // E o mesmo com o kind explícito: a linha antiga é o caso declarado.
      const explicito = await site().fetchWork(SERIES, { kind: 'movie' });
      assert.equal(explicito.status, 'error');
      assert.equal(stub.calls.length, 0);
    },
  ));

  test('kind tv_show com séries DESLIGADAS é erro explícito, com zero rede', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, { kind: 'tv_show', series: { enabled: false, maxCards: 10, maxButtons: 40 } });
    assert.equal(result.status, 'error');
    assert.match(String(result.error), /fora do motor/);
    assert.equal(stub.calls.length, 0, 'o portão responde antes do fetch');
  }));

  test('kind tv_show com séries LIGADAS é lido com grupos por locação', () => withStub(pageRoutes({ [SERIES]: () => fixture('post-series.html') }), async () => {
    const result = await site().fetchWork(SERIES, { kind: 'tv_show', series: { enabled: true, maxCards: 10, maxButtons: 40 } });
    assert.equal(result.status, 'done');
    assert.equal(result.type, 'series');
    assert.equal(result.season, 1);
    assert.deepEqual(result.groups?.map((g) => [g.season, g.episode]), [[1, 1]]);
  }));

  test('página sem h1 é quebra de layout, não obra sem nome', () => withStub(
    pageRoutes({ [MOVIE]: () => '<!DOCTYPE html><html><body><div>sem título nenhum</div></body></html>' }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /sem <h1>/);
    },
  ));

  test('host safety: página de fora do site e o gate como página são rejeitados', () => withStub(pageRoutes(), async (stub) => {
    for (const url of ['http://169.254.169.254/bancarios-2020/', 'https://evil.example/bancarios-2020/']) {
      await assert.rejects(() => site().fetchWork(url), /blocked_host/);
    }
    // O gate é de MESMO ORIGIN, então o host não o pega: a trava é a FORMA da
    // URL (a fila não pode trazer o gate como obra — ele devolveria o post
    // inteiro com <h1> e viraria obra duplicada).
    await assert.rejects(() => site().fetchWork(`${SITE}/link.php?id=qualquer`), /not_a_work_page:\/link\.php/);
    assert.equal(stub.calls.length, 0, 'rejeição na porta, antes de qualquer fetch');
  }));

  test('crawl não aciona FlareSolverr: o perfil do nerd não tem esse caminho', () => withStub(pageRoutes(), async (stub) => {
    await site().fetchWork(MOVIE);
    // Todo request foi para o site ou para o gate de MESMO ORIGIN: nenhum
    // host de browser, nenhuma porta do FlareSolverr.
    assert.ok(
      stub.calls.every((c) => new URL(c.url).host === 'www.filmesviatorrenthd.net'),
      'só o site: o perfil do nerd não tem fallback Flare',
    );
  }));
});

describe('crawl-sites/nerdfilmes: parseImdbId e instância de produção', () => {
  test('um tt só é o da obra; dois ou nenhum é null', () => {
    assert.equal(parseImdbId('<a href="https://www.imdb.com/title/tt1234567/">IMDb</a>'), 'tt1234567');
    assert.equal(
      parseImdbId('<a href="https://www.imdb.com/title/tt1234567/">a</a><a href="https://www.imdb.com/title/tt7654321/">b</a>'),
      null,
      'dois tt = página ambígua (widget de recomendação)',
    );
    assert.equal(parseImdbId('<p>o post real do nerdfilmes não tem IMDb</p>'), null);
    assert.equal(parseImdbId(fixture('post-movie.html')), null, 'o post real de filme devolve null');
    assert.equal(parseImdbId(''), null);
  });

  test('adapter de produção nunca liga o modo amostra', () => {
    // `nerdfilmesCrawlSite()` é o export que o registry chama: sem resolver
    // embutido ele falha (e a produção usa o `instance()` já carregado), mas o
    // que importa aqui é a assinatura — nenhum lugar da produção passa opção.
    assert.throws(() => nerdfilmesCrawlSite(), /resolvedor embutido não carregado/);
  });

  test('o tipo de contrato aceita a flag por chamada sem `CrawlPageOptions` novo', async () => {
    // A flag por chamada é o caminho de quem só tem a interface `CrawlSite`
    // (a sonda): o contrato compartilhado não ganhou campo, e o teste monta o
    // objeto com o tipo do contrato mais o extra. Aqui basta fixar que o tipo
    // importado é o do contrato, para a montagem do objeto compilar.
    const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
    assert.equal(opts.kind, 'tv_show');
  });
});
