// Teto LRU da engine de MEMÓRIA do banco de magnets vivo (fallback quando
// `node:sqlite` não existe). O SQLite é acervo PERMANENTE e não é tocado por
// esta política. Testa as invariantes que não podem regredir:
//   1. ao exceder o teto, evicta o MAIS ANTIGO e remove magnet + TODAS as
//      fontes/obras do hash (sem órfão);
//   2. `getMagnet` e `listMagnetsMany` promovem recência SEM alterar `lastSeen`
//      (observação do site);
//   3. upsert no `writeBatch` também promove (senão hash muito visto viraria
//      "frio" e seria despejado antes de um hash visto uma vez);
//   4. teto inválido (0/-5/NaN) cai no piso 1 — não existe modo ilimitado;
//   5. a eviction derruba o memo do status mesmo quando a escrita foi direto na
//      engine (fora do `applyOps`);
//   6. a engine SQL não tem LRU — o teto de memória não a alcança.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';
import * as rows from '../src/utils/magnet-bank-rows.js';
import type { MagnetRow, SourceRow, WorkRow } from '../src/utils/magnet-bank-schema.js';
import { FRESH_DIR, hasNodeSqlite, hexHash } from './helpers/magnet-bank-fixture.js';

const SAVED_CAP = config.magnetBank.memoryMax;
const SAVED_TTL = config.magnetBank.statusTtlMs;
const H1 = hexHash('a', '1');
const H2 = hexHash('b', '2');
const H3 = hexHash('c', '3');
const H4 = hexHash('d', '4');
const H5 = hexHash('e', '5');

after(() => {
  rows.resetForTests();
  config.magnetBank.memoryMax = SAVED_CAP;
  config.magnetBank.statusTtlMs = SAVED_TTL;
});

function mk(hash: string): MagnetRow {
  return {
    hash, uri: '', title: `Magnet ${hash.slice(0, 4)}`, size: 0,
    isBr: 0, dubbed: 0, quality: '', seedersMax: 0, seedersLast: 0,
    firstSeen: 1, lastSeen: 1, lied: 0,
  };
}
function src(hash: string, indexer: string): SourceRow {
  return { hash, indexer, tracker: '', firstSeen: 1, lastSeen: 1, seedersLast: 0 };
}
function work(hash: string, imdb: string): WorkRow {
  return { hash, imdb, season: -1, episode: -1, firstSeen: 1, lastSeen: 1, passedFilter: 1 };
}

function openMemory(cap: number) {
  config.magnetBank.enabled = true;
  config.magnetBank.memoryMax = cap;
  rows.resetForTests();
  rows.open(FRESH_DIR(), { forceMemory: true });
  return rows.engine();
}

test('memória: exceder o teto evicta o LRU e remove sources/works do hash', () => {
  metrics.reset();
  const e = openMemory(2);
  e.writeBatch({
    magnets: [mk(H1), mk(H2), mk(H3)],
    sources: [src(H1, 'bludv'), src(H2, 'bludv'), src(H3, 'bludv')],
    works: [work(H1, 'tt111'), work(H2, 'tt222'), work(H3, 'tt333')],
  });

  assert.equal(e.memoryMax(), 2);
  assert.equal(e.memoryEvictions(), 1, 'uma eviction para voltar ao teto');
  assert.equal(e.countMagnets(), 2);
  assert.equal(e.countSources(), 2, 'a fonte do hash evictado saiu junto');
  assert.equal(e.countWorks(), 2, 'a obra do hash evictado saiu junto');
  // O primeiro escrito é o mais antigo: é ele que cai.
  assert.equal(e.getMagnet(H1), null, 'H1 (LRU) foi evictado');
  assert.equal(e.getSource(H1, 'bludv'), null, 'sem órfão de fonte');
  assert.deepEqual(e.listSources(H1), [], 'listSources não devolve órfão');
  assert.deepEqual(e.listWorks(H1), [], 'listWorks não devolve órfão');
  assert.ok(e.getMagnet(H2), 'H2 sobreviveu');
  assert.ok(e.getMagnet(H3), 'H3 (MRU) sobreviveu');
  assert.equal(metrics.snapshot().counters['magnetbank.memory.evicted'], 1, 'métrica de eviction');
});

// Um lote único pode estourar o teto por VÁRIOS hashes: o `enforceCap` roda
// depois de aplicar a leva e evicta do início até caber — a contagem da métrica
// tem que ser a quantidade REAL de hashes removidos, não "1 por chamada".
test('memória: lote de 5 com teto 2 evicta 3 e mantém os 2 mais novos', () => {
  metrics.reset();
  const e = openMemory(2);
  e.writeBatch({ magnets: [mk(H1), mk(H2), mk(H3), mk(H4), mk(H5)], sources: [], works: [] });

  assert.equal(e.memoryEvictions(), 3, 'os três primeiros do lote caem');
  assert.equal(e.countMagnets(), 2, 'sobram os dois mais novos');
  assert.equal(e.getMagnet(H1), null);
  assert.equal(e.getMagnet(H2), null);
  assert.equal(e.getMagnet(H3), null);
  assert.ok(e.getMagnet(H4), 'H4 sobreviveu');
  assert.ok(e.getMagnet(H5), 'H5 (MRU) sobreviveu');
  assert.equal(metrics.snapshot().counters['magnetbank.memory.evicted'], 3, 'métrica por hash removido');
});

