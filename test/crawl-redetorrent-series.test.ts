// Modo amostra de série do RedeTorrent. O post de série deste site agrega MAIS
// DE UMA TEMPORADA (medido: "Fallout 1ª 2ª Temporada (2025)", ficha
// "Temporadas: 2"), então sem `seriesProbe` o motor não a lê: gravar o post
// inteiro como se fosse uma temporada seria obra que não existe no catálogo.
// A amostra devolve a contagem de linhas e NÃO afirma `groups` — localizar a
// locação de cada linha é justamente o que ela ainda não provou.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import type { RedetorrentSeasonSample } from '../src/providers/crawl-sites/redetorrent.js';
import { SERIES, pageRoutes, probeSite, site, withStub } from './helpers/crawl-redetorrent-fixtures.js';

const SERIES_SITEMAP = 'https://www.redetorrent.xyz/series/fallout/';

describe('crawl-sites/redetorrent: modo amostra de série', () => {
  test('discover em modo amostra lê o tvshows-sitemap e emite a série com o tipo do caminho', () => withStub(
    pageRoutes(), async (stub) => {
      const disc = await probeSite().discover();
      const shows = disc.urls.filter((u) => u.kind === 'tv_show');
      assert.equal(SERIES, SERIES_SITEMAP, 'a página lida é a primeira linha do tvshows-sitemap');
      assert.deepEqual(shows.map((u) => u.url), [
        SERIES,
        'https://www.redetorrent.xyz/series/casa-do-dragao/',
        'https://www.redetorrent.xyz/series/breaking-bad/',
      ]);
      // 5 do `movies-sitemap` + a linha `/filmes/coringa/` que o
      // `tvshows-sitemap` traz: quem classifica é o CAMINHO, não o nome do
      // arquivo (e o upsert do store é idempotente, então a repetição some).
      assert.equal(disc.urls.filter((u) => u.kind === 'movie').length, 6);
      // índice + 7 movies + 1 tvshows: o arquivo de série SÓ é lido na amostra.
      assert.equal(disc.requestCost, 9);
      assert.deepEqual(disc.completeByKind, { movie: true, tv_show: true });
      // A linha com data ilegível entrou com lastmod vazio, nunca com data chute.
      assert.equal(shows.find((u) => u.url.endsWith('breaking-bad/'))?.lastmod, '');
      assert.ok(stub.calls.some((c) => c.url.includes('tvshows-sitemap.xml')));
    },
  ));

  test('lê a página de série, conta as linhas e não grava groups', () => withStub(
    pageRoutes(), async (stub) => {
      const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'series');
      assert.equal(result.groups, undefined, 'a locação de cada linha ainda não foi provada');
      assert.ok((result.releases?.length ?? 0) > 0);
      const sample = result as RedetorrentSeasonSample;
      // O magnet é direto no HTML: sem salto de protetor, seguir uma linha não
      // gasta rede — por isso o teto de botões dos outros sites não se aplica.
      assert.equal(sample.buttons, result.releases?.length);
      assert.equal(sample.buttonsFollowed, sample.buttons);
      assert.equal(result.requestCost, 1, 'a página inteira numa requisição');
      assert.equal(stub.calls.length, 1);
      // Evidência que sustenta o portão: o botão NÃO é o que falta. A coluna de
      // qualidade do post traz a temporada (o `releaseTitle` do profile injeta
      // `S01`/`S02`), então o que a amostra ainda não provou é a SEMÂNTICA de
      // cada linha — e é por isso que `groups` fica de fora.
      const seasons = (result.releases ?? []).map((r) => /\bS\d{2}\b/.exec(r.title ?? '')?.[0] ?? '');
      assert.deepEqual(seasons, ['S01', 'S02']);
    },
  ));

  test('o nome vem da régua compartilhada, e o ordinal MENOR sobra (só na amostra)', () => withStub(
    pageRoutes(), async () => {
      const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
      // "Fallout 1ª 2ª Temporada (2025)": a régua tira o ordinal MENOR (a
      // regex casa da 2ª para trás), então sobra "Fallout 1ª". É resíduo
      // COSMÉTICO e só da amostra: a série está fora do motor, e o TMDB não
      // resolve o título de post de temporada de qualquer forma. Trocar a régua
      // compartilhada exigiria remedir ComandoTorrents e TorrentDosFilmes, que
      // já foram medidos com ela.
      assert.equal(result.year, 2025);
      assert.match(result.title ?? '', /^Fallout/);
      // A amostra é um registro reduzido (só o denominador da sonda), então nem
      // carrega `originalTitle` — que, medido, o post de série também não
      // publica. A identificação da amostra não usa esse campo.
      assert.equal('originalTitle' in result, false);
    },
  ));

  test('series.enabled não abre a porta; a flag por chamada abre, e string não', () => withStub(
    pageRoutes(), async (stub) => {
      const closed = await site().fetchWork(SERIES, {
        kind: 'tv_show', series: { enabled: true, maxCards: 4, maxButtons: 40 },
      });
      assert.equal(closed.status, 'error');
      assert.equal(stub.calls.length, 0);

      const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
      const opened = await site().fetchWork(SERIES, opts);
      assert.equal(opened.status, 'done');
      assert.equal(opened.type, 'series');

      const falso = await site().fetchWork(SERIES, { kind: 'tv_show', seriesProbe: 'true' } as unknown as CrawlPageOptions);
      assert.equal(falso.status, 'error');
    },
  ));
});
