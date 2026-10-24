// SÉRIE DO BLUDV dentro do motor. O post deste site declara UMA temporada —
// `<h1>` e `dn=` concordam ("Smallville 10ª Temporada (2010)" com `dn=Smallville
// 10 Temporada (2010) BluRay 720p Dublado D4V1`) — então a locação sai de
// `seasonPageGroups`, a MESMA régua do Vaca e dos outros três sites, e não de
// `seriesRowGroups` (que é do post que AGREGA temporadas, como o RedeTorrent).
//
// Medido em 2026-09-29: 3.236 das 17.860 páginas do acervo (18,1%) têm
// "temporada" no slug, e o `dn=` do magnet declara a locação em 4 de 13 botões
// amostrados — o resto vem da temporada do PRÓPRIO post, que é o que o
// `seasonPageGroups` usa como base.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { BludvSeasonSample } from '../src/providers/crawl-sites/bludv.js';
import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import { kindFromSlug, postDeclaresSeries } from '../src/providers/crawl-sites/bludv-discovery.js';
import { MOVIE, SERIES, fixture, pageRoutes, probeSite, site, withStub } from './helpers/crawl-bludv-fixtures.js';

/** Opção de séries do painel ligada (o que o motor manda em produção). */
const LIGADO = { kind: 'tv_show', series: { enabled: true, maxCards: 4, maxButtons: 40 } } as const;

/**
 * Página de série SINTÉTICA no layout real: o título do servidor e a âncora com
 * o magnet DIRETO, que é o que o post do BLUDV publica. `dn` é o nome real do
 * torrent (é dele que a temporada sai).
 */
function seriePage(h1: string, dn: string, hashChar = 'a'): string {
  return `<h1>${h1}</h1><p><strong><em>SERVIDORES PARA DOWNLOAD 720p</em></strong></p>`
    + `<a href="magnet:?xt=urn:btih:${hashChar.repeat(40)}&amp;dn=${encodeURIComponent(dn)}&amp;xl=2000000000">`
    + '<img alt="Magnet Link" title="Magnet Link" width="158" height="33"></a>';
}

const locs = (result: { groups?: { season: number | null; episode: number | null }[] }) =>
  (result.groups ?? []).map((g) => [g.season, g.episode]);

describe('crawl-sites/bludv: série no motor', () => {
  test('o post real de temporada rende a locação que o `<h1>` declara', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(SERIES, LIGADO) as BludvSeasonSample;
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'series');
      assert.equal(result.title, 'O Exterminador do Futuro: Crônicas de Sarah Connor');
      assert.equal(result.year, 2009);
      assert.equal(result.season, 2, 'a 2ª temporada do `<h1>` e do slug');
      assert.equal(result.originalTitle, 'Terminator: The Sarah Connor Chronicles');
      // O denominador da sonda: 1 botão anunciado, 1 lido (magnet direto, sem
      // salto de protetor a seguir).
      assert.equal(result.buttons, 1);
      assert.equal(result.buttonsFollowed, 1);
      assert.equal(result.requestCost, 1, 'a página custa 1 requisição, como o filme');
      assert.equal(stub.calls.length, 1);
      assert.deepEqual(locs(result), [[2, null]], 'a release fica na temporada 2, não na raiz');
      const release = result.releases?.[0];
      assert.equal(release?.indexer, 'bludv-cardigann');
      assert.equal(release?.isBr, true);
      assert.match(release?.magnet ?? '', /^magnet:\?xt=urn:btih:aa465bf193bb3d8065929cad328ae55f2d5a7248/i);
    },
  ));

  test('a temporada vem do `dn=` do magnet quando o `<h1>` não declara UMA', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage(
        'O Exterminador do Futuro Torrent – Blu-ray Rip 720p Dublado (2009)',
        'O Exterminador do Futuro - Crônicas de Sarah Connor - 7ª Temporada (2013) Dublado 720p',
        'b',
      ),
    }),
    async () => {
      // Medido no site: 4 dos 13 botões amostrados declaram a temporada no `dn=`,
      // e o `<h1>` do post sempre concorda. Aqui o `<h1>` é genérico de propósito:
      // é o `dn=` que tem de dizer a temporada.
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.status, 'done');
      assert.equal(result.title, 'O Exterminador do Futuro');
      assert.deepEqual(locs(result), [[7, null]]);
    },
  ));

  test('`dn=` com a MESMA temporada do post não abre grupo paralelo', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage(
        'Smallville 10ª Temporada Torrent – Blu-ray Rip 720p Dublado (2010)',
        'Smallville 10 Temporada (2010) BluRay 720p Dublado D4V1',
        'c',
      ),
    }),
    async () => {
      // Sem o veto, o `dn` abriria um grupo e o post abriria outro, e a mesma
      // temporada apareceria duplicada na listagem.
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.season, 10);
      assert.deepEqual(locs(result), [[10, null]]);
    },
  ));

  test('o modo amostra (`seriesProbe`) é a única passagem sem a opção do painel', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' }) as BludvSeasonSample;
      assert.equal(result.status, 'done');
      assert.equal(result.buttons, 1);
      assert.equal(stub.calls.length, 1);
    },
  ));

  test('séries DESLIGADAS: a página de temporada é erro explicado, com ZERO rede', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(SERIES, { kind: 'tv_show' });
      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /séries desligadas no painel/);
      assert.equal(stub.calls.length, 0, 'a recusa é do portão, não do site');
    },
  ));

  test('a flag por chamada também abre a passagem (quem só tem `CrawlSite` em mãos)', () => withStub(
    pageRoutes(), async (stub) => {
      // `seriesProbe` NÃO é campo do contrato compartilhado (é o modo amostra da
      // Fase 8, por chamada): o cast é o mesmo dos outros sites.
      const result = await site().fetchWork(SERIES, { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions);
      assert.equal(result.status, 'done');
      assert.equal(stub.calls.length, 1);
    },
  ));

  test('o teto de botões da AMOSTRA corta a página, e o denominador do corte fica visível', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage('Serie Com Muitos Botões (2020)', 'Serie.S01 (2020)', 'd')
        + seriePage('Serie Com Muitos Botões (2020)', 'Serie.S01 (2020)', 'e')
        + seriePage('Serie Com Muitos Botões (2020)', 'Serie.S01 (2020)', 'f'),
    }),
    async () => {
      const result = await site().fetchWork(SERIES, {
        kind: 'tv_show', series: { enabled: true, maxCards: 4, maxButtons: 2 },
      }) as BludvSeasonSample;
      assert.equal(result.status, 'done');
      assert.equal(result.buttons, 3, 'o denominador é o que a página anunciava');
      assert.equal(result.buttonsFollowed, 2, 'o que o teto deixou passar');
      assert.equal(result.releases?.length, 2);
    },
  ));

  test('discover com séries ligadas emite o acervo inteiro de temporada do arquivo real', () => withStub(
    pageRoutes(), async () => {
      const disc = await site().discover(null, { series: { enabled: true, maxCards: 4, maxButtons: 4 } });
      const shows = disc.urls.filter((u) => u.kind === 'tv_show');
      // 126 no primeiro `post-sitemap` real (medido: 3.236 nos 18 arquivos)
      // mais 4 do recorte que o mapa de rotas também serve.
      assert.equal(shows.length, 130);
      assert.ok(shows.some((u) => u.url === SERIES));
      assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 891);
      assert.equal(disc.requestCost, 19, 'o arquivo é misto: ler é o mesmo com ou sem séries');
    },
  ));
});

