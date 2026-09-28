// Adaptador de raspagem do TorrentDosFilmes V2 (Fase 8 — terceiro site do
// motor multi-site) contra FIXTURES REAIS de torrentdosfilmes-v2.xyz,
// capturadas em 2026-09-28 (sem rede). O que cada uma fixa:
//
//   sitemap-index.xml    índice do YOAST: 45 entradas no site real (27
//                        `post-sitemap*`, 2 `category-sitemap*`, 16
//                        `post_tag-sitemap*`); o recorte mantém 3 post, 1
//                        category e 1 post_tag, na ordem do arquivo — e é a
//                        prova de que o filtro é pelo NOME do arquivo;
//   post-sitemap.xml     40 dos 1.001 blocos VERBATIM. O PRIMEIRO é a home `/`
//                        (o índice de obra do tdf inclui a página inicial) e
//                        há 2 páginas de TEMPORADA (pack);
//   post-movie.html      /como-viajar-com-o-mala-do-seu-pai-2008-…/ — 3 âncoras
//                        de magnet com 2 btih distintos, o `<h1>` com o ano NO
//                        MEIO e o widget de IMDb do plugin de recomendação;
//   post-series.html     /o-cacador-1a-temporada-completa-mini-serie-2014-…/ —
//                        pack de temporada (`dn=O_Caçador.S01Complete`), 1 magnet,
//                        sem IMDb.
//
// O resolver é o PROFILE REAL (createResolver do torrentdosfilmes) com fetch
// dublê por baixo: parsers, allowlist e extração de magnet são os de produção.
// Nada grava no banco de magnets e nada liga o crawler. Os dublês moram em
// `helpers/crawl-torrentdosfilmes-fixtures.ts`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWorkPath, kindFromSlug, parseSitemapEntries, workTitleYear,
} from '../src/providers/crawl-sites/torrentdosfilmes-discovery.js';
import { normalizeTitle } from '../src/utils/title-normalization.js';
import {
  ALL_SITEMAPS as allSitemaps,
  HOME,
  MOVIE,
  MOVIE_LASTMOD,
  SEASON_SLUGS,
  SERIES,
  SITE,
  fixture,
  pageRoutes,
  pathsOf,
  probeSite,
  site,
  slugsOf,
  withStub,
} from './helpers/crawl-torrentdosfilmes-fixtures.js';

const h1 = (text: string): string => `<!DOCTYPE html><html><body><h1>${text}</h1></body></html>`;