test('memória: teto 1 mantém só o mais novo e evicta os demais', () => {
  metrics.reset();
  const e = openMemory(1);
  e.writeBatch({ magnets: [mk(H1), mk(H2), mk(H3)], sources: [], works: [] });

  assert.equal(e.memoryMax(), 1);
  assert.equal(e.memoryEvictions(), 2);
  assert.equal(e.countMagnets(), 1);
  assert.equal(e.getMagnet(H1), null);
  assert.equal(e.getMagnet(H2), null);
  assert.ok(e.getMagnet(H3), 'o mais novo fica');
});

// O hash evictado pode ter mais de uma fonte (mesmo magnet visto por indexers
// diferentes) e mais de uma obra (pack recuperável em temporada/série): a
// remoção tem que varrer TODAS as linhas do hash, e os agregados do painel não
// podem manter hash de indexer que só existia nele.
test('memória: eviction remove DUAS fontes e DUAS obras do hash, sem órfão', () => {
  const e = openMemory(2);
  e.writeBatch({
    magnets: [mk(H1), mk(H2), mk(H3)],
    sources: [src(H1, 'bludv'), src(H1, 'nerdfilmes'), src(H2, 'bludv'), src(H3, 'bludv')],
    works: [work(H1, 'tt111'), work(H1, 'tt222'), work(H2, 'tt222'), work(H3, 'tt333')],
  });

  assert.equal(e.memoryEvictions(), 1, 'só o hash mais antigo sai');
  assert.equal(e.countMagnets(), 2);
  assert.equal(e.countSources(), 2, 'as DUAS fontes de H1 saíram');
  assert.equal(e.countWorks(), 2, 'as DUAS obras de H1 saíram');

  assert.deepEqual(e.listSources(H1), [], 'nenhuma fonte de H1');
  assert.deepEqual(e.listWorks(H1), [], 'nenhuma obra de H1');
  assert.deepEqual(e.listSourcesMany([H1, H2]).map((s) => s.hash), [H2], 'leitura em lote sem órfão');
  assert.deepEqual(e.listWorksMany([H1, H2]).map((w) => w.hash), [H2], 'leitura em lote de obras sem órfão');
  assert.deepEqual(e.listWorksByObra('tt111', -1, -1, 100), [], 'obra do hash evicto não é achada');
  assert.deepEqual(e.listWorksByObra('tt222', -1, -1, 100).map((w) => w.hash), [H2]);
  assert.deepEqual(e.listSourcesByIndexer('nerdfilmes', 100), [], 'indexer que só existia no evicto some');

  // Agregados coerentes: contagens batem com o estado físico e não há bucket
  // de indexer segurando um hash que já saiu.
  const stats = e.stats();
  assert.equal(stats.sources, e.countSources());
  assert.equal(stats.works, e.countWorks());
  assert.equal(stats.byIndexer.find((r) => r.indexer === 'nerdfilmes'), undefined, 'sem bucket órfão');
});

test('memória: get promove recência sem alterar lastSeen', () => {
  const e = openMemory(2);
  e.writeBatch({ magnets: [mk(H1), mk(H2)], sources: [], works: [] });

  const first = e.getMagnet(H1);
  assert.ok(first, 'H1 existe');
  assert.equal(first.lastSeen, 1, 'última observação do site intacta');
  // Segunda leitura só promove: `lastSeen` continua a observação gravada.
  const again = e.getMagnet(H1);
  assert.ok(again, 'H1 continua');
  assert.equal(again.lastSeen, 1, 'leitura não reescreve lastSeen');
  assert.equal(again, first, 'a mesma linha é devolvida');

  // H1 foi lido (MRU); H2 é o mais antigo e cai quando H3 entra.
  e.writeBatch({ magnets: [mk(H3)], sources: [], works: [] });
  assert.equal(e.memoryEvictions(), 1);
  assert.equal(e.getMagnet(H2), null, 'H2 (não lido) é o LRU');
  assert.ok(e.getMagnet(H1), 'H1 foi promovido pela leitura');
});

