// Fase 8 — cursor opaco de LISTAGEM (âncora por URL + round cap).
//
// Site sem sitemap útil é percorrido por listagem paginada, e a página em que a
// varredura parou é ESTADO DE RETOMADA: sem ela, o restart do container recomeça
// da página 1 e relê a listagem inteira. Pior: a listagem cresce pela FRENTE (a
// página 1 de amanhã tem posts novos), então um cursor só com número de página
// releria as mesmas páginas para sempre. A âNCORA (o post mais antigo já lido,
// guardado pelo caminho) é o marco que fecha o round. O que este arquivo trava:
//   - o token é opaco (prefixo+versão+base64url), faz round-trip e tolera o
//     formato anterior (sem âncora) sem recusar estado legítimo;
//   - token fora de forma (versão velha, base64 inválido, tipo errado, número
//     quebrado, âncora inútil) devolve `null` — NUNCA lança e nunca adota lixo
//     pela metade: cursor ruim recomeça a listagem, que é o lado barato porque a
//     identidade da página é o caminho (`crawl-url-key.ts`);
//   - a retomada é por LISTAGEM (caminho) e por KIND, no `crawl_state`, com o
//     cursor do outro site intacto;
//   - o round só fecha com a âncora ACHADA (ou fim de listagem declarado) — sem
//     âncora o resultado é `complete: false` e o marco NÃO anda;
//   - o round é limitado por um teto de páginas (nada de varredura eterna) e o
//     `page`/`seen` nunca recuam.
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
  readListingPage,
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
      // versão fora (token de outra representation) e base {v:1} sem site/kind.
      token({ v: 2, s: 'x', k: 'movie', p: '/a', n: 1, c: 0, t: 0 }),
      // forma correta, dado fora do tipo: site/kind/caminho inválidos, números
      // quebrados (page 0, seen fracionário, updatedAt negativo) e âncora
      // presente mas INÚTIL (o token existe, o marco não) — a lista recomeça.
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
      // token gigante: `crawl_state` corrompido não pode virar parse caro.
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

describe('avanço: monotônico e com teto de profundidade', () => {
  test('avança uma página e soma o que foi enfileirado', () => {
    const a = readListingPage(start({ page: 1, seen: 0 }), { posts: ['/p1', '/p2'], enqueued: 2 }, 2000);
    assert.equal(a.cursor.page, 2);
    assert.equal(a.cursor.seen, 2);
    assert.equal(a.cursor.updatedAt, 2000);
    const b = readListingPage(a.cursor, { posts: ['/p3'] }, 3000);
    assert.equal(b.cursor.page, 3);
    assert.equal(b.cursor.seen, 3);
  });

  test('nunca recua: contagem negativa não devolve orçamento e page 0 não regrada', () => {
    const a = readListingPage(start({ page: 5, seen: 40 }), { posts: [], enqueued: -10 }, 2000);
    assert.equal(a.cursor.seen, 40, 'medida negativa não subtrai');
    const b = readListingPage({ ...a.cursor, page: 0 }, { posts: ['/p'] }, 3000);
    assert.equal(b.cursor.page, 2, 'page 0 (token forjado) não faz o cursor andar para trás');
  });

  test('teto de páginas encerra o ciclo; sem teto, não encerra', () => {
    const c = start({ page: 40 });
    assert.equal(listingCursorExhausted(c, 40), false, 'a página do teto ainda é lida');
    assert.equal(listingCursorExhausted(c, 39), true);
    assert.equal(listingCursorExhausted(c, 0), false, '0 = sem limite');
    assert.equal(listingCursorExhausted(c), false);
  });
});

