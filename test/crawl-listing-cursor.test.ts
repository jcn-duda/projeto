// Fase 8 — cursor opaco de LISTAGEM (âncora por URL + round cap).
//
// A leitura de página (`readListingPage`) saiu: o sidecar Rust anda a
// listagem. O Node ainda persiste e decodifica o token para o painel e para
// retomada no `crawl_state`. O que este arquivo trava:
//   - o token é opaco (prefixo+versão+base64url), faz round-trip e tolera o
//     formato anterior (sem âncora) sem recusar estado legítimo;
//   - token fora de forma devolve `null` — NUNCA lança e nunca adota lixo;
//   - a retomada é por LISTAGEM (caminho) e por KIND, no `crawl_state`;
//   - tetos de profundidade/round continuam puros sobre o cursor gravado.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/utils/crawl-store.js';
import {
  LISTING_CURSOR_TAG,
  LISTING_ROUND_MAX_PAGES,
  decodeListingCursor,
  clearListingCursor,
  encodeListingCursor,
  listingCursorExhausted,
  listingCursorKey,
  listingRoundExhausted,
  loadListingCursor,
  restartListingRound,
  saveListingCursor,
  startListingCursor,
  type ListingCursor,
} from '../src/providers/crawl-cursor.js';
import type { CrawlPageKind } from '../src/providers/crawl-types.js';

const LISTING = 'https://www.filmesviatorrenthd.net/filmes/';
const start = (over: Partial<ListingCursor> = {}): ListingCursor => ({
  ...startListingCursor('nerdfilmes', 'movie', LISTING, 1000), ...over,
});
/** Token cru: a forma do JSON é interna do módulo, o teste monta para o decode. */
const token = (json: Record<string, unknown>): string => `${LISTING_CURSOR_TAG}.${Buffer.from(JSON.stringify(json)).toString('base64url')}`;

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
});

after(() => {
  store.resetForTests();
});

describe('token: opaco, versionado e com round-trip', () => {
  test('codifica com a marca da versão e não expõe o caminho em claro', () => {
    const c = start({ page: 7, seen: 180, anchor: '/filmes/filme-antigo/', roundPage: 2, rounds: 5 });
    const gravado = encodeListingCursor(c);
    assert.ok(gravado.startsWith(`${LISTING_CURSOR_TAG}.`), 'versão legível na ponta, corpo opaco');
    assert.ok(!gravado.slice(LISTING_CURSOR_TAG.length + 1).includes('/filmes'), 'o corpo não é o JSON puro');
    assert.deepEqual(decodeListingCursor(gravado), {
      ...c, anchor: '/filmes/filme-antigo', updatedAt: 1000,
    }, 'a âncora viaja pelo caminho normalizado, como a identidade da fila');
  });

  test('o mesmo estado gera o mesmo token (estabilidade entre boots)', () => {
    assert.equal(encodeListingCursor(start({ page: 3, anchor: '/filmes/x' })), encodeListingCursor(start({ page: 3, anchor: '/filmes/x' })));
  });

  test('formato anterior (sem âncora/contadores) é aceito como "sem marco"', () => {
    const antigo = decodeListingCursor(token({ v: 1, s: 'nerdfilmes', k: 'movie', p: '/filmes/', n: 4, c: 96, t: 1234 }));
    assert.ok(antigo, 'token gravado antes da âncora continua legível');
    assert.equal(antigo?.anchor, '');
    assert.equal(antigo?.roundPage, 0);
    assert.equal(antigo?.rounds, 0);
    assert.equal(antigo?.page, 4);
  });

  test('token fora de forma devolve null em vez de lançar', () => {
    const casos = [
      '', '   ', 'nada', 'lc0.eyJ2IjoxfQ', `outro.${Buffer.from('{"v":1}').toString('base64url')}`,
      `${LISTING_CURSOR_TAG}.`, `${LISTING_CURSOR_TAG}.@@@nao-base64@@@`,
      token({ v: 2, s: 'x', k: 'movie', p: '/a', n: 1, c: 0, t: 0 }),
      ...['{"v":1,"s":"","k":"movie","p":"/a","n":1,"c":0,"t":0}',
        '{"v":1,"s":"x","k":"filme","p":"/a","n":1,"c":0,"t":0}',
        '{"v":1,"s":"x","k":"movie","p":"","n":1,"c":0,"t":0}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":0,"c":0,"t":0}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1.5,"c":0,"t":0}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":-1,"t":0}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":0,"t":-5}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":0,"t":0,"a":"/"}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":0,"t":0,"a":"https://host/"}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":0,"t":0,"a":7}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":0,"t":0,"r":-1}',
        '{"v":1,"s":"x","k":"movie","p":"/a","n":1,"c":0,"t":0,"d":1.5}']
        .map((json) => `${LISTING_CURSOR_TAG}.${Buffer.from(json).toString('base64url')}`),
      `${LISTING_CURSOR_TAG}.${'A'.repeat(2000)}`,
    ];
    for (const t of casos) {
      assert.equal(decodeListingCursor(t), null, `token recusado: ${t.slice(0, 48)}`);
    }
  });

  test('o caminho do cursor normaliza como a identidade da fila', () => {
    assert.equal(decodeListingCursor(encodeListingCursor(start({ path: '/filmes/' })))?.path, '/filmes', 'barra final fora, igual ao crawl_url');
  });
});

