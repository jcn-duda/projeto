// Etapa 5 — agregação de status do banco vivo: totais, por indexer, último
// visto, memo do poll (TTL/invalidação) e o kill-switch que não abre disco.
// A BUSCA (hash/título/wildcard/cap) mora em `magnet-bank-search.test.ts`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import {
  FRESH_DIR, H1, H2, H3, hasNodeSqlite, openMemory, openSql, seed, sleeper, worksTotal, restoreConfig, hexHash,
} from './helpers/magnet-bank-fixture.js';

after(restoreConfig);

test('status agrega totais, por indexer (hashes distintos) e último visto global', () => {
  openMemory();
  seed();

  const status = bank.status();
  assert.equal(status.enabled, true);
  assert.equal(status.engine, 'memory');
  assert.equal(status.magnets, 3, 'magnet table conta torrents distintos');
  assert.equal(status.sources, 4, 'uma fonte por indexer × hash');
  assert.equal(status.works, worksTotal());
  assert.ok(status.works >= 3, 'cada hash gerou obra');
  assert.equal(
    status.lastSeen,
    Math.max(bank.lookup(H1)!.lastSeen, bank.lookup(H2)!.lastSeen, bank.lookup(H3)!.lastSeen),
    'último visto global é o máximo observado',
  );

  const byId = new Map(status.byIndexer.map((row) => [row.indexer, row]));
  assert.equal(byId.get('bludv')!.hashes, 3, 'H1, H2 e H3 são hashes distintos do bludv');
  assert.equal(byId.get('bludv')!.sources, 3);
  assert.equal(byId.get('nerdfilmes')!.hashes, 1);
  assert.equal(byId.get('nerdfilmes')!.sources, 1);
  assert.ok(byId.get('nerdfilmes')!.lastSeen > 0);
  assert.equal(status.byIndexer[0].indexer, 'bludv', 'mais recente primeiro (empate por id)');
});

test('status é memoizado por TTL, invalidado por escrita e desligável com 0', async () => {
  openMemory();
  seed();

  // Memo ligado (default 60s): polls repetidos recebem a MESMA foto.
  config.magnetBank.statusTtlMs = 60000;
  const a = bank.status();
  const b = bank.status();
  assert.equal(a, b, 'dentro do TTL não recalcula stats');

  // Escrita efetiva invalida: captura nova + flush muda os totais.
  bank.captureItems([
    { title: 'Novo Magnet', infoHash: hexHash('f', '6'), magnet: `magnet:?xt=urn:btih:${hexHash('f', '6')}` },
  ], 'bludv', {});
  bank.flushNow();
  const c = bank.status();
  assert.notEqual(c, a, 'flush derruba o memo');
  assert.equal(c.magnets, a.magnets + 1, 'a foto nova enxerga a escrita');

  // TTL vencido: recalcula mesmo sem escrita.
  config.magnetBank.statusTtlMs = 1;
  const d = bank.status();
  await sleeper();
  const e = bank.status();
  assert.notEqual(e, d, 'após o TTL a leitura recalcula');

  // 0 desliga o memo: toda leitura é uma foto nova.
  config.magnetBank.statusTtlMs = 0;
  assert.notEqual(bank.status(), bank.status());
});

test('banco desligado responde vazio e NÃO cria o SQLite', () => {
  const dir = FRESH_DIR();
  const dbPath = path.join(dir, 'magnets.db');
  const savedDbPath = config.magnetBank.dbPath;
  config.magnetBank.dbPath = dbPath;
  config.magnetBank.enabled = false;
  bank.resetForTests();
  try {
    const status = bank.status();
    assert.equal(status.engine, 'disabled');
    assert.equal(status.magnets, 0);
    assert.deepEqual(status.byIndexer, []);

    // Kill-switch de verdade: status não abre disco com o banco off.
    assert.equal(fs.existsSync(dbPath), false, 'MAGNET_BANK=false não cria o arquivo');
  } finally {
    config.magnetBank.enabled = true;
    config.magnetBank.dbPath = savedDbPath;
  }
});

test('engine SQL resolve a MESMA agregação', { skip: !hasNodeSqlite }, () => {
  openSql();
  seed();
  assert.equal(bank.status().engine, 'sql');

  const status = bank.status();
  assert.equal(status.magnets, 3);
  assert.equal(status.sources, 4);
  assert.equal(status.works, worksTotal());
  const byId = new Map(status.byIndexer.map((row) => [row.indexer, row]));
  assert.equal(byId.get('bludv')!.hashes, 3);
  assert.equal(byId.get('nerdfilmes')!.sources, 1);
  assert.equal(status.byIndexer[0].indexer, 'bludv');
});
