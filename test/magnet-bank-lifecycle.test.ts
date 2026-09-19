// Banco de magnets vivo — CICLO DE VIDA E ENGINE.
//
// Fila assíncrona, kill-switch, métricas, fallback de engine e rollback: o que
// não é regra de merge nem semântica de `passed_filter`. Mesmo isolamento do
// magnet-bank.test.ts (engine em memória via diretório; SQLite só quando o
// módulo existe).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'magnet-bank-life-'));
const hex = (c: string) => c.repeat(40);
const magnet = (h: string, extra = '') => `magnet:?xt=urn:btih:${h}${extra}`;

beforeEach(() => {
  bank.resetForTests();
  // Diretório como caminho: o SQLite não abre e o engine de memória assume.
  bank.open(FRESH_DIR());
  metrics.reset();
  config.magnetBank.enabled = true;
  config.magnetBank.queueMax = 500;
});

after(() => {
  bank.resetForTests();
});

test('captureItems não escreve sincronamente; setImmediate drena', async () => {
  const h = hex('e');
  bank.captureItems([{ title: 'A', infoHash: h, magnet: magnet(h) }], 'x', {});
  assert.equal(bank.lookup(h), null, 'nada gravado no mesmo tick da captura');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bank.lookup(h)?.hash, h, 'o agendador drena no próximo tick');
});

test('fila cheia descarta a leva e conta magnetbank.queue.dropped', () => {
  const prevMax = config.magnetBank.queueMax;
  config.magnetBank.queueMax = 1;
  try {
    bank.captureItems([{ title: 'A', infoHash: hex('1') }], 'a', {});
    bank.captureItems([{ title: 'B', infoHash: hex('2') }], 'b', {});
    assert.equal(metrics.snapshot().counters['magnetbank.queue.dropped'], 1);
    bank.flushNow();
    assert.equal(bank.lookup(hex('1'))?.hash, hex('1'), 'a primeira leva é gravada');
    assert.equal(bank.lookup(hex('2')), null, 'a descartada não é gravada');
  } finally {
    config.magnetBank.queueMax = prevMax;
  }
});

test('kill-switch: captura e filtro no-op com enabled=false', () => {
  const h = hex('4');
  config.magnetBank.enabled = false;
  bank.captureItems([{ title: 'K', infoHash: h, magnet: magnet(h) }], 'x', { imdbId: 'tt902' });
  bank.markFilterResult([h], [h], { imdbId: 'tt902' });
  bank.flushNow();
  assert.equal(bank.lookup(h), null, 'banco desligado não grava');
});

test('enabled=false não abre SQLite à toa (status/lookup neutros)', () => {
  const prevPath = config.magnetBank.dbPath;
  const dbPath = path.join(FRESH_DIR(), 'nunca-abre.db');
  bank.resetForTests();
  config.magnetBank.enabled = false;
  config.magnetBank.dbPath = dbPath;
  try {
    assert.equal(bank.status().engine, 'disabled');
    assert.equal(bank.lookup(hex('3')), null);
    assert.equal(fs.existsSync(dbPath), false, 'nenhum arquivo criado com o banco desligado');
  } finally {
    config.magnetBank.dbPath = prevPath;
    config.magnetBank.enabled = true;
  }
});

test('openIfEnabled: boot só abre o banco com o kill-switch ligado', () => {
  const prevPath = config.magnetBank.dbPath;
  const dbPath = path.join(FRESH_DIR(), 'boot.db');
  bank.resetForTests();
  config.magnetBank.dbPath = dbPath;
  try {
    config.magnetBank.enabled = false;
    bank.openIfEnabled();
    assert.equal(bank.status().engine, 'disabled');
    assert.equal(fs.existsSync(dbPath), false, 'desligado não cria SQLite');
    assert.equal(fs.existsSync(`${dbPath}-wal`), false, 'nem WAL');

    config.magnetBank.enabled = true;
    bank.openIfEnabled();
    assert.notEqual(bank.status().engine, 'disabled', 'ligado abre o banco');
  } finally {
    bank.resetForTests();
    config.magnetBank.dbPath = prevPath;
    config.magnetBank.enabled = true;
  }
});

