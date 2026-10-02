// SÉRIE do RedeTorrent dentro do motor. O post de série deste site AGREGA mais
// de uma temporada no mesmo post (medido: "Fallout 1ª 2ª Temporada (2025)",
// ficha "Temporadas: 2"), então a página entra pelo mesmo portão dos outros três
// sites (opção de séries do painel ou modo amostra da sonda) e a locação de cada
// LINHA é o que decide a chave do acervo — nunca o `<h1>`, que lista ordinais.
//
// Medido em 2026-09-29 em 12 páginas reais do `tvshows-sitemap.xml` (79 linhas):
// o `dn=` do magnet declara a locação em 77, a coluna `S0N` da linha em 1,
// nenhuma evidência em 1, contradição entre as duas em 0.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import type { RedetorrentSeasonSample } from '../src/providers/crawl-sites/redetorrent.js';
import { SERIES, SITE, pageRoutes, postFixture, probeSite, site, withStub } from './helpers/crawl-redetorrent-fixtures.js';

/** Opção de séries do painel ligada (o que o motor manda em produção). */
const LIGADO = { kind: 'tv_show', series: { enabled: true, maxCards: 4, maxButtons: 40 } } as const;

/**
 * Página de série SINTÉTICA no layout real: uma tabela `tbl-mv-list`, uma linha
 * `tr-mv-list` por release, a coluna `td-mv-qua` com o `S0N` e o magnet direto
 * no `<td>` de download. `dn` é o nome real do torrent.
 */
function seriePage(h1: string, rows: Array<{ qua: string; dn: string; hash: string }>): string {
  return `<h1 class="entry-title titulo">${h1}</h1><table class="tbl-mv-list"><tbody>${rows.map((r) =>
    '<tr class="tr-mv-list">'
    + `<td class="td-mv-qua">${r.qua}</td><td class="td-mv-res">1080p</td><td class="td-mv-tam">2.00 GB</td>`
    + `<td class="td-mv-idi">ptbr</td><td class="td-mv-dow">`
    + `<a href="magnet:?xt=urn:btih:${r.hash}&amp;dn=${encodeURIComponent(r.dn)}&amp;xl=2000000000">magnet</a>`
    + '</td></tr>').join('')}</tbody></table>`;
}

const row = (hashChar: string, qua: string, dn: string) => ({ qua, dn, hash: hashChar.repeat(40) });
/** Hash distinto por linha — só em caracteres HEX, que é o que o
 *  `extractMagnetHref` do profile valida no `btih`. */
const HASHES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd'];
/** Locações dos grupos, na ordem (temporada, episódio). */
const locs = (result: { groups?: { season: number | null; episode: number | null }[] }) =>
  (result.groups ?? []).map((g) => [g.season, g.episode]);

