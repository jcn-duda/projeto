// Fim FALSO de catálogo na listagem paginada (2026-10-01): o Apache "terminou"
// a carga na página 211 de 2123. O card "Além da Imaginação - 2ª Temporada
// (Clássica de 1960)" era pulado ("Clássica" lido como tipo do card), a página
// saía com 19 aceitos, e 19 < 20 é a regra de fim — o cursor virou incremental
// e ~38 mil posts nunca seriam lidos.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/utils/crawl-store.js';
import { startListingCursor, saveListingCursor, listingCursorKey } from '../src/providers/crawl-cursor.js';
import { loadListingCursorForSeries, listingSeriesKey } from '../src/providers/crawl-listing-series.js';
import { walkListing, type ListingPageRead } from '../src/providers/crawl-sites/listing-discover.js';
import { parseListingCards, countListingCards } from '../src/providers/crawl-sites/apachetorrent-discovery.js';

const BASE = 'https://apachetorrents.com';
const card = (slug: string, title: string) =>
  `<div class="capa-item"><a href="${BASE}/${slug}-baixar-torrent/" title="${title}"><img alt=""></a></div>`;

test('card com "(Clássica de 1960)" no nome entra; tipo fora do acervo continua fora', () => {
  const html = [
    card('arquivo-alem-da-imaginacao-2a-temporada-classica-de-1960', 'Além da Imaginação - 2ª Temporada (Clássica de 1960) Torrent Dublada'),
    card('trilha-sonora-x', 'Trilha Sonora X (Música de 2020)'),
    card('coringa', 'Coringa (Filme de 2019)'),
  ].join('');
  const cards = parseListingCards(html, `${BASE}/`);
  assert.deepEqual(cards.map((c) => c.url.split('/')[3]), [
    'arquivo-alem-da-imaginacao-2a-temporada-classica-de-1960-baixar-torrent',
    'coringa-baixar-torrent',
  ]);
  assert.equal(cards[0].kind, 'tv_show', 'sem tipo válido, o slug de temporada decide');
  assert.equal(countListingCards(html), 3, 'os cards BRUTOS contam o pulado');
});

const url = (n: number) => `${BASE}/p${n}-baixar-torrent/`;
const posts = (count: number, offset: number) =>
  Array.from({ length: count }, (_, i) => ({ url: url(offset + i), kind: 'movie' as const }));

test('página com card pulado (19 aceitos de 20 brutos) não é fim de catálogo', async () => {
  const pages: ListingPageRead[] = [
    { posts: posts(19, 0), cardCount: 20 },
    { posts: posts(20, 100), cardCount: 20 },
    { posts: posts(15, 200), cardCount: 15 },
  ];
  const result = await walkListing({
    readPage: async (p) => pages[p - 1],
    expectedPerPage: 20,
    budget: { maxPagesPerRound: 5 },
    seriesEnabled: true,
    defaultKind: 'movie',
    cursor: startListingCursor('apachetorrent-cardigann', 'movie', '/pagina/', 1000),
    now: 2000,
  });
  assert.equal(result.pagesConsumed, 3, 'anda até a calcanhar de verdade');
  assert.equal(result.endOfListing, true);
  assert.equal(result.urls.length, 54);
});

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
});
after(() => store.resetForTests());

const SITE = 'apachetorrent-cardigann';
const LISTING = '/pagina/';

test('cursor da regra antiga que já virou incremental é descartado; o que está na carga segue', () => {
  const base = startListingCursor(SITE, 'movie', LISTING, 1000);
  saveListingCursor({ ...base, page: 1, sweep: true, anchor: '/2die4' });
  store.engine().setState(SITE, listingSeriesKey('movie', LISTING), '1');
  assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, true), null, 'fim falso: a carga recomeça');
  assert.ok(!store.engine().getState(SITE, listingCursorKey('movie', LISTING)), 'cursor apagado');

  saveListingCursor({ ...base, page: 543 });
  store.engine().setState(SITE, listingSeriesKey('movie', LISTING), '1');
  assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, true)?.page, 543, 'carga em andamento continua');
});
