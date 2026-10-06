// Regras de marcação compartilhadas pelos adaptadores do raspador
// (`crawl-sites/shared.ts`) e a coerência de tipo do HDRTorrent nos dois
// sentidos. As regras eram cópias por site; aqui fica o contrato único.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isImdbWidgetReference, stripHtmlComments } from '../src/providers/crawl-sites/shared.js';
import { countListingCards, kindConflictOf, parseImdbId } from '../src/providers/crawl-sites/hdrtorrents-discovery.js';
import { parseImdbId as apacheImdb } from '../src/providers/crawl-sites/apachetorrent-discovery.js';
import { hdrFixture } from './helpers/crawl-hdrtorrents-fixtures.js';

const CARD = '<a class="media-card-link" href="/x-torrent-download/">x</a>';

describe('stripHtmlComments', () => {
  test('tira comentário fechado e mantém o resto', () => {
    assert.equal(stripHtmlComments('a<!-- <h1>b</h1> -->c').replace(/\s+/g, ''), 'ac');
  });

  test('`<!--` sem fecho engole até o fim, como o navegador', () => {
    assert.equal(stripHtmlComments('a<!-- b c').trim(), 'a');
  });

  test('entrada vazia vira string vazia', () => {
    assert.equal(stripHtmlComments(null), '');
    assert.equal(stripHtmlComments(undefined), '');
  });
});

describe('isImdbWidgetReference', () => {
  test('widget no path e na query do plugin', () => {
    assert.equal(isImdbWidgetReference('/ref_/'), true);
    assert.equal(isImdbWidgetReference('/list'), true);
    assert.equal(isImdbWidgetReference('/?ref_=tt_plg_rec'), true);
    assert.equal(isImdbWidgetReference('/?foo=1&amp;ref_=tt_plg'), true);
  });

  test('link da própria obra não é widget', () => {
    assert.equal(isImdbWidgetReference(''), false);
    assert.equal(isImdbWidgetReference('/'), false);
    assert.equal(isImdbWidgetReference('/?ref_=nv_sr_srsg_0'), false);
  });

  test('HDR e Apache usam a mesma régua de widget', () => {
    const html = '<a href="https://www.imdb.com/title/tt1234567/">obra</a>'
      + '<a href="https://www.imdb.com/title/tt7654321/?ref_=tt_plg_rec">widget</a>';
    assert.equal(parseImdbId(html), 'tt1234567');
    assert.equal(apacheImdb(html), 'tt1234567');
  });
});

describe('HDRTorrent: contagem de cards com comentário órfão', () => {
  test('`<!--` sem fecho não encolhe a contagem (não forja fim de acervo)', () => {
    assert.equal(countListingCards(`${CARD}<!-- sem fecho ${CARD}${CARD}`), 3);
  });

  test('card dentro de comentário fechado não conta', () => {
    assert.equal(countListingCards(`${CARD}<!-- ${CARD} -->${CARD}`), 2);
  });
});

describe('HDRTorrent: coerência de tipo nos dois sentidos', () => {
  const series = hdrFixture('post-serie-agregada');
  const movie = series.replace('itemtype="https://schema.org/TVSeries"', 'itemtype="https://schema.org/Movie"');

  test('pedida como série e declarada série: coerente', () => {
    assert.equal(kindConflictOf(series, true), null);
  });

  test('pedida como filme e declarada série: recusa', () => {
    assert.match(String(kindConflictOf(series, false)), /^serie_com_kind_movie/);
  });

  test('pedida como série e declarada filme: recusa', () => {
    assert.match(String(kindConflictOf(movie, true)), /^filme_com_kind_tv_show/);
  });

  test('sem `<main itemtype>` não há o que contradizer', () => {
    assert.equal(kindConflictOf('<main class="x"><h1>Obra</h1></main>', false), null);
    assert.equal(kindConflictOf('<main class="x"><h1>Obra</h1></main>', true), null);
  });

  test('schema comentado não decide o tipo', () => {
    const html = '<!-- <main itemtype="https://schema.org/TVSeries"> --><main itemtype="https://schema.org/Movie">';
    assert.equal(kindConflictOf(html, false), null);
  });
});