describe('crawl-sites/redetorrent: série no motor', () => {
  test('discover com séries ligadas lê o tvshows-sitemap e emite a série com o tipo do caminho', () => withStub(
    pageRoutes(), async (stub) => {
      const disc = await site().discover(null, { series: { enabled: true, maxCards: 4, maxButtons: 4 } });
      const shows = disc.urls.filter((u) => u.kind === 'tv_show');
      assert.deepEqual(shows.map((u) => u.url), [
        SERIES,
        `${SITE}/series/casa-do-dragao/`,
        `${SITE}/series/breaking-bad/`,
      ]);
      // 5 do `movies-sitemap` + os 6 arquivos sintéticos (2..7) + a linha
      // `/filmes/coringa/` que o `tvshows-sitemap` traz: quem classifica é o
      // CAMINHO, não o nome do arquivo.
      assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 12);
      // índice + 7 movies + 1 tvshows: o arquivo de série só entra com séries ligadas.
      assert.equal(disc.requestCost, 9);
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
      assert.equal(shows.find((u) => u.url.endsWith('breaking-bad/'))?.lastmod, '');
      assert.ok(stub.calls.some((c) => c.url.includes('tvshows-sitemap.xml')));
    },
  ));

  test('o post real do Fallout rende S1 (pack) e S2, e o season é a MAIOR declarada', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'series');
      // `<h1>` = "Fallout 1ª 2ª Temporada (2025)": a lista de ordinais sai inteira.
      assert.equal(result.title, 'Fallout');
      assert.equal(result.year, 2025);
      // A MAIOR temporada das linhas abre a janela `seriesStartedBy` da
      // identificação (o ano da página é o da temporada, não o da estreia).
      assert.equal(result.season, 2);
      assert.deepEqual(locs(result), [[1, null], [2, null]]);
      // O `dn=` do magnet é o que decide: `S01.COMPLETE` e `S02` (sem `E`).
      const sample = result as RedetorrentSeasonSample;
      assert.equal(sample.buttons, result.releases?.length);
      assert.equal(sample.buttonsFollowed, sample.buttons);
      assert.equal(result.requestCost, 1, 'a página inteira numa requisição');
      assert.equal(stub.calls.length, 1);
      // A ficha deste post não publica "Título Original": `null` é o estado
      // honesto, e a identificação segue só com o `<h1>`.
      assert.equal(result.originalTitle, null);
    },
  ));

  test('pack da S1 e episódios da S2 na MESMA página saem em S1 e S2, não na raiz', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage('Superman &amp; Lois 1ª e 2ª Temporada (2021)', [
        row(HASHES[0], 'S01', 'Superman.and.Lois.S01.COMPLETE.1080p.WEB-DL.DUAL.2.0'),
        ...Array.from({ length: 8 }, (_, i) => row(
          HASHES[i + 1], 'S02', `Superman.and.Lois.S02E0${i + 1}.1080p.WEB-DL.DUAL.2.0`,
        )),
      ]),
    }),
    async () => {
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.status, 'done');
      assert.equal(result.title, 'Superman & Lois', 'o "&" é parte do nome da obra');
      assert.deepEqual(locs(result), [
        [1, null], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7], [2, 8],
      ]);
      // A prova de que a raiz NÃO foi inventada: `releaseWorkTargets` leria a
      // lista de ordinais que o profile copiou do `<h1>` para o título da
      // release e empurraria as duas linhas para a raiz também.
      assert.ok(!locs(result).some(([s]) => s == null), 'nenhuma linha foi para a raiz');
      assert.equal(result.season, 2);
      // Cada grupo é uma locação, e a soma das releases dos grupos é a página.
      const total = (result.groups ?? []).reduce((n, g) => n + g.releases.length, 0);
      assert.equal(total, result.releases?.length);
    },
  ));

  test('linha sem nenhuma evidência é DESCARTADA, nunca mandada para a raiz', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage('Community (2009) 1ª 2ª 3ª 4ª 5ª 6ª Temporada', [
        row(HASHES[0], 'S01', 'Community.S01.COMPLETE.1080p.WEB-DL'),
        // Sem `dn` com temporada E sem `S0N`: nada declara a locação.
        row(HASHES[1], 'WEB-DL', ''),
        row(HASHES[2], 'S03', 'Community.S03E02.1080p.WEB-DL'),
      ]),
    }),
    async () => {
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.status, 'done');
      assert.equal(result.title, 'Community', 'a lista de seis ordinais sai inteira');
      assert.equal(result.year, 2009, 'ano de estreia, que a janela de N≥2 absorve');
      // A linha do meio some; a terceira fica em S3 pelo `dn` (que quando
      // declara vence a coluna, e aqui os dois concordam).
      assert.deepEqual(locs(result), [[1, null], [3, 2]]);
      assert.equal((result.groups ?? []).reduce((n, g) => n + g.releases.length, 0), 2);
      assert.equal(result.season, 3);
    },
  ));

  test('a coluna `S0N` é a reserva quando o `dn` é silencioso (1 das 79 linhas medidas)', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage('Grown-ish (2020) 3ª Temporada', [
        row(HASHES[0], 'S02', ''),
        row(HASHES[1], 'S03', 'Grown.Ish.S03.720p.WEB-DL'),
      ]),
    }),
    async () => {
      const result = await site().fetchWork(SERIES, LIGADO);
      // A primeira só tem a coluna; a segunda tem as duas, que concordam.
      assert.deepEqual(locs(result), [[2, null], [3, null]]);
      assert.equal(result.season, 3);
    },
  ));

  test('`dn` contradizendo a coluna `S0N`: o `dn` vence (conteúdo acima de página)', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage('The Sinner 1ª, 2ª e 3ª Temporada (2017)', [
        row(HASHES[0], 'S01', 'The.Sinner.S03E05.1080p.WEB-DL'),
      ]),
    }),
    async () => {
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.title, 'The Sinner');
      assert.deepEqual(locs(result), [[3, 5]]);
    },
  ));

  test('página cujas linhas não declaram locação nenhuma é no-torrent (sem chute para a raiz)', () => withStub(
    pageRoutes({
      [SERIES]: () => seriePage('Série Sem Evidência (2024)', [
        row(HASHES[0], 'WEB-DL', 'Nao.Tem.Temporada.1080p'),
      ]),
    }),
    async () => {
      const result = await site().fetchWork(SERIES, LIGADO);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.requestCost, 1, 'a página foi lida; o custo é o real');
    },
  ));

  test('página de série pedida como filme continua recusada antes da rede', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await site().fetchWork(SERIES, { kind: 'movie' });
      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /serie_com_kind_movie/);
      assert.equal(stub.calls.length, 0);
    },
  ));

  test('o modo amostra da sonda abre o mesmo portão, e a flag por chamada também', () => withStub(
    pageRoutes(), async () => {
      const probe = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
      assert.equal(probe.status, 'done');
      assert.equal(probe.type, 'series');
      assert.deepEqual(locs(probe), [[1, null], [2, null]]);
      const sample = probe as RedetorrentSeasonSample;
      assert.equal(sample.buttons, probe.releases?.length, 'o denominador da sonda');

      const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
      const porChamada = await site().fetchWork(SERIES, opts);
      assert.equal(porChamada.status, 'done');
      assert.deepEqual(locs(porChamada), [[1, null], [2, null]]);
      // String não é flag: `=== true` é o portão, como nos outros sites.
      const falso = await site().fetchWork(SERIES, { kind: 'tv_show', seriesProbe: 'true' } as unknown as CrawlPageOptions);
      assert.equal(falso.status, 'error');
    },
  ));

  test('o nome vem da régua compartilhada e o `<h1>` cru segue sendo o `releaseTitle`', () => withStub(
    pageRoutes(), async () => {
      const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
      // `workTitleYear` devolve o CRU junto do limpo, e o profile limpa o CRU —
      // é o `title=` do card vivo, byte a byte.
      assert.equal(result.title, 'Fallout');
      assert.ok(result.releases?.every((r) => (r.title ?? '').startsWith('Fallout 1ª 2ª Temporada')));
      // Evidência que sustenta o portão: a coluna de qualidade do post traz a
      // temporada e o `releaseTitle` do profile a injeta no título da release.
      const seasons = (result.releases ?? []).map((r) => /\bS\d{2}\b/.exec(r.title ?? '')?.[0] ?? '');
      assert.deepEqual(seasons, ['S01', 'S02']);
      assert.ok(postFixture('serie-fallout.html').includes('<strong>Temporadas:</strong> 2'));
    },
  ));
});
