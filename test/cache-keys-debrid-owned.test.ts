// Posse dos namespaces de debrid (T2-L5b): `davail:v1` e `mag:v1` passaram a
// ser do núcleo Rust (`DavailStore`/`MagnetStateStore` no `adom-index`). O Node
// não pode ser segundo escritor no MESMO `cache.db`: um `forget` do L1 apagaria
// a linha fresca do núcleo, e o Rust leria o resultado como cache frio.
//
// Dois invariantes:
// 1. `cache.set`/`forget`/`forgetMany` com chave `davail:`/`mag:` são no-op — nem
//    no L1, nem no SQLite.
// 2. A guarda de hash do TS (`isSupportedHash`) é a MESMA do núcleo: chave que o
//    núcleo recusa nunca nasce, então uma guarda mais frouxa no TS criaria
//    contador para linha que a enumeração não lê de volta.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSupportedHash } from '../src/utils/magnetdb-counts.js';
import { RUST_OWNED, RUST_OWNED_PREFIXES, isForeignKey, isRustOwned, prefix } from '../src/utils/cache-keys.js';

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
const openCache = (tag: string): Promise<any> =>
  import(`${CACHE_URL}?${tag}=${Date.now()}-${cacheSeq++}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.existsSync(path.join(here, '..', 'src', 'utils', 'cache.ts'))
  ? path.join(here, '..')
  : path.join(here, '..', '..');

test('davail e mag são RUST_OWNED por namespace e por prefixo', () => {
  for (const ns of ['idx', 'streams', 'raw', 'davail', 'mag']) {
    assert.ok(RUST_OWNED.includes(ns), `${ns} é dono único do núcleo`);
    assert.equal(isRustOwned(ns), true, `isRustOwned reconhece ${ns}`);
  }
  for (const owned of [prefix('harvest'), prefix('davail'), prefix('mag')]) {
    assert.ok(
      RUST_OWNED_PREFIXES.includes(owned),
      `${owned} bloqueia a leitura do L1 (sem o prefixo, o get devolveria o L1 vazio em vez da ponte)`,
    );
    assert.equal(isForeignKey(`${owned}alive:premiumize:x:${'a'.repeat(40)}`), true);
  }
  // Namespace do Node continua visível para o cache.
  assert.equal(isRustOwned('meta'), false);
  assert.equal(isForeignKey(`meta:movie:tt1`), false);
});

test('set/forget do Node não tocam o L2 de davail/mag', {
  skip: !hasNodeSqlite && 'node:sqlite ausente',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-debrid-owned-'));
  const dbPath = path.join(tempDir, 'cache.db');
  const savedDb = process.env.CACHE_DB_PATH;
  const savedPersist = process.env.CACHE_PERSIST;
  // O setup-env pina CACHE_PERSIST=false: este caso precisa do arquivo real.
  process.env.CACHE_DB_PATH = dbPath;
  process.env.CACHE_PERSIST = 'true';
  try {
    const seed = await openCache('seed');
    seed.close();

    const { DatabaseSync } = await import('node:sqlite');
    const expiry = Date.now() + 3_600_000;
    const hash = 'a'.repeat(40);
    const davailKey = `${prefix('davail')}premiumize:conta:${hash}`;
    const magKey = `${prefix('mag')}alive:premiumize:conta:${hash}`;
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
    insert.run(davailKey, '1', expiry);
    insert.run(magKey, '"1"', expiry);
    db.close();

    const cache = await openCache('fresh');
    assert.equal(cache.peek(davailKey), null, 'davail não sobe no L1');
    assert.equal(cache.get(magKey), null, 'mag não sobe no L1');
    assert.equal(cache.snapshot().namespaces.davail, undefined, 'balde davail não é montado no Node');
    assert.equal(cache.snapshot().namespaces.mag, undefined, 'balde mag não é montado no Node');

    cache.forget(davailKey);
    cache.forgetMany([magKey]);
    cache.set(`${prefix('davail')}premiumize:conta:${'b'.repeat(40)}`, 1, 600);
    cache.set(`${prefix('mag')}alive:premiumize:conta:${'b'.repeat(40)}`, '"1"', 600);
    assert.equal(cache.has(`${prefix('davail')}premiumize:conta:${'b'.repeat(40)}`), false, 'set do Node recusa davail');
    assert.equal(cache.has(`${prefix('mag')}alive:premiumize:conta:${'b'.repeat(40)}`), false, 'set do Node recusa mag');
    cache.close();

    const db2 = new DatabaseSync(dbPath);
    const rows = db2
      .prepare("SELECT key FROM cache WHERE key LIKE 'davail:%' OR key LIKE 'mag:%' ORDER BY key")
      .all() as { key: string }[];
    db2.close();
    assert.deepEqual(rows.map((row) => row.key), [davailKey, magKey].sort(), 'nem forget nem set do Node tocam o L2 do núcleo');
  } finally {
    if (savedDb === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = savedDb;
    if (savedPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = savedPersist;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isSupportedHash é a MESMA guarda de 40 hex do núcleo', () => {
  // O corpo da guarda é lido do fonte do Rust: uma guarda mais frouxa no TS cria
  // contador durável para chave que a enumeração do núcleo nunca lê de volta.
  const fonte = fs.readFileSync(path.join(root, 'rust', 'crates', 'adom-index', 'src', 'magnet_state.rs'), 'utf8');
  const corpo = /fn is_valid_hash\(hash: &str\) -> bool \{([\s\S]*?)\n\}/.exec(fonte)?.[1] ?? '';
  assert.match(corpo, /len\(\)\s*==\s*40/, 'a guarda exige 40 caracteres');
  assert.match(corpo, /b'a'\.\.=b'f'/, 'a guarda aceita só hex minúsculo');
  assert.match(corpo, /b'0'\.\.=b'9'/, 'a guarda aceita dígitos');

  assert.equal(isSupportedHash('a'.repeat(40)), true, '40 hex minúsculos é hash válido');
  assert.equal(isSupportedHash('A'.repeat(40)), true, 'maiúsculas são aceitas (o núcleo normaliza)');
  assert.equal(isSupportedHash('a'.repeat(39)), false, '39 hex não é hash');
  assert.equal(isSupportedHash('a'.repeat(41)), false, '41 hex não é hash');
  assert.equal(isSupportedHash('g'.repeat(40)), false, 'hex fora de a-f não é hash');
  assert.equal(isSupportedHash('merge-pos'), false, 'rótulo de teste não é hash');
  assert.equal(isSupportedHash(''), false, 'vazio não é hash');
});
