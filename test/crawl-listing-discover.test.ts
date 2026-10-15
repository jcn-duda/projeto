// Núcleo de descoberta por LISTAGEM (`listing-discover.ts`), comum aos sites
// BR sem sitemap.
//
// O núcleo não conhece HTML de ninguém: quem extrai as URLs é o `readPage`
// injetado, e `expectedPerPage` é o tamanho CHEIO medido no site. Aqui são
// testadas as regras de paginação, de fim e de corte — inclusive a trava que o
// dado medido impôs: a contagem de URLs (e não a data), que separa "cheguei ao
// fim" de "o site me devolveu a última página de novo".
//
// A medição que fixa o desenho (HDRTorrent, 2026-09-29, bisseção):
// `/pagina/1..2122` reais com 20 cards, `/pagina/2123` a última com 15, e
// `/pagina/2124..99999` devolvendo SEMPRE a 2123.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/utils/crawl-store.js';
import { startListingCursor, loadListingCursor } from '../src/providers/crawl-cursor.js';
import { walkListing, type ListingPageRead } from '../src/providers/crawl-sites/listing-discover.js';
import { hdrFixture } from './helpers/crawl-hdrtorrents-fixtures.js';
import { APACHE_BASE, apacheFixture, apacheListingUrls, withSite as withApacheSite } from './helpers/crawl-apachetorrent-fixtures.js';

const FULL = 20;
const SITE = 'hdrtorrent-cardigann';
/** Raiz da listagem: `/pagina/` (página 1 responde em `/`). Ver `LISTING_PATH`. */
const LISTING = '/pagina/';
const url = (n: number) => `https://hdrtorrents.net/pagina/${n}/`;

/** Página de listagem montada no formato que o núcleo lê. */
function page(count: number, offset = 0, kind: 'movie' | 'tv_show' | null = 'movie'): ListingPageRead {
  return { posts: Array.from({ length: count }, (_, i) => ({ url: url(offset + i), kind })) };
}

/** Adaptador de `walkListing` sobre uma fila de páginas prontas. */
function reader(pages: ListingPageRead[], calls?: number[]) {
  return async (p: number): Promise<ListingPageRead> => {
    calls?.push(p);
    const found = pages[p - 1];
    if (!found) throw new Error(`http_404:pagina-${p}`);
    return found;
  };
}

function run(
  readPage: (p: number) => Promise<ListingPageRead>,
  opts: { seriesEnabled?: boolean; defaultKind?: 'movie' | 'tv_show'; startPage?: number } = {},
) {
  return walkListing({
    readPage,
    expectedPerPage: FULL,
    budget: { maxPagesPerRound: 3 },
    seriesEnabled: opts.seriesEnabled ?? false,
    defaultKind: opts.defaultKind ?? 'movie',
    cursor: startListingCursor(SITE, opts.defaultKind ?? 'movie', LISTING, 1000),
    now: 2000,
  }).then((r) => ({ ...r, startPage: opts.startPage ?? 1 }));
}

describe('listing-discover: paginação', () => {
  test('lê a página 1 e entrega as URLs na ordem do site', async () => {
    const result = await run(reader([page(20, 1)]));
    assert.equal(result.pagesConsumed, 1);
    assert.equal(result.urls.length, 20);
    assert.equal(result.urls[0].url, url(1));
    assert.equal(result.urls[19].url, url(20));
  });

  test('página 1 volta antes da 2, e cada página é lida UMA vez', async () => {
    const calls: number[] = [];
    // A terceira página não existe no dublê (404): a chamada é feita e vira
    // `failures` — o que prova que o núcleo avança em ordem e não relê a 1.
    const result = await run(reader([page(20, 1), page(20, 21)], calls));
    assert.deepEqual(calls, [1, 2, 3]);
    assert.match(result.failures.join(), /listing-pagina-3:http_404/);
  });

  test('a posição vem do cursor, não de sempre recomeçar na página 1', async () => {
    // O cursor gravado pelo round anterior é o que retoma; é o que impede a
    // varredura de reler a página 1 para sempre.
    const calls: number[] = [];
    const cursor = { ...startListingCursor(SITE, 'movie', LISTING, 1000), page: 41 };
    const result = await walkListing({
      readPage: async (p: number) => {
        calls.push(p);
        // A página 41 entrega os posts a partir do índice 40, e a 42 a partir
        // do 60: a ÚLTIMA URL lida prova que a retomada aconteceu na 41.
        return page(20, (p - 41) * 20);
      },
      expectedPerPage: FULL,
      budget: { maxPagesPerRound: 3 },
      seriesEnabled: false,
      defaultKind: 'movie',
      cursor,
      now: 2000,
    });
    assert.deepEqual(calls, [41, 42, 43], 'começou na 41 e andou em ordem');
    assert.equal(result.urls[0].url, url(0), 'a primeira URL da rodada veio da página 41');
    assert.equal(result.urls.at(-1)?.url, url(59));
    assert.equal(result.complete, false, 'parou no teto de rodada, sem provar cobertura');
  });
});

