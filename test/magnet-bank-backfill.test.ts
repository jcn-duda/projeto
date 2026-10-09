// `dubbed`/`quality` do banco vivo: a captura classifica pelo título e a
// migração preenche o acervo gravado vazio (182 mil magnets, 2026-09-30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inputFromItem, classifiedDubbed } from '../src/utils/magnet-bank-merge.js';
import { backfillClassification } from '../src/utils/magnet-bank-backfill.js';

const _require = createRequire(import.meta.url);
const hex = (c: string) => c.repeat(40);
let sqlite: any = null;
try { sqlite = _require('node:sqlite'); } catch { /* Node 20 */ }

test('captura: dubbed e quality saem do título, com a régua do índice', () => {
  const br = inputFromItem({ title: 'Coringa (2019) [1080p BLURAY DUBLADO]', infoHash: hex('a'), isBr: true } as any, 'comandotorrents');
  assert.equal(br?.magnet.dubbed, true);
  assert.equal(br?.magnet.quality, '1080p');
  // DUAL de cena gringa não é dublagem fora de site BR.
  const gringo = inputFromItem({ title: 'Joker.2019.2160p.WEB-DL.DUAL.5.1', infoHash: hex('b') } as any, 'therarbg');
  assert.equal(gringo?.magnet.dubbed, false);
  assert.equal(gringo?.magnet.quality, '2160p');
  assert.equal(classifiedDubbed('Joker 2019 1080p Dublado PT-BR', false), true);
});

test('migração: preenche o vazio, não rebaixa dublado, e a segunda passada é no-op', { skip: !sqlite }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbb-')), 'magnets.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE magnet (hash TEXT PRIMARY KEY, uri TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    is_br INTEGER NOT NULL DEFAULT 0, dubbed INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL DEFAULT '')`);
  const ins = db.prepare('INSERT INTO magnet (hash, title, is_br, dubbed, quality) VALUES (?, ?, ?, ?, ?)');
  ins.run(hex('1'), 'Coringa (2019) [720p WEB-DL DUBLADO]', 1, 0, '');
  ins.run(hex('2'), 'Joker.2019.1080p.WEB-DL.DUAL', 0, 0, '');
  ins.run(hex('3'), 'Algo sem nada', 0, 1, ''); // marca antiga não pode cair
  ins.run(hex('4'), 'Já preenchido 2160p', 0, 0, '2160p');
  db.close();

  const first = await backfillClassification(file, 2); // lote pequeno: cruza a paginação
  assert.deepEqual(first, { updated: 3, ok: true });
  const check = new sqlite.DatabaseSync(file);
  const rows = Object.fromEntries(check.prepare('SELECT hash, dubbed, quality FROM magnet').all()
    .map((r: any) => [r.hash[0], [r.dubbed, r.quality]]));
  check.close();
  assert.deepEqual(rows['1'], [1, '720p']);
  assert.deepEqual(rows['2'], [0, '1080p']);
  assert.deepEqual(rows['3'], [1, 'sem resolução']);
  assert.deepEqual(rows['4'], [0, '2160p']);
  assert.deepEqual(await backfillClassification(file), { updated: 0, ok: true });
  // A busca das pendentes vai pelo índice parcial — sem ele, todo boot varria
  // a tabela inteira (330 MB local: ~5 min com o processo travado).
  const plan = new sqlite.DatabaseSync(file);
  const detail = plan.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM magnet WHERE quality = '' AND rowid > ? ORDER BY rowid LIMIT ?")
    .all(0, 500).map((r: any) => r.detail).join(' ');
  plan.close();
  assert.match(detail, /magnet_quality_pending/);
});