describe('âncora: o round só fecha com o marco ACHADO', () => {
  test('página sem a âncora: complete:false e o marco NÃO anda', () => {
    const c = start({ anchor: '/filmes/velho', roundPage: 1, rounds: 2 });
    const r = readListingPage(c, { posts: ['/filmes/novo-1', '/filmes/novo-2'] }, 2000);
    assert.equal(r.complete, false, 'sem marco achado o round não pode afirmar cobertura');
    assert.equal(r.reason, 'walk');
    assert.equal(r.anchorFound, false);
    assert.equal(r.advanced, true, 'a página foi lida: a posição de retomada avança');
    assert.equal(r.cursor.anchor, '/filmes/velho', 'marco parado enquanto o round está aberto');
    assert.equal(r.cursor.roundPage, 2);
    assert.equal(r.cursor.rounds, 2, 'rounds fechados não muda');
  });

  test('página com a âncora: fecha com complete:true e o marco vira o post mais ANTIGO lido', () => {
    const c = start({ anchor: '/filmes/marco', roundPage: 1, rounds: 2 });
    const r = readListingPage(c, { posts: ['/filmes/a', '/filmes/b', '/filmes/marco', '/filmes/c'] }, 2000);
    assert.equal(r.complete, true);
    assert.equal(r.reason, 'anchor-found');
    assert.equal(r.anchorFound, true);
    assert.equal(r.cursor.anchor, '/filmes/c', 'o marco novo é o ÚLTIMO post da página (o mais antigo)');
    assert.equal(r.cursor.roundPage, 0, 'round fechado: o próximo começa do zero');
    assert.equal(r.cursor.rounds, 3);
    assert.equal(r.cursor.seen, 4, 'a página inteira entra no orçamento, marco ou não');
  });

  test('a âncora casa pelo CAMINHO: o site trocou de domínio e o round ainda fecha', () => {
    const c = start({ anchor: '/filmes/marco', site: 'nerdfilmes' });
    const r = readListingPage(c, { posts: ['https://filmesviatorrenthd.net/filmes/marco?utm=x', '/filmes/x'] }, 2000);
    assert.equal(r.anchorFound, true, 'query e host são ignorados — a identidade é o caminho');
    assert.equal(r.complete, true);
  });

  test('sem âncora (primeiro round) a lista vazia não "acha" nada: fecha pelo fim declarado', () => {
    const c = start();
    assert.equal(readListingPage(c, { posts: [] }, 2000).complete, false, 'página vazia não é marco achado');
    const fim = readListingPage(c, { posts: [], endOfListing: true }, 2500);
    assert.equal(fim.complete, true);
    assert.equal(fim.reason, 'end-of-listing');
    assert.equal(fim.cursor.anchor, '', 'sem posts não há marco novo; o anterior (nenhum) fica');
    assert.equal(fim.cursor.roundPage, 0);
  });

  test('página sem post utilizável não inventa marco', () => {
    const r = readListingPage(start({ anchor: '/filmes/marco' }), { posts: ['/', 'https://host/'], endOfListing: true }, 2000);
    assert.equal(r.cursor.anchor, '/filmes/marco', 'marco anterior sobrevive a uma página sem post');
  });
});

