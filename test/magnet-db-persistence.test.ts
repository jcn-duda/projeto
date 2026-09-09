import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let hasNodeSqlite = true;
try {
  _require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const CACHE_MODULE = _require.resolve('../src/utils/cache.js');
const MAGNETDB_MODULE = _require.resolve('../src/utils/magnetdb.js');
const CACHE_KEYS_MODULE = _require.resolve('../src/utils/cache-keys.js');

function runMultiStageTest(scripts: string[]) {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-mag-persist-test-'));
  const dbPath = path.join(tempDir, 'cache.db');
  try {
    for (const scriptContent of scripts) {
      const res = spawnSync(process.execPath, ['-e', scriptContent], {
        env: (({ CACHE_PERSIST, ...resto }) => ({ ...resto, CACHE_DB_PATH: dbPath }))(process.env),
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.ifError(res.error);
      assert.strictEqual(
        res.status,
        0,
        'Falha na execução do subprocesso de teste:\n' + res.stdout + res.stderr,
      );
    }
  } finally {
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test(
  'persistência dos contadores no disco (mag_meta:v1:counts salvo no SQLite com idempotência)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const script = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      "const { DatabaseSync } = require('node:sqlite');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      `const { magMetaCountsKey } = require(${JSON.stringify(CACHE_KEYS_MODULE)});`,
      "",
      "magnetdb.markAlive('premiumize', 'acc1', ['hash1', 'hash2']);",
      "magnetdb.markBad('torbox', 'acc2', 'hash3');",
      "magnetdb.markLie('alldebrid', 'acc3', 'hash4');",
      "// Idempotência: reinserção e renew não podem duplicar contadores",
      "magnetdb.markAlive('premiumize', 'acc1', ['hash1']);",
      "magnetdb.renewAlive('premiumize', 'acc1', ['hash2']);",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
      "",
      "const db = new DatabaseSync(process.env.CACHE_DB_PATH);",
      "const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(magMetaCountsKey());",
      "assert.ok(row, 'chave mag_meta:v1:counts presente no banco SQLite');",
      "const data = JSON.parse(row.value);",
      "assert.strictEqual(data.version, 1);",
      "assert.strictEqual(data.adapters.premiumize.alive, 2);",
      "assert.strictEqual(data.adapters.torbox.bad, 1);",
      "assert.strictEqual(data.adapters.alldebrid.lie, 1);",
      "db.close();",
    ].join('\n');

    runMultiStageTest([script]);
  },
);
test(
  'reinício do processo: status() durável restaurado com byAdapter e sem scans no SQLite',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "magnetdb.markAlive('premiumize', 'acc1', ['h1', 'h2', 'h3']);",
      "magnetdb.markBad('realdebrid', 'acc2', 'h4');",
      "magnetdb.markLie('premiumize', 'acc1', 'h5');",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      "const { DatabaseSync } = require('node:sqlite');",
      "const origPrepare = DatabaseSync.prototype.prepare;",
      "DatabaseSync.prototype.prepare = function(sql) {",
      "  if (typeof sql === 'string' && (sql.includes(\"LIKE 'mag:%\") || sql.includes('LIKE \"mag:%\"'))) {",
      "    throw new Error('Full table scan proibido em mag:* detectado: ' + sql);",
      "  }",
      "  return origPrepare.apply(this, arguments);",
      "};",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const t0 = performance.now();",
      "const st = magnetdb.status();",
      "const durationMs = performance.now() - t0;",
      "assert.ok(durationMs < 50, 'status() executou em O(1) em ' + durationMs + 'ms');",
      "assert.strictEqual(st.sizeAlive, 3, 'sizeAlive restaurado');",
      "assert.strictEqual(st.sizeBad, 1, 'sizeBad restaurado');",
      "assert.strictEqual(st.sizeLie, 1, 'sizeLie restaurado');",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 3);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeLie, 1);",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeBad, 1);",
      "assert.strictEqual(st._origem.sizeAlive, 'duravel');",
      "assert.strictEqual(st._origem.sizeBad, 'duravel');",
      "assert.strictEqual(st._origem.sizeLie, 'duravel');",
      "assert.strictEqual(st._origem.byAdapter, 'duravel');",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'substituição: bad sobre alive decrementa alive e incrementa bad, sobrevivendo ao restart',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "magnetdb.markAlive('premiumize', 'acc1', ['hash-swap']);",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 1);",
      "assert.strictEqual(st.sizeBad, 0);",
      "magnetdb.markBad('premiumize', 'acc1', 'hash-swap');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'alive decrementado');",
      "assert.strictEqual(st.sizeBad, 1, 'bad incrementado');",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'alive persiste 0 apos restart');",
      "assert.strictEqual(st.sizeBad, 1, 'bad persiste 1 apos restart');",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 1);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'deleção: forgetBad decrementa bad de forma durável',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "magnetdb.markBad('torbox', 'acc1', 'bad-1');",
      "magnetdb.markBad('torbox', 'acc1', 'bad-2');",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 2);",
      "magnetdb.forgetBad('torbox', 'acc1', 'bad-1');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1, 'bad decrementado no esquecimento');",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1, 'bad mantem 1 apos restart');",
      "assert.strictEqual(st.byAdapter.torbox?.sizeBad, 1);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'reconciliação: banco vazio inicia limpo com _origem durável sem erros',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const script = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.sizeLie, 0);",
      "assert.deepStrictEqual(Object.keys(st.byAdapter), []);",
      "assert.strictEqual(st._origem.sizeAlive, 'duravel');",
      "assert.strictEqual(st._origem.byAdapter, 'duravel');",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([script]);
  },
);