test('resetPassedFilter: coleta viva reseta; captura de fundo preserva', () => {
  const ctxLive = { imdbId: 'tt950', season: null, episode: null, resetPassedFilter: true };
  const ctxBackground = { imdbId: 'tt950', season: null, episode: null };
  const h = hex('a');
  const item = { title: 'Filme Teste', infoHash: h, magnet: magnet(h) };

  // Coleta viva + filtro: 1.
  bank.captureItems([item], 'jackett', ctxLive);
  bank.markFilterResult([h], [h], ctxLive);
  bank.flushNow();
  assert.equal(bank.worksFor(h)[0].passedFilter, 1);

  // Colhedor/varredura de fundo capturam a MESMA obra: preservam o 1 (não
  // rodam o filtro do stream-builder).
  bank.captureItems([item], 'indexer-fundo', ctxBackground);
  bank.flushNow();
  assert.equal(bank.worksFor(h)[0].passedFilter, 1, 'fundo preserva a última avaliação');

  // Coleta viva sem filtro: nova observação = 0.
  bank.captureItems([item], 'jackett', ctxLive);
  bank.flushNow();
  assert.equal(bank.worksFor(h)[0].passedFilter, 0, 'viva reseta para 0');

  // Fundo de obra AUSENTE cria 0 (não inventa 1).
  const novo = hex('b');
  bank.captureItems([{ title: 'N', infoHash: novo, magnet: magnet(novo) }], 'indexer-fundo', ctxBackground);
  bank.flushNow();
  assert.equal(bank.worksFor(novo)[0].passedFilter, 0, 'fundo cria 0 quando ausente');
});

test('failNextWrite não atravessa lote vazio', () => {
  bank.failNextWriteForTests();
  bank.flushNow(); // fila vazia: o gatilho não pode ficar armado
  const h = hex('f');
  bank.captureItems([{ title: 'Ok', infoHash: h, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)?.title, 'Ok', 'o gatilho desarmado não derruba a escrita seguinte');
  assert.equal(metrics.snapshot().counters['magnetbank.flush.failed'], undefined);
});

test('métricas: magnetbank.upsert e magnetbank.engine.* por engine', () => {
  bank.captureItems([{ title: 'M', infoHash: hex('2'), magnet: magnet(hex('2')) }], 'x', {});
  bank.flushNow();
  const counters = metrics.snapshot().counters;
  assert.equal(counters['magnetbank.upsert'], 1);
  assert.equal(counters['magnetbank.engine.memory'], 1);
  assert.equal(counters['magnetbank.flush.failed'], undefined);
});

test('falha de escrita conta magnetbank.flush.failed e não aplica parcial (memória)', () => {
  const h = hex('1');
  bank.captureItems([{ title: 'F', infoHash: h, magnet: magnet(h) }], 'x', {});
  bank.failNextWriteForTests();
  bank.flushNow();
  assert.equal(metrics.snapshot().counters['magnetbank.flush.failed'], 1);
  assert.equal(bank.lookup(h), null, 'a leva que falhou não gravou');
  bank.captureItems([{ title: 'F', infoHash: h, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)?.title, 'F', 'a próxima leva grava normal');
});

test('engine cai em memória quando o SQLite não abre (caminho é diretório)', () => {
  bank.resetForTests();
  bank.open(FRESH_DIR());
  assert.equal(bank.status().engine, 'memory');
  const h = hex('a');
  bank.captureItems([{ title: 'M', infoHash: h, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)?.hash, h, 'a memória segura o registro');
});

test('engine de memória forçada grava e lê', () => {
  bank.resetForTests();
  bank.open(FRESH_DIR(), { forceMemory: true });
  assert.equal(bank.status().engine, 'memory');
  const h = hex('8');
  bank.captureItems([{ title: 'Forcada', infoHash: h, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)?.title, 'Forcada');
});

test(
  'engine SQLite: schema, transação em lote, leitura e rollback com falha injetada',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    bank.resetForTests();
    bank.open(path.join(FRESH_DIR(), 'magnets.db'));
    assert.equal(bank.status().engine, 'sql');

    const keep = hex('4');
    const fail = hex('5');
    bank.captureItems([
      { title: 'SQL', infoHash: keep, size: 10, seeders: 2, magnet: magnet(keep, '&dn=SQL') },
    ], 'SQL-Indexer', { imdbId: 'tt333', season: 2, episode: 1 });
    bank.markFilterResult([keep], [keep], { imdbId: 'tt333', season: 2, episode: 1 });
    bank.flushNow();

    assert.equal(bank.lookup(keep)?.title, 'SQL');
    assert.equal(bank.sourcesFor(keep)[0].indexer, 'sql-indexer', 'indexer em minúsculo');
    assert.equal(bank.findByWork('tt333', 2, 1)[0].work.passedFilter, 1);
    assert.equal(bank.findByIndexer('sql-indexer').length, 1);

    // Rollback: a leva falha no meio da transação e NADA é aplicado — nem o
    // registro novo, nem a alteração do que já existia.
    bank.captureItems([{ title: 'Vai falhar', infoHash: fail, magnet: magnet(fail) }], 'x', {});
    bank.captureItems([{ title: 'SQL', infoHash: keep, quality: '2160p', magnet: magnet(keep) }], 'x', {});
    bank.failNextWriteForTests();
    bank.flushNow();
    assert.equal(metrics.snapshot().counters['magnetbank.flush.failed'], 1);
    assert.equal(bank.lookup(fail), null, 'linha nova não entrou');
    assert.equal(bank.lookup(keep)?.quality, '', 'linha anterior intacta após o ROLLBACK');

    bank.resetForTests();
  },
);