describe('round cap: a listagem que nunca ancora não vira varredura eterna', () => {
  test('a página que bate o teto fecha o round com complete:false', () => {
    const opts = { roundMaxPages: 3 };
    const a = readListingPage(start(), { posts: ['/filmes/p1', '/filmes/p1b'] }, 1001, opts);
    assert.equal(a.complete, false);
    assert.equal(a.reason, 'walk');
    assert.equal(a.cursor.roundPage, 1);
    assert.equal(a.cursor.anchor, '', 'round aberto sem marco: nada promete cobertura');
    const b = readListingPage(a.cursor, { posts: ['/filmes/p2', '/filmes/p2b'] }, 1002, opts);
    assert.equal(b.cursor.roundPage, 2);
    assert.equal(b.cursor.rounds, 0, 'rounds fechados não muda com o round aberto');
    const c3 = readListingPage(b.cursor, { posts: ['/filmes/p3', '/filmes/p3b'] }, 1003, opts);
    assert.equal(c3.reason, 'round-cap', 'a 3ª página (o teto) fecha o round');
    assert.equal(c3.complete, false, 'não achou a âncora: NÃO pode afirmar que cobriu a listagem');
    assert.equal(c3.cursor.roundPage, 0, 'round fechado — a próxima tentativa começa do zero');
    assert.equal(c3.cursor.rounds, 1);
    assert.equal(c3.cursor.anchor, '/filmes/p3b', 'o marco avançou para o fim do trecho lido');
    assert.equal(c3.cursor.page, 4, 'a posição de retomada não se perde ao fechar o round');
    assert.equal(listingRoundExhausted(c3.cursor, 3), false, 'o round seguinte pode andar de novo');
    const d = readListingPage(c3.cursor, { posts: ['/filmes/p4'] }, 1004, opts);
    assert.equal(d.reason, 'walk', 'a listagem continua sendo percorrida, round novo');
    assert.equal(d.cursor.roundPage, 1);
  });

  test('roundPage já no teto (token incoerente) não consome a página e se reinicia', () => {
    const c = start({ anchor: '/filmes/marco', roundPage: 9, page: 3, seen: 20, rounds: 1 });
    assert.equal(listingRoundExhausted(c, 3), true);
    const r = readListingPage(c, { posts: ['/filmes/x'] }, 2000, { roundMaxPages: 3 });
    assert.equal(r.advanced, false, 'nada consumido — nem posição, nem orçamento');
    assert.equal(r.complete, false);
    assert.equal(r.reason, 'round-cap');
    assert.equal(r.cursor.roundPage, 0, 'o round se reinicia, senão a listagem travava para sempre');
    assert.equal(r.cursor.anchor, '/filmes/marco', 'marco e posição intactos');
    assert.equal(r.cursor.page, 3);
    assert.equal(r.cursor.seen, 20);
    assert.equal(listingRoundExhausted(r.cursor, 3), false);
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

  test('teto absoluto de profundidade não consome nem fecha round', () => {
    const c = start({ page: 41, roundPage: 1, anchor: '/filmes/marco' });
    const r = readListingPage(c, { posts: ['/filmes/x'] }, 2000, { maxPages: 40 });
    assert.equal(r.advanced, false);
    assert.equal(r.complete, false);
    assert.equal(r.reason, 'page-cap');
    assert.equal(r.cursor, c, 'o cursor volta intacto (mesmo objeto)');
  });
});

describe('estado durável: retomada por listagem, escopada por site', () => {
  test('guarda, relê e sobrevive a outra listagem/kind', () => {
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null, 'nunca lida: recomeça da página 1');
    const c = readListingPage(start(), { posts: ['/p1', '/p2'] }, 2000).cursor;
    saveListingCursor(c);
    assert.deepEqual(loadListingCursor('nerdfilmes', 'movie', LISTING), c);
    // Mesma listagem escrita de novo com barra final/host diferente: MESMA
    // chave (a identidade é o caminho).
    assert.deepEqual(loadListingCursor('nerdfilmes', 'movie', 'https://outro.host/filmes'), c);
    // Listagem e kind diferentes não enxergam o cursor alheio.
    assert.equal(loadListingCursor('nerdfilmes', 'movie', '/series/'), null);
    assert.equal(loadListingCursor('nerdfilmes', 'tv_show', LISTING), null);
    assert.equal(loadListingCursor('vacatorrent', 'movie', LISTING), null, 'site diferente, estado diferente');
  });

  test('o marco sobrevive ao restart (é o que impede reler a listagem inteira)', () => {
    const c = readListingPage(start(), { posts: ['/filmes/a', '/filmes/b'], endOfListing: true }, 2000).cursor;
    saveListingCursor(c);
    const relido = loadListingCursor('nerdfilmes', 'movie', LISTING);
    assert.equal(relido?.anchor, '/filmes/b');
    assert.equal(relido?.rounds, 1);
    // O round seguinte (site voltou a publicar) acha o marco e fecha de novo.
    const proximo = readListingPage(relido as ListingCursor, { posts: ['/filmes/c', '/filmes/b'] }, 3000);
    assert.equal(proximo.anchorFound, true);
    assert.equal(proximo.complete, true);
    assert.equal(proximo.cursor.anchor, '/filmes/b');
  });

  test('token gravado pela mão (vazio/corrompido) recomeça em vez de quebrar', () => {
    const key = listingCursorKey('movie', LISTING);
    store.engine().setState('nerdfilmes', key, 'lixo');
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
    store.engine().setState('nerdfilmes', key, '');
    assert.equal(loadListingCursor('nerdfilmes', 'movie', LISTING), null);
  });

  test('token de outro site na MESMA chave é recusado', () => {
    // Defesa contra estado reaproveitado: o token carrega o site, e um token
    // gravado sob a chave de outro site não pode virar a retomada deste.
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