describe('listing-discover: trava de fim de catálogo', () => {
  test('página INCOMPLETA é o fim do acervo (medido: 2123 tem 15 de 20)', async () => {
    const result = await run(reader([page(20, 1), page(20, 21), page(15, 41)]));
    assert.equal(result.endOfListing, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.failures, []);
  });

  test('página fora de faixa (o site devolve o rabo) NÃO empurra o acervo', async () => {
    // `/pagina/99999/` devolve a última real. Sem a contagem, o round andaria
    // até o teto achando que avançou.
    const result = await run(reader([page(15, 1)]));
    assert.equal(result.complete, true);
    assert.equal(result.pagesConsumed, 1);
  });

  test('a contagem de ÚNICAS decide: página cheia e repetida é inversão, não avanço', async () => {
    // Página 20 cards, TODOS repetidos do que a rodada já entregou. A trava
    // primária (contagem < cheio) não pega: ela é cheia. A segunda pega.
    const first = page(20, 1);
    const repeated = page(20, 1);
    const result = await run(reader([first, repeated]));
    assert.equal(result.pagesConsumed, 2);
    assert.equal(result.urls.length, 20, 'a repetida não entra de novo');
    assert.equal(result.complete, false, 'inversão de página não prova cobertura');
    assert.equal(result.reason, 'already-seen-page');
  });

  test('teto de rodada NÃO é cobertura: `complete:false` e o cursor avança', async () => {
    const result = await run(reader([page(20, 1), page(20, 21), page(20, 41)]));
    assert.equal(result.pagesConsumed, 3, 'parou no teto de 3 páginas');
    assert.equal(result.complete, false, 'teto de orçamento não prova que o acervo acabou');
    assert.equal(result.endOfListing, false);
    // E a retomada é a página seguinte, não a 1.
    assert.equal(result.cursor.page, 4);
  });
});

