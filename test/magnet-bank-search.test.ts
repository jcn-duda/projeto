// Etapa 5 — busca read-only do banco vivo: hash/título/recentes, projeção
// segura (allowlist), truncamento por `limit+1`, literais de curinga, acento
// SQL×memória e o cap de 100. O status/memo mora em `magnet-bank-status.test.ts`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as bank from '../src/utils/magnet-bank.js';
import { searchBank, BANK_SEARCH_MAX } from '../src/utils/magnet-bank-search.js';
import {
  H1, H2, H3, hasNodeSqlite, openMemory, openSql, seed, seedSpecial, hashAt, restoreConfig,
} from './helpers/magnet-bank-fixture.js';

after(restoreConfig);

/** Total exato casado, ou `false` quando a query é inválida. */
function matched(query: string): number | null | false {
  const result = searchBank(query);
  return result.ok ? result.matched : false;
}

test('busca por hash devolve magnet, URI, fontes e obras com payload por allowlist', () => {
  openMemory();
  seed();

  const result = searchBank(H1.toUpperCase());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.mode, 'hash');
  assert.equal(result.query, H1, 'hash normalizado para minúsculo');
  assert.equal(result.returned, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.truncated, false);

  const item = result.items[0];
  assert.equal(item.hash, H1);
  assert.match(item.uri, /dn=Filme/, 'URI do post viaja inteira');
  assert.equal(item.isBr, true);
  assert.equal(item.dubbed, true);
  assert.equal(item.quality, '1080p');
  assert.equal(item.sources.length, 2, 'nerdfilmes + bludv');
  assert.equal(item.works.length, 1);
  assert.equal(item.works[0].imdb, 'tt111');

  // Allowlist explícita: nada de campo interno da engine na resposta.
  assert.deepEqual(
    Object.keys(item).sort(),
    ['dubbed', 'firstSeen', 'hash', 'isBr', 'lastSeen', 'lied', 'quality', 'seedersLast', 'seedersMax', 'size', 'sources', 'title', 'uri', 'works'],
  );
  // Projeção EXPLÍCITA: o `hash` (chave interna) não vaza em fontes/obras.
  assert.deepEqual(
    Object.keys(item.sources[0]).sort(),
    ['firstSeen', 'indexer', 'lastSeen', 'seedersLast', 'tracker'],
  );
  assert.deepEqual(
    Object.keys(item.works[0]).sort(),
    ['episode', 'firstSeen', 'imdb', 'lastSeen', 'passedFilter', 'season'],
  );
  const raw = JSON.stringify(result);
  assert.ok(!raw.includes('accountScope'), 'nenhum digest de conta');
  assert.ok(!raw.toLowerCase().includes('apikey'), 'nenhuma credencial');
});

test('busca por título é substring case-insensitive; vazia devolve recentes', () => {
  openMemory();
  seed();

  const legenda = searchBank('legendad');
  assert.equal(legenda.ok, true);
  if (!legenda.ok) return;
  assert.equal(legenda.mode, 'title');
  assert.equal(legenda.matched, 1);
  assert.equal(legenda.items[0].hash, H3);

  const upper = searchBank('SERIE DOIS');
  assert.equal(upper.ok, true);
  if (!upper.ok) return;
  assert.equal(upper.matched, 2, 'a busca não diferencia caixa');

  const recentes = searchBank('');
  assert.equal(recentes.ok, true);
  if (!recentes.ok) return;
  assert.equal(recentes.mode, 'recent');
  assert.equal(recentes.matched, 3, 'matched do modo recente é o total de magnets');
  assert.equal(recentes.returned, 3);
  assert.equal(recentes.truncated, false);
});

test('janela lida com limit+1: truncado não paga COUNT exato (matched null)', () => {
  openMemory();
  seed();

  const recentes = searchBank('', 2);
  assert.equal(recentes.ok, true);
  if (!recentes.ok) return;
  assert.equal(recentes.returned, 2, 'devolve no máximo o limite');
  assert.equal(recentes.truncated, true, 'o 3º item prova o truncamento');
  assert.equal(recentes.matched, null, 'truncado não mede o total exato');

  const titulo = searchBank('serie dois', 1);
  assert.equal(titulo.ok, true);
  if (!titulo.ok) return;
  assert.equal(titulo.returned, 1);
  assert.equal(titulo.truncated, true);
  assert.equal(titulo.matched, null);

  const exato = searchBank('serie dois', 10);
  assert.equal(exato.ok, true);
  if (!exato.ok) return;
  assert.equal(exato.matched, 2, 'janela cabendo tudo dá o total exato');
  assert.equal(exato.truncated, false);
});

