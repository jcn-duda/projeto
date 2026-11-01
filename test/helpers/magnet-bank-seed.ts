// Semente do banco de magnets vivo para os testes da ponte napi. A captura TS
// (fachada `magnet-bank.ts`) saiu no corte da família — quem grava o acervo é
// o gateway — e o teste INSERTa direto no SQLite que a ponte lê. A primeira
// consulta pela ponte já cria o arquivo com o schema (`MagnetBankStore::open`
// roda CREATE TABLE IF NOT EXISTS); o INSERT segue por `node:sqlite` no MESMO
// arquivo. Node 20 não tem `node:sqlite`: `hasNodeSqlite` é o guard de skip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import config from '../../src/config.js';
import { bankLookupUriNative } from '../../src/utils/magnet-bank-native.js';
import { assertSafeTestDb } from './db-guard.js';

// O `magnets.db` vivo tem default no VOLUME real: sem setup-env, a ponte
// abriria o acervo da máquina. Recusa antes de qualquer abertura.
assertSafeTestDb('magnet-bank-seed');

const _require = createRequire(import.meta.url);

export const hasNodeSqlite = (() => {
  try { _require('node:sqlite'); return true; } catch { return false; }
})();

export const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bank-seed-'));

/** Aponta `config.magnetBank` para o arquivo e o CRIA pela ponte (schema). */
export function openBankSchema(dbPath: string): void {
  config.magnetBank.dbPath = dbPath;
  config.magnetBank.enabled = true;
  // Primeira consulta pela ponte: abre o arquivo, roda o schema e é descartada.
  bankLookupUriNative('0'.repeat(40));
}

/** Uma linha de `magnet` para o INSERT (colunas ausentes ficam no default do schema). */
export interface SeedMagnet {
  hash: string;
  uri: string;
  title?: string;
  size?: number;
  isBr?: boolean;
  dubbed?: boolean;
  quality?: string;
  seedersMax?: number;
  /** null = sem medição ainda (o schema guarda 0). */
  seedersLast?: number | null;
  firstSeen?: number;
  lastSeen?: number;
  lied?: boolean;
}

/** INSERT direto no arquivo que a ponte abre por chamada (mesmo caminho). */
export function insertMagnet(dbPath: string, row: SeedMagnet): void {
  const { DatabaseSync } = _require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      'INSERT OR REPLACE INTO magnet (hash, uri, title, size, is_br, dubbed, quality,'
      + ' seeders_max, seeders_last, first_seen, last_seen, lied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.hash.toLowerCase(),
      row.uri,
      row.title ?? '',
      row.size ?? 0,
      row.isBr ? 1 : 0,
      row.dubbed ? 1 : 0,
      row.quality ?? '',
      row.seedersMax ?? 0,
      row.seedersLast ?? 0,
      row.firstSeen ?? 1000,
      row.lastSeen ?? 2000,
      row.lied ? 1 : 0,
    );
  } finally {
    db.close();
  }
}