describe('listing-discover: falha é falha, nunca "vazio e completo"', () => {
  test('página sem NENHUM card é `failures` + `complete:false`', async () => {
    // `urls: []` com `complete: true` faria o cursor do crawler avançar por
    // cima de acervo nunca lido — a combinação mais silenciosa desta camada.
    const result = await run(reader([{ posts: [] }]));
    assert.deepEqual(result.urls, []);
    assert.equal(result.complete, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /listing-pagina-1:nenhum-card/);
  });

  test('cards brutos sem nenhum card reconhecido falham sem consumir cursor', async () => {
    const result = await run(reader([{ posts: [], cardCount: 20, recognizedCount: 0 }]));
    assert.deepEqual(result.urls, []);
    assert.equal(result.complete, false);
    assert.equal(result.pagesConsumed, 0);
    assert.equal(result.cursor.page, 1);
    assert.match(result.failures.join(), /cards-nao-reconhecidos/);
  });

  test('cards válidos todos filtrados pelo gate de série continuam consumindo a página', async () => {
    const result = await run(reader([{ posts: page(15, 1, 'tv_show').posts, cardCount: 15, recognizedCount: 15 }]));
    assert.equal(result.urls.length, 0);
    assert.equal(result.failures.length, 0);
    assert.equal(result.pagesConsumed, 1);
    assert.equal(result.complete, true, 'o card válido foi consumido e a página curta fecha a carga');
  });

  test('cards reconhecidos todos fora do host permitido falham sem consumir cursor', async () => {
    const result = await run(reader([{ posts: [], cardCount: 15, recognizedCount: 15 }]));
    assert.equal(result.urls.length, 0);
    assert.match(result.failures.join(), /nenhuma-obra-no-host/);
    assert.equal(result.pagesConsumed, 0);
    assert.equal(result.cursor.page, 1);
    assert.equal(result.complete, false);
    assert.equal(result.endOfListing, false);
  });

  test('rede caída vira `failures`, e a rodada fecha com o que já entregou', async () => {
    const calls: number[] = [];
    const readPage = async (p: number): Promise<ListingPageRead> => {
      calls.push(p);
      if (p > 1) throw new Error('http_503');
      return page(20, 1);
    };
    const result = await run(readPage);
    assert.equal(result.urls.length, 20, 'a página boa continua entregue');
    assert.equal(result.complete, false);
    assert.match(result.failures.join(), /listing-pagina-2:http_503/);
  });

  test('a página que FALHOU não é consumida: o cursor não pula acervo', async () => {
    const readPage = async (p: number): Promise<ListingPageRead> => {
      if (p > 1) throw new Error('timeout');
      return page(20, 1);
    };
    const result = await run(readPage);
    assert.equal(result.cursor.page, 2, 'o retry relê a página 2, que é a que falhou');
    assert.equal(result.cursor.roundPage, 1, 'só a página consumida contou no round');
  });

  test('uma falha derruba o `complete` mesmo com a âncora/fim já encontrado', async () => {
    const result = await run(reader([{ posts: [] }, page(15, 1)]));
    assert.equal(result.failures.length, 1);
    assert.equal(result.complete, false);
  });
});

describe('listing-discover: filtro de séries e tipo', () => {
  test('o tipo é POR CARD: uma página mista mantém os dois (a página 1 real é mista)', async () => {
    // Medido: os 20 cards da página 1 do HDRTorrent são filmes e séries
    // misturados. Um tipo por PÁGINA jogaria todos para um balde só.
    const mixed: ListingPageRead = {
      posts: [
        ...Array.from({ length: 10 }, (_, i) => ({ url: url(i), kind: 'movie' as const })),
        ...Array.from({ length: 10 }, (_, i) => ({ url: url(100 + i), kind: 'tv_show' as const })),
      ],
    };
    const result = await run(reader([mixed]), { seriesEnabled: true });
    assert.equal(result.urls.filter((u) => u.kind === 'movie').length, 10);
    assert.equal(result.urls.filter((u) => u.kind === 'tv_show').length, 10);
  });

  test('série desligada: a página é lida (custo gasto) e NÃO entra na fila', async () => {
    const result = await run(reader([page(20, 1, 'tv_show')]), { seriesEnabled: false });
    assert.equal(result.pagesConsumed, 1, 'o orçamento foi gasto no site');
    assert.equal(result.urls.length, 0, 'nenhuma URL de série na fila');
  });

  test('série desligada em página MISTA: só as séries saem da fila', async () => {
    const mixed: ListingPageRead = {
      posts: [
        { url: url(0), kind: 'movie' }, { url: url(1), kind: 'tv_show' },
        { url: url(2), kind: 'movie' }, { url: url(3), kind: 'tv_show' },
      ],
    };
    const result = await run(reader([mixed]), { seriesEnabled: false });
    assert.equal(result.urls.length, 2);
    assert.ok(result.urls.every((u) => u.kind === 'movie'));
  });

  test('série ligada: a página entra com o kind do site', async () => {
    const result = await run(reader([page(20, 1, 'tv_show')]), { seriesEnabled: true });
    assert.equal(result.urls.length, 20);
    assert.equal(result.urls[0].kind, 'tv_show');
  });

  test('`kind: null` (card sem tipo) cai no `defaultKind` do adaptador', async () => {
    const result = await run(reader([page(20, 1, null)]), { defaultKind: 'tv_show', seriesEnabled: true });
    assert.equal(result.urls[0].kind, 'tv_show');
  });

  test('página mista de série continua fechando o acervo pelo fim', async () => {
    const result = await run(reader([page(15, 1, 'tv_show')]), { seriesEnabled: false });
    assert.equal(result.endOfListing, true, 'série desligada não faz a varredura andar para sempre');
  });
});