describe('crawl-sites/torrentdosfilmes: o nome da obra no <h1> (ano no meio)', () => {
  test('os cinco <h1> reais medidos saem com nome e ano', () => {
    // Estes são os títulos literais das páginas capturadas. O `parseTitleYear`
    // compartilhado (só parêntese FINAL) devolveria `year: null` em TODAS —
    // e página sem ano não chega a consultar o TMDB, ou seja, o site inteiro
    // cairia em `no-work`. A régua do nome é própria deste site por isso.
    const reais: Array<[string, string, number]> = [
      ['Como Viajar com o Mala do seu Pai (2008) BluRay 1080p Dual Áudio – Torrent/GDRIVE',
        'Como Viajar com o Mala do seu Pai', 2008],
      ['O Caçador 1ª Temporada Completa Mini Série (2014) HDTV 720p Dublado Torrent Download',
        'O Caçador', 2014],
      ['Sea Rex 3D Journey to a Prehistoric World (2010) Dublado Download Torrent',
        'Sea Rex 3D Journey to a Prehistoric World', 2010],
      ['Exterminador As Crônicas de Sarah Connor 1ª Temporada Bluray 720p (2008) Dublado',
        'Exterminador As Crônicas de Sarah Connor', 2008],
      ['Lanternas 1ª Temporada Torrent (2026) Dual Áudio 5.1 WEB-DL 1080p',
        'Lanternas', 2026],
    ];
    for (const [bruto, esperado, ano] of reais) {
      const r = workTitleYear(h1(bruto));
      assert.equal(r.title, esperado, `nome fora no título real: ${bruto}`);
      assert.equal(r.year, ano, `ano fora no título real: ${bruto}`);
      assert.equal(r.raw, bruto, 'o texto cru é o que o releaseTitle do profile limpa');
    }
  });

  test('palavra que é parte do nome NÃO é removida (3D, "Original", 2049, ":")', () => {
    // A régua erra para "sobrou ruído" (que vira `nome-sem-casamento`, visível no
    // painel) e nunca para "virou outro nome". Estes quebram se a limpeza for
    // genérica demais: são os casos que uma lista de stopwords arruinaria.
    assert.equal(workTitleYear(h1('Sea Rex 3D: Journey to a Prehistoric World (2010) Dublado 1080p')).title,
      'Sea Rex 3D: Journey to a Prehistoric World');
    assert.equal(workTitleYear(h1('The Original Sin (2010) WEB-DL 720p')).title, 'The Original Sin');
    assert.equal(workTitleYear(h1('Blade Runner 2049 (2017) Dublado 1080p BluRay')).title, 'Blade Runner 2049');
    assert.equal(workTitleYear(h1('Mirrors (2008) Dublado 720p')).title, 'Mirrors',
      '"Mirrors" é nome de obra, não palavra de vitrine');
    // O contrato que importa não é a PONTUAÇÃO sobrevivente, é a igualdade
    // estrita que a identificação faz: o título extraído normaliza para o mesmo
    // nome do catálogo. "Chainsaw Man – O Filme: Arco da Reze" prova que o
    // separador com espaço sai, o ":" interno fica, e o nome continua casando.
    const cadeia = workTitleYear(h1('Chainsaw Man – O Filme: Arco da Reze (2025) Dual Áudio 5.1 WEB-DL 1080p'));
    assert.equal(
      normalizeTitle(cadeia.title),
      normalizeTitle('Chainsaw Man – O Filme: Arco da Reze'),
      'separador com espaço sai, ":" interno fica, e o nome segue casando no TMDB',
    );
    assert.equal(cadeia.year, 2025);
  });

  test('os 4 vazamentos da sonda 40 real: "Rip", "FULL", "/" e o "e" final saem', () => {
    // Estes quatro `<h1>` são literais das páginas medidas em 2026-09-28. Com a
    // régua anterior eles rendiam "Deadpool – Rip", "Arábia FULL",
    // "Noturno / FULL" e "Introspectum Motel e", e TODAS as quatro iam para
    // `no-work` na identificação — a sonda 40 mediu 25/40 e reprovou no limiar.
    const vazamentos: Array<[string, string, number]> = [
      ['Deadpool Torrent – Bluray Rip 720p | 1080p Legendado Download Torrent (2016)', 'Deadpool', 2016],
      ['Contra o Tempo Torrent – BluRay Rip 720p e 1080p Dual Áudio 5.1 Download (2011)', 'Contra o Tempo', 2011],
      ['Arábia Torrent (2018) Nacional WEB-DL 1080p FULL Download', 'Arábia', 2018],
      ['Noturno Torrent (2020) Dual Áudio 5.1 / Dublado WEB-DL 720p FULL – Download', 'Noturno', 2020],
      ['Introspectum Motel Torrent (2021) Dublado e Legendado WEB-DL 1080p – Download', 'Introspectum Motel', 2021],
      // E o que NÃO pode virar nome: "Rip"/"FULL" em caixa de nome ficam.
      ['Mirrors (2008) Dublado 720p', 'Mirrors', 2008],
      ['Full Metal Jacket (1987) BluRay 1080p Dublado', 'Full Metal Jacket', 1987],
    ];
    for (const [bruto, esperado, ano] of vazamentos) {
      const r = workTitleYear(h1(bruto));
      assert.equal(r.title, esperado, `nome fora no h1 real: ${bruto}`);
      assert.equal(r.year, ano);
    }
    // O "e" FINAL sai; o "e" do MEIO é nome ("Deuses e Monstros").
    assert.equal(workTitleYear(h1('Deuses e Monstros (2009) Dublado 720p')).title, 'Deuses e Monstros');
  });

  test('ano só entre parênteses: página sem declaração fica sem ano (o estado honesto)', () => {
    // Um ano solto seria indistinguível do número que faz parte do nome
    // ("Blade Runner 2049"), e a identificação SEM ano é `pagina-sem-ano`:
    // estado próprio da página, sem rede, sem chute.
    assert.equal(workTitleYear(h1('Algum Filme Sem Ano 1080p')).year, null);
    assert.equal(workTitleYear(h1('Os Simpsons 15ª Temporada 720p Dublado Torrent')).year, null);
    assert.equal(workTitleYear(h1('Filme (123) Dublado')).year, null, 'ano de 3 dígitos não é ano');
    assert.equal(workTitleYear('<html><body>sem título</body></html>').title, '');
    assert.equal(workTitleYear(h1('Só o nome do filme')).title, 'Só o nome do filme');
  });

  test('o <h1> do fixture real sai com o nome e o ano medidos', () => {
    const movie = workTitleYear(fixture('post-movie.html'));
    assert.equal(movie.title, 'Como Viajar com o Mala do seu Pai');
    assert.equal(movie.year, 2008);
    const pack = workTitleYear(fixture('post-series.html'));
    assert.equal(pack.title, 'O Caçador', 'a página de temporada identifica a SÉRIE, não o pack');
    assert.equal(pack.year, 2014);
  });
});