test(
  'evicção por expiração (TTL): cache.prune() expurga chaves expiradas e decrementa contadores sem vazamento',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "",
      "magnetdb.markAlive('premiumize', 'acc1', ['alive1', 'alive2']);",
      "magnetdb.markBad('premiumize', 'acc1', 'bad1');",
      "magnetdb.markLie('premiumize', 'acc1', 'lie1');",
      "",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, 'alive inicial correto');",
      "assert.strictEqual(st.sizeBad, 1, 'bad inicial correto');",
      "assert.strictEqual(st.sizeLie, 1, 'lie inicial correto');",
      "",
      "// Avança o tempo além do TTL de bad/lie (24h) mas dentro do TTL de alive (7d)",
      "const origNow = Date.now;",
      "Date.now = () => origNow() + 1000 * 86400 * 2;",
      "try {",
      "  cache.prune();",
      "} finally {",
      "  Date.now = origNow;",
      "}",
      "",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 0, 'bad expirado foi decrementado via onForget em prune()');",
      "assert.strictEqual(st.sizeAlive, 2, 'alive continua ativo antes de 7 dias');",
      "assert.strictEqual(st.sizeLie, 1, 'lie continua ativo antes de 7 dias');",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 2);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeLie, 1);",
      "",
      "// Avança o tempo além do TTL de alive e lie (7 dias -> 8 dias)",
      "Date.now = () => origNow() + 1000 * 86400 * 8;",
      "try {",
      "  cache.prune();",
      "} finally {",
      "  Date.now = origNow;",
      "}",
      "",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'alive expirado foi decrementado sem vazamento fantasma');",
      "assert.strictEqual(st.sizeLie, 0, 'lie expirado foi decrementado sem vazamento fantasma');",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive ?? 0, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeLie ?? 0, 0);",
      "assert.deepStrictEqual(Object.keys(st.byAdapter), []);",
      "",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'estado zerado persiste limpo no reinicio');",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.sizeLie, 0);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'regravar entrada expirada antes do prune não infla os contadores duráveis',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const script = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const now = Date.now;",
      "magnetdb.markAlive('premiumize', 'acc-expired', ['alive-expired']);",
      "magnetdb.markBad('premiumize', 'acc-expired', 'bad-expired');",
      "magnetdb.markLie('premiumize', 'acc-expired', 'lie-expired');",
      "const before = magnetdb.status();",
      "Date.now = () => now() + 8 * 86400 * 1000;",
      "try {",
      "  magnetdb.markAlive('premiumize', 'acc-expired', ['alive-expired']);",
      "  magnetdb.markBad('premiumize', 'acc-expired', 'bad-expired');",
      "  magnetdb.markLie('premiumize', 'acc-expired', 'lie-expired');",
      "} finally { Date.now = now; }",
      "const after = magnetdb.status();",
      "assert.strictEqual(after.sizeAlive, before.sizeAlive);",
      "assert.strictEqual(after.sizeBad, before.sizeBad);",
      "assert.strictEqual(after.sizeLie, before.sizeLie);",
      "assert.strictEqual(cache.keysMatching('mag:v1:alive:premiumize:').length, 1);",
      "assert.strictEqual(cache.keysMatching('mag:v1:bad:premiumize:').length, 1);",
      "assert.strictEqual(cache.keysMatching('mag:v1:lie:premiumize:').length, 1);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([script]);
  },
);

test(
  'agregado ausente no boot: contadores reconstruídos do L1 em vez de zerar sob rótulo durável',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "// Hash de 40-hex de verdade: o parse do L1 descarta chave malformada,",
      "// entao hash de brinquedo nao seria recontado (e o teste mentiria).",
      "const H = (c) => c.repeat(40);",
      "magnetdb.markAlive('premiumize', 'acc1', [H('a'), H('b'), H('c')]);",
      "magnetdb.markBad('realdebrid', 'acc2', H('d'));",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    // O caso real: cache.db herdado sobrevive ao rebuild do container, mas a
    // chave do agregado não veio junto (versão antiga, evicção, payload novo).
    const stage2 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      "const { DatabaseSync } = require('node:sqlite');",
      `const { magMetaCountsKey } = require(${JSON.stringify(CACHE_KEYS_MODULE)});`,
      "const pre = new DatabaseSync(process.env.CACHE_DB_PATH);",
      "pre.prepare('DELETE FROM cache WHERE key = ?').run(magMetaCountsKey());",
      "pre.close();",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const st = magnetdb.status();",
      "assert.ok(st.l1Entries >= 4, 'L1 herdou as entradas mag do cache.db');",
      "assert.strictEqual(st.sizeAlive, 3, 'alive reconstruído do L1, não zerado');",
      "assert.strictEqual(st.sizeBad, 1, 'bad reconstruído do L1, não zerado');",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 3);",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeBad, 1);",
      "assert.strictEqual(st._origem.sizeAlive, 'duravel', 'rótulo só é honesto porque houve recontagem');",
      "assert.ok((st.ttlRemainingSeconds.alive || 0) > 0, 'TTL restante veio do L1, não de soma nominal');",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
      "const post = new DatabaseSync(process.env.CACHE_DB_PATH);",
      "const row = post.prepare('SELECT value FROM cache WHERE key = ?').get(magMetaCountsKey());",
      "assert.ok(row, 'agregado regravado após a reconstrução');",
      "assert.strictEqual(JSON.parse(row.value).adapters.premiumize.alive, 3);",
      "post.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);
