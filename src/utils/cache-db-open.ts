/**
 * Abertura do banco SQLite do cache com recuperação de corrupção. Extraído do
 * cache-db.ts só para caber na catraca de 400 linhas: é o único trecho que
 * toca no arquivo do volume antes de haver statements, e não conhece o estado
 * da fábrica de persistência — recebe o caminho e devolve o handle ou throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as log from './logger.js';

const _require = createRequire(import.meta.url);

function initDb(DatabaseSync: any, dbPath: string) {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
    `);
    return database;
  } catch (err) {
    try { database.close(); } catch {}
    throw err;
  }
}

// Só corrupção REAL autoriza o rename destrutivo — o banco é dado persistido
// em volume. SQLITE_BUSY (segunda instância compartilhando o volume), stall
// de I/O ou EACCES pontual são transientes: renomear aqui apagaria cache vivo
// por um glitch. Cobre errcode nativo (node:sqlite expõe errcode/errstr) e
// mensagem, porque a forma do erro varia entre versões do runtime.
function isCorruptionError(err: any) {
  const code = String(err?.errcode || err?.code || '').toUpperCase();
  if (/SQLITE_(CORRUPT|NOTADB)/.test(code)) return true;
  return /malformed|not a database|encrypted/i.test(String(err?.message || ''));
}

export function openWithRecovery(dbPath: string): any {
  // node:sqlite é experimental no Node 22 — se o runtime não tiver, seguimos
  // só em memória em vez de derrubar o addon. O require é LAZY de propósito:
  // no Node 20 o módulo não existe, e um import estático derrubaria o addon
  // inteiro no carregamento.
  const { DatabaseSync } = _require('node:sqlite');
  try {
    return initDb(DatabaseSync, dbPath);
  } catch (initialErr: unknown) {
    // Erro transiente/ambiente NÃO toca no arquivo do volume: quem chama cai
    // em memória e a próxima subida tenta de novo.
    if (!isCorruptionError(initialErr)) throw initialErr;
    if (fs.existsSync(dbPath)) {
      const corruptPath = `${dbPath}.corrupt`;
      try {
        if (fs.existsSync(corruptPath)) {
          fs.unlinkSync(corruptPath);
        }
        fs.renameSync(dbPath, corruptPath);
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${dbPath}${suffix}`;
          if (fs.existsSync(sidecar)) {
            try { fs.unlinkSync(sidecar); } catch {}
          }
        }
        log.warn(`[cache] banco SQLite corrompido; renomeado para ${path.basename(corruptPath)} e recriando banco limpo`);
        return initDb(DatabaseSync, dbPath);
      } catch (recoverErr: unknown) {
        log.warn('[cache] falha na recuperação do banco corrompido:', log.errorMessage(recoverErr));
        throw initialErr;
      }
    } else {
      throw initialErr;
    }
  }
}
