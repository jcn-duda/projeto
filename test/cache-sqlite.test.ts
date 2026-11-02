import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// node:sqlite é experimental no Node 22+; em Node 18 o módulo de cache segue só
// em memória e o contrato 1 (persistência) não tem o que validar — skip claro.
let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

// Caminho absoluto do módulo compilado. Reloads do processo pai usam query
// única (estado limpo); os filhos importam SEM query para compartilhar a
// instância com o `./cache.js` interno do magnetdb.
const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
const freshCache = (): Promise<any> => import(`${CACHE_URL}?fresh=${Date.now()}-${cacheSeq++}`);

// Helper para executar scripts em processos isolados com banco temporário
function runIsolatedCacheTest(scriptContent: any) {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  // Banco em tmpdir do SO: o data/cache.db real do repo não pode ser tocado.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-cache-test-'));
  const dbPath = path.join(tempDir, 'cache.db');
  try {
    // `--input-type=module`: o corpo é ESM nativo (imports/TLA), nunca CJS.
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', scriptContent], {
      // O subprocesso PRECISA do SQLite: tira o CACHE_PERSIST herdado do runner
      // (o setup-env o define para a suíte inteira) em vez de deixar o teste de
      // persistência rodar só em memória e falhar com "no such table".
      env: (({ CACHE_PERSIST, ...resto }) => ({ ...resto, CACHE_DB_PATH: dbPath }))(process.env),
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(res.error);
    assert.strictEqual(
      res.status,
      0,
      'Falha na execução do subprocesso de teste de cache:\n' + res.stdout + res.stderr,
    );
  } finally {
    // Restaura o ambiente do processo pai: o runner não pode ser o único
    // isolamento entre CACHE_DB_PATH/CACHE_PERSIST.
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    // O filho já saiu: conexão fechada, o tmpdir apaga de verdade no Windows.
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

test('prune com janela de graça: expirado servível fica; graça zero volta ao corte duro', async () => {
  // Sem esta janela o prune apaga a entrada expirada antes de o refresh de
  // fundo poder servi-la — o SWR morreria na prática.
  const originalPersist = process.env.CACHE_PERSIST;
  const originalGrace = config.streamStaleGrace;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

    config.streamStaleGrace = 300;
    cache.set('swrprune:a', { n: 1 }, 0.05);
    await sleep(120);
    cache.prune();
    assert.deepEqual(
      cache.getWithStale('swrprune:a', 300),
      { value: { n: 1 }, stale: true },
      'expirado dentro da graça sobrevive ao prune',
    );

    config.streamStaleGrace = 0;
    cache.prune();
    assert.equal(cache.getWithStale('swrprune:a', 300), null, 'graça zero volta a podar o expirado');
  } finally {
    config.streamStaleGrace = originalGrace;
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

// Desde a F4 da guilhotina o Node não poda o arquivo que divide com o gateway: a
// faxina de versão, legado e vencido é do `NativeKv::boot_housekeeping`
// (`kv_tests.rs`). Aqui a prova é a ausência: nem o boot nem o forget apagam.
const NODE_NEVER_PRUNES_SCRIPT = [
  "import assert from 'node:assert';",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = await import('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "const keys = ['streams:v7:velho', 'rdc:v1:velho', 'raw1:legado', 'rdt:v1:orfao', 'tmdb:v1:vencido'];",
  "for (const key of keys) insert.run(key, '1', now - 3600000);",
  'seed.close();',
  '',
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
  "cache.forget('tmdb:v1:vencido');",
  "cache.forgetMany(['raw1:legado']);",
  'cache.prune();',
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const left = dbVerify.prepare('SELECT key FROM cache').all().map((row) => row.key).sort();",
  'assert.deepStrictEqual(left, [...keys].sort());',
  'dbVerify.close();',
].join('\n');

test(
  'o Node não poda o cache.db: boot, forget e prune deixam todas as linhas',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(NODE_NEVER_PRUNES_SCRIPT),
);

// A cota de 800 do `raw` agora é aplicada pelo RawCacheStore no gateway
// (`raw_tests.rs`); o boot do Node não pode mais tocá-la: dono único no Rust
// significa NENHUMA linha sobe no L1 e NENHUMA sai do disco — nem excedente.
const RAW_QUOTA_RENAME_SCRIPT = [
  "import assert from 'node:assert';",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = await import('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "seed.exec('BEGIN');",
  'for (let i = 0; i < 810; i++) {',
  "  insert.run('raw:v1:jackett:yts:movie:tt-' + i, JSON.stringify({ n: i }), now + 1000 + i);",
  '}',
  "seed.exec('COMMIT');",
  'seed.close();',
  '',
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
  '',
  "assert.strictEqual(cache.snapshot().namespaces.raw, undefined, 'raw nao monta balde no L1 do Node');",
  "assert.strictEqual(cache.get('raw:v1:jackett:yts:movie:tt-0'), null, 'nenhuma linha raw sobe no L1');",
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const countRow = dbVerify.prepare(\"SELECT COUNT(*) as cnt FROM cache WHERE key LIKE 'raw:v1:%'\").get();",
  "assert.strictEqual(countRow.cnt, 810, 'o boot do Node nao poda o namespace do gateway');",
  'dbVerify.close();',
].join('\n');

test(
  'cota do raw é do gateway: o boot do Node não sobe nem poda uma linha que seja',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(RAW_QUOTA_RENAME_SCRIPT),
);

const MAINTAIN_SCRIPT = [
  "import assert from 'node:assert';",
  'delete process.env.CACHE_PERSIST;',
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
  '',
  "cache.set('davail:v1:premiumize:tt-maintain-1:h', { data: 'test1' }, 3600);",
  "cache.set('davail:v1:premiumize:tt-maintain-2:h', { data: 'test2' }, 3600);",
  'const res = cache.maintain();',
  "assert.strictEqual(res.checkpointed, true, 'checkpoint passivo executado');",
  "assert.strictEqual(res.optimized, true, 'optimize executado');",
  "assert.strictEqual(typeof res.freelistCount, 'number', 'freelist_count medido');",
  "assert.strictEqual(typeof res.vacuumed, 'boolean', 'status de vacuum retornado');",
  'cache.close();',
].join('\n');

test(
  'cache.maintain executa wal_checkpoint passivo, optimize e pragma freelist_count',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(MAINTAIN_SCRIPT),
);

const CORRUPT_RECOVERY_SCRIPT = [
  "import assert from 'node:assert';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = await import('node:sqlite');",
  'const dbPath = process.env.CACHE_DB_PATH;',
  "fs.writeFileSync(dbPath, 'LIXO_CORROMPIDO_NOT_A_SQLITE_DATABASE_!!!');",
  "const corruptPath = dbPath + '.corrupt';",
  "assert.strictEqual(fs.existsSync(corruptPath), false, 'corruptPath nao existe antes do boot');",
  '',
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
  '',
  "assert.strictEqual(fs.existsSync(corruptPath), true, 'arquivo corrompido renomeado para .corrupt');",
  "assert.strictEqual(fs.readFileSync(corruptPath, 'utf8'), 'LIXO_CORROMPIDO_NOT_A_SQLITE_DATABASE_!!!', 'conteudo original preservado no .corrupt');",
  "assert.strictEqual(fs.existsSync(dbPath), true, 'novo banco SQLite criado');",
  "cache.set('test:corrupt-recovered', { ok: true }, 3600);",
  "assert.deepStrictEqual(cache.get('test:corrupt-recovered'), { ok: true }, 'novo cache funcional em L1/L2');",
  'if (cache.close) cache.close();',
  'const verify = new DatabaseSync(dbPath);',
  "const row = verify.prepare('SELECT value FROM cache WHERE key = ?').get('test:corrupt-recovered');",
  "assert.ok(row, 'valor persistido com sucesso no banco recriado');",
  'verify.close();',
].join('\n');

test(
  'recuperação de SQLite corrompido: renomeia para .corrupt e recria banco limpo no boot (Tarefa 2.9)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(CORRUPT_RECOVERY_SCRIPT),
);