test('busca trata %, _ e \\ como LITERAIS e casa acento nas duas engines', () => {
  openMemory();
  seedSpecial();

  // Curingas não vazam: os caracteres só casam em título que os contém.
  assert.equal(matched('100%'), 1, '% é literal');
  assert.equal(matched('%_off'), 1, '% e _ são literais');
  assert.equal(matched('off\\ba'), 1, '\\ é literal');
  assert.equal(matched('100%off'), 0, '_ não é curinga de um char');
  assert.equal(matched('offbar'), 0, '\\ não é escape que some');
  assert.equal(matched('100%_off\\barato'), 1, 'literal completo casa');
  // Acento casa nas DUAS engines: as variantes de caixa fecham o gap do LIKE
  // ASCII (`Épico` × `épico`/`ÉPICO`) e a memória usa as mesmas variantes.
  assert.equal(matched('Extermínio'), 1);
  assert.equal(matched('extermínio'), 1);
  assert.equal(matched('Épico'), 1);
  assert.equal(matched('épico'), 1);
  assert.equal(matched('ÉPICO'), 1);
});

test('busca valida entrada e respeita o teto/default do limite', () => {
  openMemory();
  seed();

  const curta = searchBank('a');
  assert.equal(curta.ok, false);
  if (curta.ok) return;
  assert.match(curta.error, /ao menos 2 caracteres/);

  const longa = searchBank('x'.repeat(121));
  assert.equal(longa.ok, false);

  const limitada = searchBank('', 500);
  assert.equal(limitada.ok, true);
  if (!limitada.ok) return;
  assert.equal(limitada.limit, BANK_SEARCH_MAX, 'pedido acima do teto é clampado');

  // `max <= 0`/inválido cai no default (50), nunca em 0 nem negativo.
  const zero = searchBank('', 0);
  const negativo = searchBank('', -5);
  assert.equal(zero.ok && zero.limit, 50);
  assert.equal(negativo.ok && negativo.limit, 50);

  const foraDoTipo = searchBank(42 as unknown);
  assert.equal(foraDoTipo.ok, true, 'query não-string vira vazia (recentes), sem throw');
  if (!foraDoTipo.ok) return;
  assert.equal(foraDoTipo.mode, 'recent');
});

test('trunca de verdade no cap 100 (limit+1, matched null)', () => {
  openMemory();
  const items = Array.from({ length: 105 }, (_, i) => ({
    title: `Magnet de teste ${i}`,
    infoHash: hashAt(i),
    magnet: `magnet:?xt=urn:btih:${hashAt(i)}`,
  }));
  bank.captureItems(items, 'bludv', {});
  bank.flushNow();

  const result = searchBank('', 500);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.limit, BANK_SEARCH_MAX, 'pedido acima do cap é clampado');
  assert.equal(result.returned, 100, 'devolve exatamente o cap');
  assert.equal(result.truncated, true, 'o 101º item prova o truncamento');
  assert.equal(result.matched, null, 'truncado não mede o total exato');

  // `max` acima do cap não amplia: 100 continua sendo o teto duro.
  const acimaDoCap = searchBank('', 200);
  assert.equal(acimaDoCap.ok, true);
  if (!acimaDoCap.ok) return;
  assert.equal(acimaDoCap.limit, BANK_SEARCH_MAX);
  assert.equal(acimaDoCap.returned, 100);
});

test('engine SQL busca igual à memória (hash, título, acento e literal)', { skip: !hasNodeSqlite }, () => {
  openSql();
  seed();

  const porHash = searchBank(H2);
  assert.equal(porHash.ok, true);
  if (!porHash.ok) return;
  assert.equal(porHash.items[0].hash, H2);
  assert.equal(porHash.items[0].works[0].season, 1);
  assert.equal(porHash.items[0].works[0].episode, 2);

  const porTitulo = searchBank('legendad');
  assert.equal(porTitulo.ok, true);
  if (!porTitulo.ok) return;
  assert.equal(porTitulo.matched, 1);
  assert.equal(porTitulo.items[0].hash, H3);

  // A mesma semântica LITERAL da memória, via ESCAPE no LIKE.
  seedSpecial();
  assert.equal(matched('100%'), 1, '% é literal no LIKE');
  assert.equal(matched('%_off'), 1, '% e _ são literais no LIKE');
  assert.equal(matched('off\\ba'), 1, '\\ é literal no LIKE');
  assert.equal(matched('100%off'), 0, 'ESCAPE impede _ de casar um char');
  assert.equal(matched('offbar'), 0, 'ESCAPE impede \\ de sumir');
  assert.equal(matched('100%_off\\barato'), 1);
  // Acento: o OR das variantes de caixa fecha o gap do casefold ASCII.
  assert.equal(matched('Épico'), 1);
  assert.equal(matched('épico'), 1);
  assert.equal(matched('ÉPICO'), 1);
});

test('engine SQL também trunca no cap 100', { skip: !hasNodeSqlite }, () => {
  openSql();
  const items = Array.from({ length: 105 }, (_, i) => ({
    title: `SQL ${i}`,
    infoHash: hashAt(i),
    magnet: `magnet:?xt=urn:btih:${hashAt(i)}`,
  }));
  bank.captureItems(items, 'bludv', {});
  bank.flushNow();

  const result = searchBank('', 500);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.returned, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.matched, null);
});
