// Modo amostra de temporada do ComandoTorrents. A página real mistura episódio
// avulso e pack; sem `seriesProbe` o motor não a lê. A amostra devolve a
// contagem de botões e não afirma `groups`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import type { ComandotorrentsSeasonSample } from '../src/providers/crawl-sites/comandotorrents.js';
import {
  SERIES,
  pageRoutes,
  probeSite,
  site,
  withStub,
} from './helpers/crawl-comandotorrents-fixtures.js';

describe('crawl-sites/comandotorrents: modo amostra de temporada', () => {
  test('lê a temporada, conta os 12 botões e não grava groups', () => withStub(pageRoutes(), async () => {
    const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
    assert.equal(result.status, 'done');
    assert.equal(result.type, 'series');
    // O nome é o da SÉRIE (o TMDB não conhece "The Boys 4ª Temporada"): a
    // temporada é estrutura da release, a mesma régua do TorrentDosFilmes.
    assert.equal(result.title, 'The Boys');
    assert.equal(result.year, 2024);
    assert.equal(result.groups, undefined);
    assert.equal(result.releases?.length, 1, 'o dublê devolve o mesmo hash nos 12 botões');
    const sample = result as ComandotorrentsSeasonSample;
    assert.equal(sample.buttons, 12);
    assert.equal(sample.buttonsFollowed, 12);
    assert.equal(result.requestCost, 13);
  }));

  test('o teto de botões corta o que é seguido, não o que a página anunciou', () => withStub(pageRoutes(), async (stub) => {
    const result = await probeSite().fetchWork(SERIES, {
      kind: 'tv_show', series: { enabled: false, maxCards: 4, maxButtons: 3 },
    });
    const sample = result as ComandotorrentsSeasonSample;
    assert.equal(sample.buttons, 12);
    assert.equal(sample.buttonsFollowed, 3);
    assert.equal(result.requestCost, 4);
    assert.equal(stub.calls.length, 4);
    assert.equal(result.groups, undefined);
  }));

  test('series.enabled não abre a porta; a flag por chamada abre, e string não', () => withStub(pageRoutes(), async (stub) => {
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
  }));
});