describe('tetos puros sobre o cursor gravado', () => {
  test('teto de páginas encerra o ciclo; sem teto, não encerra', () => {
    const c = start({ page: 40 });
    assert.equal(listingCursorExhausted(c, 40), false, 'a página do teto ainda é lida');
    assert.equal(listingCursorExhausted(c, 39), true);
    assert.equal(listingCursorExhausted(c, 0), false, '0 = sem limite');
    assert.equal(listingCursorExhausted(c), false);
  });

  test('teto 0 = sem teto de round; o default é um número positivo e documentado', () => {
    assert.ok(LISTING_ROUND_MAX_PAGES > 0, 'o default existe justamente para a listagem parar');
    const c = start({ roundPage: 5 });
    assert.equal(listingRoundExhausted(c, 0), false, '0 desliga o teto de round');
    assert.equal(listingRoundExhausted(c), false, '5 < default');
    assert.equal(listingRoundExhausted(start({ roundPage: LISTING_ROUND_MAX_PAGES })), true);
  });

  test('reinício manual preserva marco e posição (escape do operador)', () => {
    const c = restartListingRound(start({ anchor: '/filmes/marco', roundPage: 4, page: 6, seen: 30 }), 5000);
    assert.equal(c.roundPage, 0);
    assert.equal(c.anchor, '/filmes/marco');
    assert.equal(c.page, 6);
    assert.equal(c.seen, 30);
    assert.equal(c.updatedAt, 5000);
  });
});

describe('estado durável: retomada por listagem, escopada por site', () => {
  test('guarda, relê e sobrevive a outra listagem/kind', () => {
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null, 'nunca lida: recomeça da página 1');
    const c = start({ page: 2, seen: 2, updatedAt: 2000 });
    saveListingCursor(c);
    assert.deepEqual(loadListingCursor('nerdfilmes', 'movie', LISTING), c);
    assert.deepEqual(loadListingCursor('nerdfilmes', 'movie', 'https://outro.host/filmes'), c);
    assert.equal(loadListingCursor('nerdfilmes', 'movie', '/series/'), null);
    assert.equal(loadListingCursor('nerdfilmes', 'tv_show', LISTING), null);
    assert.equal(loadListingCursor('vacatorrent', 'movie', LISTING), null, 'site diferente, estado diferente');
  });

  test('o marco sobrevive ao restart (é o que impede reler a listagem inteira)', () => {
    const c = start({ page: 1, seen: 2, anchor: '/filmes/a', sweep: true, rounds: 1, updatedAt: 2000 });
    saveListingCursor(c);
    const relido = loadListingCursor('nerdfilmes', 'movie', LISTING);
    assert.equal(relido?.anchor, '/filmes/a');
    assert.equal(relido?.sweep, true);
    assert.equal(relido?.page, 1);
    assert.equal(relido?.rounds, 1);
  });

  test('token gravado pela mão (vazio/corrompido) recomeça em vez de quebrar', () => {
    const key = listingCursorKey('movie', LISTING);
    store.engine().setState('nerdfilmes', key, 'lixo');
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
    store.engine().setState('nerdfilmes', key, '');
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
  });

  test('token de outro site na MESMA chave é recusado', () => {
    store.engine().setState('nerdfilmes', listingCursorKey('movie', LISTING), encodeListingCursor(start({ site: 'vacatorrent', anchor: '/filmes/marco' })));
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
  });

  test('limpar o cursor apaga a retomada sem tocar no resto do estado', () => {
    store.engine().setState('nerdfilmes', 'cursor:movie', '2026-01-01');
    saveListingCursor(start({ page: 9, anchor: '/filmes/marco' }));
    clearListingCursor('nerdfilmes', 'movie', LISTING);
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
    assert.equal(store.engine().getState('nerdfilmes', 'cursor:movie'), '2026-01-01', 'cursor incremental intocado');
  });

  test('"Zerar site" leva o cursor de listagem junto (é estado daquele site)', () => {
    saveListingCursor(start({ page: 5, anchor: '/filmes/marco' }));
    assert.equal(store.engine().clearSite('nerdfilmes').urls, 0);
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
  });

  test('a chave da listagem distingue kind e caminho', () => {
    assert.notEqual(listingCursorKey('movie', LISTING), listingCursorKey('tv_show', LISTING));
    assert.notEqual(listingCursorKey('movie', LISTING), listingCursorKey('movie', '/series/'));
    const kind: CrawlPageKind = 'tv_show';
    assert.equal(listingCursorKey(kind, LISTING), listingCursorKey('tv_show', LISTING));
  });

  test('a retomada devolve a página 1 enquanto não houver cursor gravado', () => {
    const c = loadListingCursor('nerdfilmes', 'movie', LISTING) ?? startListingCursor('nerdfilmes', 'movie', LISTING, 1000);
    assert.equal(c.page, 1);
    assert.equal(c.seen, 0);
    assert.equal(c.anchor, '', 'sem marco: o primeiro round fecha pelo fim da listagem');
  });
});