// A leitura em LOTE do fallback (`listMagnetsMany`) também é uso: sem o touch,
// o hash recém-consultado seria despejado como se fosse frio. O retorno segue a
// ordem dos hashes PEDIDA (contrato do fallback), não a ordem interna do LRU.
test('memória: listMagnetsMany promove recência sem reordenar o retorno', () => {
  const e = openMemory(2);
  e.writeBatch({ magnets: [mk(H1), mk(H2)], sources: [], works: [] });

  assert.deepEqual(e.listMagnetsMany([H2, H1]).map((r) => r.hash), [H2, H1], 'ordem pedida preservada');

  // A chamada tocou H2 e depois H1: H1 é o MRU e H2 vira o LRU. Sem o touch da
  // leitura em lote, a ordem continuaria H1, H2 e H1 é que cairia.
  e.writeBatch({ magnets: [mk(H3)], sources: [], works: [] });
  assert.equal(e.memoryEvictions(), 1);
  assert.equal(e.getMagnet(H2), null, 'H2 (menos recentemente tocado) caiu');
  assert.ok(e.getMagnet(H1), 'H1 promovido pela leitura em lote');
});

test('memória: upsert no writeBatch também promove', () => {
  const e = openMemory(2);
  e.writeBatch({ magnets: [mk(H1), mk(H2)], sources: [], works: [] });
  // Re-captura de H1: SEM a promoção do upsert, a chave continuaria na posição
  // original e H1 seria o evictado.
  e.writeBatch({ magnets: [mk(H1)], sources: [], works: [] });
  e.writeBatch({ magnets: [mk(H3)], sources: [], works: [] });

  assert.equal(e.memoryEvictions(), 1);
  assert.equal(e.getMagnet(H2), null, 'H2 é o LRU depois do upsert de H1');
  assert.ok(e.getMagnet(H1), 'H1 promovido pelo upsert');
});

// Teto inválido não pode reabrir o vazamento que o teto existe para fechar:
// 0/-5/NaN caem no piso MIN_CAP=1 (não há modo ilimitado).
test('memória: teto inválido (0/-5/NaN) é efetivamente 1', () => {
  for (const cap of [0, -5, NaN]) {
    metrics.reset();
    const e = openMemory(cap);
    assert.equal(e.memoryMax(), 1, `teto ${cap} clampa para 1`);
    e.writeBatch({ magnets: [mk(H1), mk(H2)], sources: [], works: [] });
    assert.equal(e.countMagnets(), 1, `teto ${cap} usou o piso 1`);
    assert.equal(e.memoryEvictions(), 1);
    assert.equal(e.getMagnet(H1), null);
    assert.ok(e.getMagnet(H2));
  }
});

// O memo do status guarda a foto (incluindo `memoryEvictions`). Uma eviction
// disparada por escrita DIRETA na engine (fora do `applyOps`) não passa pelo
// `invalidateStatusCache()` da fachada — o guarda O(1) do `status()` tem que
// derrubar a foto mesmo assim, senão o painel serviria totais velhos.
test('status: eviction direto na engine derruba o memo (não serve foto velha)', () => {
  const savedTtl = config.magnetBank.statusTtlMs;
  try {
    config.magnetBank.statusTtlMs = 60000;
    const e = openMemory(2);
    bank.invalidateStatusCache(); // engine crua nasceu fora do `bank.open`
    e.writeBatch({ magnets: [mk(H1), mk(H2)], sources: [], works: [] });
    bank.invalidateStatusCache(); // simula a escrita que não passou pelo `applyOps`

    const antes = bank.status();
    assert.equal(antes.magnets, 2);
    assert.equal(antes.memoryMax, 2);
    assert.equal(antes.memoryEvictions, 0);
    assert.equal(bank.status(), antes, 'dentro do TTL o memo serve a MESMA foto');

    e.writeBatch({ magnets: [mk(H3)], sources: [], works: [] });
    const depois = bank.status();
    assert.notEqual(depois, antes, 'a eviction derruba o memo');
    assert.equal(depois.magnets, 2);
    assert.equal(depois.memoryEvictions, 1);
  } finally {
    config.magnetBank.statusTtlMs = savedTtl;
  }
});

test('SQLite: teto de memória NÃO se aplica (acervo permanente)', { skip: !hasNodeSqlite }, () => {
  config.magnetBank.memoryMax = 1;
  rows.resetForTests();
  rows.open(path.join(FRESH_DIR(), 'magnets.db'));
  const e = rows.engine();

  assert.equal(e.kind, 'sql');
  assert.equal(e.memoryMax(), null, 'SQLite não expõe teto (permanente)');
  assert.equal(e.memoryEvictions(), 0);
  e.writeBatch({
    magnets: [mk(H1), mk(H2), mk(H3)],
    sources: [src(H1, 'bludv'), src(H1, 'nerdfilmes')],
    works: [work(H1, 'tt111')],
  });
  assert.equal(e.countMagnets(), 3, 'teto de 1 não alcança o SQLite');
  assert.equal(e.countSources(), 2);
  assert.equal(e.countWorks(), 1);
  const stats = e.stats();
  assert.equal(stats.memoryMax, null);
  assert.equal(stats.memoryEvictions, 0);
  const kept = e.getMagnet(H1);
  assert.ok(kept, 'H1 permanece no acervo');
  assert.equal(kept.hash, H1);
  rows.resetForTests();
});
