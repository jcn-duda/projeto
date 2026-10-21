import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

test(
  'boot e forget do Node não apagam idx no disco',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível' },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-idx-owner-'));
    const dbPath = path.join(tempDir, 'cache.db');
    const script = [
      "import assert from 'node:assert/strict';",
      "import { DatabaseSync } from 'node:sqlite';",
      `const cacheUrl = ${JSON.stringify(CACHE_URL)};`,
      'const dbPath = process.env.CACHE_DB_PATH;',
      'const far = Date.now() + 900000;',
      'const seed = new DatabaseSync(dbPath);',
      "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
      "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
      "insert.run('idx:v14:tt-vivo', JSON.stringify({ ok: 1 }), far);",
      "insert.run('idx:v13:tt-morto', JSON.stringify({ ok: 1 }), far);",
      "insert.run('idx:v14:tt-expirado', JSON.stringify({ ok: 1 }), 1);",
      'seed.close();',
      `const cache = await import(cacheUrl);`,
      "assert.equal(cache.get('idx:v14:tt-vivo'), null, 'idx não sobe no L1');",
      "cache.forget('idx:v14:tt-vivo');",
      'const verify = new DatabaseSync(dbPath);',
      "const vivo = verify.prepare('SELECT key FROM cache WHERE key = ?').get('idx:v14:tt-vivo');",
      "const morto = verify.prepare('SELECT key FROM cache WHERE key = ?').get('idx:v13:tt-morto');",
      "const expirado = verify.prepare('SELECT key FROM cache WHERE key = ?').get('idx:v14:tt-expirado');",
      "assert.ok(vivo, 'vivo não foi apagado no boot nem no forget');",
      "assert.ok(morto, 'versão velha fica para o open do Rust');",
      "assert.ok(expirado, 'expirado fica para o open do Rust');",
      'verify.close();',
      'cache.close();',
    ].join('\n');
    try {
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: (({ CACHE_PERSIST, ...resto }) => ({ ...resto, CACHE_DB_PATH: dbPath }))(process.env),
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(res.status, 0, res.stdout + res.stderr);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
