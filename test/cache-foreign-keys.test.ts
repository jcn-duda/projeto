// Dono único no MESMO cache.db: `idx` (IdxStore) e o prefixo `raw:v1:bludv:`
// (gateway no `/stream`) não podem ter o Node como segundo escritor. Sem a
// guarda, o `get` expirado do L1 chama `forget` e o DELETE apaga a linha fresca
// que o Rust acabou de gravar — e o boot seguinte sobe a cópia velha.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
// Query única: o cache.ts é dono do estado mutável e a closure do cache-db
// nasce a cada import; os filhos (cache-db) ficam compartilhados.
const openCache = (tag: string): Promise<any> =>
  import(`${CACHE_URL}?${tag}=${Date.now()}-${cacheSeq++}`);

test('raw:v1:bludv é do gateway; raw:v1:jackett e idx seguem o contrato do Node', {
  skip: !hasNodeSqlite && 'node:sqlite ausente',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-foreign-'));
  const dbPath = path.join(tempDir, 'cache.db');
  const savedDb = process.env.CACHE_DB_PATH;
  const savedPersist = process.env.CACHE_PERSIST;
  // O setup-env pina CACHE_PERSIST=false: este caso precisa do arquivo real.
  process.env.CACHE_DB_PATH = dbPath;
  process.env.CACHE_PERSIST = 'true';
  try {
    // Primeira instância só para o openWithRecovery criar o schema.
    const seed = await openCache('seed');
    seed.close();

    const { DatabaseSync } = await import('node:sqlite');
    const expiry = Date.now() + 3_600_000;
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
    insert.run('raw:v1:bludv:d:matrix', JSON.stringify({ items: ['gateway'] }), expiry);
    insert.run('raw:v1:jackett:bludv:movie:matrix', JSON.stringify({ items: ['node'] }), expiry);
    insert.run('idx:v14:tt0133093', JSON.stringify({ rows: [] }), expiry);
    db.close();

    const cache = await openCache('fresh');
    assert.equal(cache.peek('raw:v1:bludv:d:matrix'), null, 'linha do gateway não sobe no L1');
    assert.deepEqual(cache.get('raw:v1:jackett:bludv:movie:matrix'), { items: ['node'] });
    assert.equal(cache.get('idx:v14:tt0133093'), null, 'idx continua sem L1');

    cache.forget('raw:v1:bludv:d:matrix');
    cache.set('raw:v1:bludv:d:novo', { items: ['node'] }, 600);
    assert.equal(cache.has('raw:v1:bludv:d:novo'), false, 'set do Node recusa a chave do gateway');
    cache.close();

    const db2 = new DatabaseSync(dbPath);
    const rows = db2
      .prepare("SELECT key FROM cache WHERE key LIKE 'raw:v1:bludv:%' ORDER BY key")
      .all() as { key: string }[];
    db2.close();
    assert.deepEqual(
      rows.map((row) => row.key),
      ['raw:v1:bludv:d:matrix'],
      'nem forget nem set do Node tocam o L2 do gateway',
    );
  } finally {
    if (savedDb === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = savedDb;
    if (savedPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = savedPersist;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