describe('listing-discover: lastmod vazio é decisão, não esquecimento', () => {
  test('nenhuma URL leva data: a listagem publica o ANO da obra, não a de publicação', async () => {
    // Usar o `datePublished` do card (o ano da obra) como `lastmod` faria o
    // motor cortar o acervo pela ordem do ano em vez da publicação.
    const result = await run(reader([page(20, 1)]));
    for (const u of result.urls) assert.equal(u.lastmod, '');
  });

  test('a listagem REAL do site não produz lastmod nenhum', async () => {
    // Guarda de regressão com o HTML do site: o card traz
    // `meta[itemprop=datePublished]` e ele é o ANO da obra.
    const html = hdrFixture('pagina-1-cheia');
    const years = [...html.matchAll(/itemprop="datePublished" content="(\d{4})"/g)].map((m) => m[1]);
    assert.ok(years.length > 0, 'o card publica alguma data');
    // Todo valor é um ano de 4 dígitos — granularidade de ano, que como
    // `lastmod` cortaria o acervo na ordem errada.
    assert.ok(years.every((y) => /^(19|20)\d{2}$/.test(y)), 'é o ano da obra, não timestamp');
  });
});

describe('listing-discover: o cursor de listagem é durável e retoma', () => {
  beforeEach(() => { store.open(undefined, { forceMemory: true }); });

  test('grava o cursor no crawl_state e a rodada seguinte continua dele', async () => {
    const { saveListingCursor } = await import('../src/providers/crawl-cursor.js');
    const cursor = { ...startListingCursor(SITE, 'movie', LISTING, 1000), page: 5 };
    saveListingCursor(cursor);
    const loaded = loadListingCursor(SITE, 'movie', LISTING);
    assert.ok(loaded, 'o cursor sobrevive entre rodadas');
    assert.equal(loaded?.page, 5);
  });

  test('o cursor devolvido aponta para a página SEGUINTE à consumida', async () => {
    const result = await run(reader([page(20, 1), page(20, 21)]));
    assert.equal(result.cursor.page, 3);
    assert.equal(result.cursor.roundPage, 2, 'duas páginas consumidas no round');
  });
});

describe('listing-discover: adapters respeitam host e contagem bruta', () => {
  test('Apache: cards todos fora do host falham e a rodada seguinte relê a página', async () => {
    const foreign = apacheFixture('pagina-1-cheia').replaceAll(APACHE_BASE, 'https://outside.invalid');
    await withApacheSite([[`${APACHE_BASE}/`, { body: foreign }]], async ({ site, urls }) => {
      const first = await site.discover(null, { series: { enabled: true, maxCards: 10, maxButtons: 40 } });
      const second = await site.discover(null, { series: { enabled: true, maxCards: 10, maxButtons: 40 } });
      assert.equal(first.complete, false);
      assert.equal(first.urls.length, 0);
      assert.match(first.failures.join(), /nenhuma-obra-no-host/);
      assert.equal(first.requestCost, 1);
      assert.equal(second.requestCost, 1);
      assert.deepEqual(urls, [`${APACHE_BASE}/`, `${APACHE_BASE}/`]);
    });
  });

  test('Apache: uma obra válida entre hosts externos mantém 20 cards brutos', async () => {
    const expected = apacheListingUrls('pagina-1-cheia')[0];
    const path = new URL(expected).pathname;
    const html = apacheFixture('pagina-1-cheia')
      .replaceAll(APACHE_BASE, 'https://outside.invalid')
      .replaceAll(`https://outside.invalid${path}`, `${APACHE_BASE}${path}`);
    await withApacheSite([[`${APACHE_BASE}/`, { body: html }]], async ({ site, urls }) => {
      const found = await site.discover(null, { series: { enabled: true, maxCards: 10, maxButtons: 40 } });
      assert.equal(found.urls.length, 1);
      assert.equal(found.urls[0].url, expected);
      assert.equal(found.complete, false);
      assert.equal(found.requestCost, 2);
      assert.match(urls.at(-1) ?? '', /\/pagina\/2\//);
    });
  });
});