describe('crawl-sites/bludv: série que NÃO diz temporada no slug', () => {
  // Medido em 2026-09-29 (85 páginas): a categoria do PRÓPRIO post separou as 5
  // séries de verdade dos 80 filmes, e o "Série" no nome de filme vem com a
  // categoria de filmes ("Assassino em Série", "A Série Divergente").
  const cat = (kind: string, slug = '') => `<a href="https://bludvfilmes1.xyz/${kind}/${slug}" rel="category tag">x</a>`;

  test('minissérie e série completa no slug são série; "serie" solto não', () => {
    assert.equal(kindFromSlug('/redencao-minisserie-completa-torrent-web-dl-1080p-nacional-download-2019/'), 'tv_show');
    assert.equal(kindFromSlug('/mr-bean-serie-completa-torrent-web-dl-720p-dublado/'), 'tv_show');
    assert.equal(kindFromSlug('/assassino-em-serie-torrent-web-dl-720p-1080p-dual-audio-download/'), 'movie');
    assert.equal(kindFromSlug('/a-serie-divergente-insurgente-torrent-blu-ray-rip-720p-dual-audio-2015/'), 'movie');
  });

  test('a categoria do post decide, e só sem contradição', () => {
    assert.equal(postDeclaresSeries(cat('series', 'boneca-russa/') + cat('series')), true);
    assert.equal(postDeclaresSeries(cat('filmes')), false);
    assert.equal(postDeclaresSeries(cat('series', 'x/') + cat('filmes')), false, 'as duas: não afirma nada');
    assert.equal(postDeclaresSeries('<a href="https://bludvfilmes1.xyz/series/">Séries</a>'), false, 'menu não é categoria do post');
  });

  test('post de série pedido como filme é RECUSADO, nunca identificado como filme', () => withStub(
    pageRoutes({
      // Recorte real: "Boneca Russa 1ª Temporada" num slug sem "temporada".
      [MOVIE]: () => seriePage('Boneca Russa 1ª Temporada Torrent – WEB-DL 720p Dual Áudio', 'Russian.Doll.S01.720p')
        + cat('series', 'boneca-russa/') + cat('series'),
    }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /serie_com_kind_movie/);
      assert.equal(result.requestCost, 1, 'a página foi lida: o custo é real');
    },
  ));
});