describe('crawl-sites/torrentdosfilmes: tipo por slug e forma de página', () => {
  test('"temporada" no slug é tv_show; a home não é página de obra', () => {
    assert.equal(kindFromSlug(SERIES), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/southcliffe-1a-temporada-2013-720p-web-dl-legendado-torrent-download/`), 'tv_show');
    assert.equal(kindFromSlug(`${SITE}/os-simpsons-15a-temporada-720p-dublado-torrent-download/`), 'tv_show');
    assert.equal(kindFromSlug(MOVIE), 'movie');
    assert.equal(kindFromSlug(`${SITE}/busca-implacavel-3-2014-webrip-1080p-legendado-torrent/`), 'movie');
    // O post-sitemap do site inclui a home como PRIMEIRA entrada: sem esta
    // trava a fila ganharia "/" e o `fetchWork` receberia a página inicial.
    assert.equal(isWorkPath(new URL(HOME)), false);
    assert.equal(isWorkPath(new URL(MOVIE)), true);
    assert.equal(isWorkPath(new URL(`${SITE}/feed/`)), false);
    assert.equal(isWorkPath(new URL(`${SITE}/link.php?id=x`)), false);
  });

  test('o recorte real de 40 blocos: 1 home, 39 obras (37 filmes, 2 temporadas)', () => {
    const entries = parseSitemapEntries(fixture('post-sitemap.xml'));
    assert.equal(entries.length, 40, 'o recorte real tem 40 blocos');
    assert.ok(entries.every((e) => e.lastmod), 'lastmod em 40/40 (o site publica em todos)');
    assert.equal(new URL(entries[0].loc).pathname, '/', 'a 1ª entrada do sitemap do site é a home');
    const slugs = slugsOf(entries.filter((e) => isWorkPath(new URL(e.loc))).map((e) => ({ url: e.loc })));
    assert.equal(slugs.length, 39, 'a home sai: 39 obras');
    assert.equal(entries.filter((e) => kindFromSlug(e.loc) === 'tv_show').length, 2);
    assert.equal(entries.filter((e) => kindFromSlug(e.loc) === 'movie' && isWorkPath(new URL(e.loc))).length, 37);
    assert.deepEqual(
      slugsOf(entries.filter((e) => kindFromSlug(e.loc) === 'tv_show').map((e) => ({ url: e.loc }))),
      SEASON_SLUGS,
      'as 2 temporadas são exatamente as do arquivo real, na ordem dele',
    );
  });
});

describe('crawl-sites/torrentdosfilmes: discover (sitemaps reais, sem rede)', () => {
  test('séries desligadas: só filme entra na fila, e a home não', () => withStub(pageRoutes(), async (stub) => {
    // Só o PRIMEIRO post-sitemap está no mapa: os outros 2 falham e a rodada
    // vem PARCIAL (complete:false) — o motor não pode avançar o cursor por
    // cima do lastmod que ficou nos arquivos perdidos.
    const disc = await site().discover();
    const slugs = slugsOf(disc.urls);
    assert.equal(slugs.length, 37, 'as 2 páginas de temporada NÃO são enfileiradas');
    assert.ok(disc.urls.every((u) => u.kind === 'movie'), 'tudo que sai da fila é filme');
    assert.ok(!slugs.includes(''), 'a home "/" não vira URL de obra');
    assert.ok(disc.urls.every((u) => u.url.startsWith(`${SITE}/`)), 'toda URL descoberta é do site');
    // O 1º post do sitemap real é a home; o 1º que entra é o post de filme.
    assert.equal(disc.urls[0].url, MOVIE);
    assert.equal(disc.urls[0].lastmod, MOVIE_LASTMOD);
    // category-sitemap e post_tag-sitemap do índice NÃO são obra, e o índice
    // só pede os 3 post-sitemap, sequencial (crawl.search_isolation).
    assert.deepEqual(pathsOf(stub), ['/sitemap_index.xml', '/post-sitemap.xml', '/post-sitemap2.xml', '/post-sitemap3.xml']);
    // F3: a rodada fez 4 requisições de verdade (índice + 3 sitemaps).
    assert.equal(disc.requestCost, 4);
    assert.equal(disc.complete, false, '2 fontes falharam = descoberta parcial');
    assert.equal(disc.failures.length, 2);
    assert.ok(disc.failures.every((f) => /post-sitemap\d*\.xml/.test(f)), 'falha cita o loc de origem');
    assert.equal(disc.completeByKind?.movie, false, 'cursor de filme NÃO pode avançar');
    assert.equal(disc.completeByKind?.tv_show, true, 'tv_show sem fonte = completo (cursor parado)');
  }));

  test('modo amostra: as 39 obras entram com o tipo do slug (2 séries, 37 filmes)', () => withStub(pageRoutes(), async () => {
    const disc = await probeSite().discover();
    // A home NEM entra no `discover` com série ligada: a regra do caminho de
    // obra a recusa no `toWorkUrl`, então a amostra do acervo são as 39 obras.
    assert.equal(disc.urls.length, 39, 'a amostra vê o acervo inteiro de obras');
    assert.equal(disc.urls.filter((u) => u.kind === 'tv_show').length, 2);
    assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 37);
    assert.equal(disc.completeByKind?.tv_show, false, '2 sitemaps falharam = cursor de série também não anda');
  }));

  test('descoberta completa com todos os sitemaps presentes avança o cursor de filme', () => withStub(pageRoutes(allSitemaps), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.complete, true, 'nenhuma falha = completa');
    assert.equal(disc.failures.length, 0);
    assert.equal(disc.completeByKind?.movie, true);
    assert.equal(disc.urls.length, 37 * 3, '3 sitemaps no mapa = 111 filmes (dedupe é do store)');
    assert.equal(disc.requestCost, 4, 'o custo é por hop, não por sitemap listado');
    assert.equal(stub.calls.length, 4);
  }));

  test('índice de outro host e loc de fora NÃO são consultados (SSRF)', () => withStub(pageRoutes({
    // Hostile: o índice GANHA um sitemap para o loopback de metadado de nuvem,
    // e o sitemap de obra manda locs para esse host e para um domínio alheio.
    '/sitemap_index.xml': () => fixture('sitemap-index.xml').replace(
      '<sitemap>',
      '<sitemap><loc>http://169.254.169.254/post-sitemap.xml</loc><lastmod>2026-09-30T00:00:00+00:00</lastmod></sitemap>\n\t<sitemap>',
    ),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml').replace(
      '<url>',
      '<url><loc>http://169.254.169.254/como-viajar/</loc><lastmod>2026-09-30T00:00:00+00:00</lastmod></url>\n<url><loc>https://evil.example/x/</loc><lastmod>2026-09-30T00:00:00+00:00</lastmod></url>\n<url>',
    ),
  }), async (stub) => {
    const urls = (await site().discover()).urls.map((u) => u.url);
    assert.equal(urls.length, 37, 'as obras do site continuam entrando');
    assert.ok(!urls.some((u) => u.includes('169.254.169.254')), 'metadado de nuvem fora');
    assert.ok(!urls.some((u) => u.includes('evil.example')), 'host alheio fora');
    assert.ok(
      stub.calls.every((c) => new URL(c.url).host === 'torrentdosfilmes-v2.xyz'),
      'nenhum fetch para host de fora (o sitemap do loopback nunca foi pedido)',
    );
  }));

  test('índice ilegível no canônico cai no caminho Yoast (o 301 real do site)', () => withStub(pageRoutes({
    '/sitemap_index.xml': () => { throw new Error('500 injetado'); },
    '/sitemap.xml': () => fixture('sitemap-index.xml'),
  }), async (stub) => {
    const disc = await site().discover();
    assert.equal(disc.urls.length, 37, 'o caminho de reserva entregou as obras');
    assert.equal(pathsOf(stub)[0], '/sitemap_index.xml');
    assert.equal(pathsOf(stub)[1], '/sitemap.xml', 'tentou o nome Yoast depois do canônico');
    assert.equal(disc.requestCost, 5, 'o fallback entra na conta: 5 hops, não 4');
  }));

  test('índice ilegível nos DOIS caminhos é erro do site (o motor retenta)', () => withStub(
    { '/sitemap': () => { throw new Error('500 injetado'); } },
    async () => assert.rejects(() => site().discover(), /torrentdosfilmesv2: índice de sitemaps ilegível/),
  ));

  test('lastmod incremental é cortado POR KIND, com o `since` solto de fallback', () => withStub(pageRoutes(), async () => {
    // O recorte real vai de 01:26:15 a 01:29:06 (o ANO é o mesmo nos dois
    // extremos: o acervo antigo do site está em bloco). Cortar o cursor de
    // FILME no 1º post deixa os 35 filmes MAIS NOVOS que ele.
    const soFilme = await site().discover(MOVIE_LASTMOD, { sinceByKind: { movie: MOVIE_LASTMOD } });
    assert.equal(soFilme.urls.length, 35, 'o corte é EXCLUSIVO (lastmod ≤ cursor já foi processado)');
    assert.ok(
      soFilme.urls.every((u) => Date.parse(u.lastmod) > Date.parse(MOVIE_LASTMOD)),
      'tudo que sobra é estritamente mais novo que o cursor',
    );
    assert.ok(!soFilme.urls.some((u) => u.url === MOVIE), 'o próprio post do cursor não volta');
    // `sinceByKind` SEM a chave movie: o corte não pode virar "sem cursor"
    // (carga inteira de novo) — nem herdar o cursor de série.
    const semChave = await site().discover('2000-01-01T00:00:00+00:00', { sinceByKind: { tv_show: null } });
    assert.equal(semChave.urls.length, 37, 'ausente no mapa cai no since legado');
    // Na amostra o cursor de série é o DELE: com `tv_show: null` (sem cursor),
    // as 2 temporadas entram mesmo com o corte de filme apertado.
    const porKind = await probeSite().discover(MOVIE_LASTMOD, { sinceByKind: { movie: MOVIE_LASTMOD, tv_show: null } });
    assert.equal(porKind.urls.filter((u) => u.kind === 'tv_show').length, 2, 'série sem cursor = carga inteira do kind');
    assert.equal(porKind.urls.filter((u) => u.kind === 'movie').length, 35);
  }));

  test('séries ligadas por config continuam fora (o portão é do adaptador)', () => withStub(pageRoutes(), async () => {
    // `opts.series.enabled` NÃO abre a página de temporada: a decisão de série
    // continua desligada, então a lista não pode trazer trabalho que o
    // `fetchWork` recusaria (fila de erro não é "série ligada").
    const disc = await site().discover(null, { series: { enabled: true, maxCards: 10, maxButtons: 40 } });
    assert.equal(disc.urls.length, 37);
    assert.ok(disc.urls.every((u) => u.kind === 'movie'), 'nenhum post vira série por configs');
    assert.equal(disc.completeByKind?.tv_show, true, 'tv_show sem fonte = cursor parado');
  }));
});
