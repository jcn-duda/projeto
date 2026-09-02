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

// node:sqlite é experimental no Node 22+; em Node 18 o módulo de cache segue só
// em memória e o contrato 1 (persistência) não tem o que validar — skip claro.
let hasNodeSqlite = true;
try {
  _require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const CACHE_MODULE = _require.resolve('../src/utils/cache.js');

// Helper para executar scripts em processos isolados com banco temporário
function runIsolatedCacheTest(scriptContent: any) {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  // Banco em tmpdir do SO: o data/cache.db real do repo não pode ser tocado.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-cache-test-'));
  const dbPath = path.join(tempDir, 'cache.db');
  try {
    const res = spawnSync(process.execPath, ['-e', scriptContent], {
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
  // Sem esta janela o timer de 10 min apaga a entrada expirada antes de o
  // refresh de fundo poder servi-la — o SWR morreria na prática.
  const originalPersist = process.env.CACHE_PERSIST;
  const config = _require('../src/config.js').default;
  const originalGrace = config.streamStaleGrace;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

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
    delete _require.cache[CACHE_MODULE];
  }
});

// ===========================================================================
// Descarte de versões obsoletas e prefixos aposentados no boot (loadFromDisk)
// ===========================================================================
// A versão de cada namespace vive num lugar só (cache-keys.js). Estes testes
// garantem que o loadFromDisk apaga do DISCO (não só do L1) o que não bate com
// a versão corrente: sem o DELETE no SQLite, a linha morta voltaria a ser
// carregada no próximo restart e ocuparia cota por todo o TTL.
const STREAMS_VERSION_DISCARD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "insert.run('streams:v7:movie:tt-antigo:{}:account:none', JSON.stringify({ streams: ['antigo'] }), now + 900000);",
  "insert.run('streams:v8:movie:tt-meio:{}:account:none', JSON.stringify({ streams: ['meio'] }), now + 900000);",
  "insert.run('streams:v9:movie:tt-novo:{}:account:none', JSON.stringify({ streams: ['novo'] }), now + 900000);",
  "insert.run('streams:v10:movie:tt-atual:{}:account:none', JSON.stringify({ streams: ['atual'] }), now + 900000);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  // TTL futuro nas quatro: v7/v8/v9 somem por serem versão morta, não por expirar.
  "assert.deepStrictEqual(cache.get('streams:v10:movie:tt-atual:{}:account:none'), { streams: ['atual'] }, 'v10 sobe do disco');",
  "assert.strictEqual(cache.get('streams:v9:movie:tt-novo:{}:account:none'), null, 'v9 nao entra no L1');",
  "assert.strictEqual(cache.get('streams:v8:movie:tt-meio:{}:account:none'), null, 'v8 nao entra no L1');",
  "assert.strictEqual(cache.get('streams:v7:movie:tt-antigo:{}:account:none'), null, 'v7 nao entra no L1');",
  '',
  // Reabre o banco: o DELETE tem que ter corrido no SQLite, não só no Map.
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const staleRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'streams:v7:%' OR key LIKE 'streams:v8:%' OR key LIKE 'streams:v9:%'\").all();",
  "assert.strictEqual(staleRows.length, 0, 'linhas streams:v7/v8/v9 apagadas do disco');",
  "const liveRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'streams:v10:%'\").all();",
  "assert.strictEqual(liveRows.length, 1, 'linha streams:v10 preservada no disco');",
  'dbVerify.close();',
].join('\n');

test(
  'descarte de versão obsoleta no disco — streams: v7/v8/v9 somem, v10 sobe no boot',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(STREAMS_VERSION_DISCARD_SCRIPT),
);

// Mesmo contrato para o autofetch: a v2 (formato anterior ao cache-keys.js v3)
// precisa sair do disco no boot, senão um marker antigo sobrevive ao restart e
// segura vaga de autofetch sem nunca ser lido com a chave nova.
const AUTOFETCH_VERSION_DISCARD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "insert.run('autofetch:v2:alldebrid:acc:abc123', JSON.stringify({ hash: 'abc123' }), now + 900000);",
  "insert.run('autofetch:v3:m:alldebrid:acc:def456', JSON.stringify({ hash: 'def456' }), now + 900000);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "assert.deepStrictEqual(cache.get('autofetch:v3:m:alldebrid:acc:def456'), { hash: 'def456' }, 'autofetch v3 sobe do disco');",
  "assert.strictEqual(cache.get('autofetch:v2:alldebrid:acc:abc123'), null, 'autofetch v2 nao entra no L1');",
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const staleRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'autofetch:v2:%'\").all();",
  "assert.strictEqual(staleRows.length, 0, 'linha autofetch:v2 apagada do disco');",
  "const liveRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'autofetch:v3:%'\").all();",
  "assert.strictEqual(liveRows.length, 1, 'linha autofetch:v3 preservada no disco');",
  'dbVerify.close();',
].join('\n');

test(
  'descarte de versão obsoleta no disco — autofetch: v2 some, v3 sobe no boot',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(AUTOFETCH_VERSION_DISCARD_SCRIPT),
);

// Migração RD (G1): o ledger `rdc` ficou MISTURADO com o cache por título do
// Torrentio (`rdc:v1:trt:...`) e com a fila do warmer (`rdc:v1:wq`) sob o mesmo
// prefixo v1. Em v2 o ledger é só de hashes; o cache por título de Torrentio migrou
// para `rdt:v1` e a fila para `rdq:v1`. Este teste garante que o boot:
//   * apaga TODOS os `rdc:v1:*` (ledger histórico + trt/wq legados embutidos) —
//     a limpeza única dos misses suspeitos, idempotente (não se repete em
//     subidas seguintes porque a versão corrente já é v2);
//   * preserva `rdc:v2`, `rdt:v1` e `rdq:v1` — os formatos novos não são lixo,
//     e a fila/cache Torrentio vivos não podem ser derrubados pelo bump.
const RD_VERSION_DISCARD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  // Legado embutido no ledger: miss histórico suspeito + cache Torrentio + fila.
  "insert.run('rdc:v1:aaaa', JSON.stringify({ s: 'miss', n: 23, at: now }), now + 900000);",
  "insert.run('rdc:v1:trt:movie:ttantigo', JSON.stringify([['bbbbbbb', true]]), now + 900000);",
  "insert.run('rdc:v1:wq', JSON.stringify([{ hash: 'ccccccc', score: 5, enqueuedAt: now }]), now + 900000);",
  // Formatos novos: ledger v2, cache Torrentio separado (rdt), fila separada (rdq).
  "insert.run('rdc:v2:ddddddd', JSON.stringify({ s: 'hit', n: 0, at: now }), now + 900000);",
  "insert.run('rdt:v1:trt:movie:ttnovo', JSON.stringify([['eeeeeee', true]]), now + 900000);",
  "insert.run('rdq:v1:wq', JSON.stringify([{ hash: 'fffffff', score: 7, enqueuedAt: now }]), now + 900000);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  // Só os formatos novos sobem no L1.
  "assert.deepStrictEqual(cache.get('rdc:v2:ddddddd'), { s: 'hit', n: 0, at: now }, 'rdc:v2 sobe do disco');",
  "assert.deepStrictEqual(cache.get('rdt:v1:trt:movie:ttnovo'), [['eeeeeee', true]], 'rdt:v1 preservado');",
  "assert.strictEqual(cache.get('rdc:v1:aaaa'), null, 'miss legado do ledger não entra no L1');",
  "assert.strictEqual(cache.get('rdc:v1:wq'), null, 'fila legada embutida no v1 não entra no L1');",
  '',
  // O DELETE tem que ter corrido no SQLite, não só no Map.
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const rdcV1 = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'rdc:v1:%'\").all();",
  "assert.strictEqual(rdcV1.length, 0, 'todo rdc:v1 apagado do disco (ledger + trt/wq legados)');",
  "const rdcV2 = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'rdc:v2:%'\").all();",
  "assert.strictEqual(rdcV2.length, 1, 'rdc:v2 preservado no disco');",
  "const rdtRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'rdt:v1:%'\").all();",
  "assert.strictEqual(rdtRows.length, 1, 'rdt:v1 (cache Torrentio vivo) preservado no disco');",
  "const rdqRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'rdq:v1:%'\").all();",
  "assert.strictEqual(rdqRows.length, 1, 'rdq:v1 (fila do warmer viva) preservado no disco');",
  'dbVerify.close();',
].join('\n');

test(
  'migração RD (G1): rdc v2 limpa o v1 inteiro (ledger+trt+wq) numa passada; rdt/rdq sobrevivem',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(RD_VERSION_DISCARD_SCRIPT),
);

// `raw1:` e `dinv1:` eram a versão colada no nome; hoje vivem como `raw:v1:` e
// `dinv:v1:`. Elas NÃO caem no loop de namespace versionado (`raw1:...` não
// casa `LIKE 'raw:%'`), então a limpeza precisa do loop de LEGACY_PREFIXES —
// sem ele o lixo órfão ficaria no banco até expirar, ocupando cota.
const LEGACY_PREFIX_DISCARD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "insert.run('raw1:jackett:yts:movie:tt-x', JSON.stringify({ items: ['legado'] }), now + 900000);",
  "insert.run('dinv1:alldebrid:acc', JSON.stringify({ ready: true }), now + 900000);",
  "insert.run('raw:v1:jackett:yts:movie:tt-y', JSON.stringify({ items: ['novo'] }), now + 900000);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  // O formato novo é o que o código lê; os legados são lixo a ser varrido.
  "assert.deepStrictEqual(cache.get('raw:v1:jackett:yts:movie:tt-y'), { items: ['novo'] }, 'raw:v1 sobe do disco');",
  "assert.strictEqual(cache.get('raw1:jackett:yts:movie:tt-x'), null, 'raw1 nao entra no L1');",
  "assert.strictEqual(cache.get('dinv1:alldebrid:acc'), null, 'dinv1 nao entra no L1');",
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const raw1Rows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'raw1:%'\").all();",
  "assert.strictEqual(raw1Rows.length, 0, 'prefixo legado raw1 apagado do disco');",
  "const dinv1Rows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'dinv1:%'\").all();",
  "assert.strictEqual(dinv1Rows.length, 0, 'prefixo legado dinv1 apagado do disco');",
  "const rawV1Rows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'raw:v1:%'\").all();",
  "assert.strictEqual(rawV1Rows.length, 1, 'raw:v1 continua no disco');",
  'dbVerify.close();',
].join('\n');

test(
  'prefixos aposentados no disco: raw1:/dinv1: somem do SQLite no boot, raw:v1 permanece',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(LEGACY_PREFIX_DISCARD_SCRIPT),
);

// A cota do balde de resultado bruto foi renomeada de `raw1` para `raw` junto
// com a chave versionada. Se o loadFromDisk usasse o nome velho, a cota `raw`
// (800) não existiria e as 810 linhas cairiam na cota padrão (500) — jogando
// 310 fora. O teste também reabre o banco: as excedentes têm que sair do disco
// via forgetMany(skipped), senão o próximo restart repete o trabalho.
const RAW_QUOTA_RENAME_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
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
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  // A seleção vem do TTL mais longo para o mais curto: as 10 de expires_at
  // menor (i=0..9) são as excedentes que saem da cota de 800.
  "assert.strictEqual(cache.snapshot().namespaces.raw.entries, 800, 'o balde raw respeita a própria cota de 800');",
  "assert.strictEqual(cache.snapshot().namespaces.raw.maxEntries, 800, 'a cota configurada para raw é 800');",
  "assert.strictEqual(cache.snapshot().namespaces.__default, undefined, 'nenhuma linha caiu no balde padrão');",
  "assert.strictEqual(cache.get('raw:v1:jackett:yts:movie:tt-0'), null, 'a excedente de menor TTL nao entra');",
  "assert.deepStrictEqual(cache.get('raw:v1:jackett:yts:movie:tt-809'), { n: 809 }, 'a de maior TTL entra inteira');",
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const countRow = dbVerify.prepare(\"SELECT COUNT(*) as cnt FROM cache WHERE key LIKE 'raw:v1:%'\").get();",
  "assert.strictEqual(countRow.cnt, 800, 'as excedentes foram apagadas do disco também');",
  'dbVerify.close();',
].join('\n');

test(
  'cota do rename raw1→raw: 810 linhas viram 800 no L1 e no disco no boot',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(RAW_QUOTA_RENAME_SCRIPT),
);

// O valor gordo agora é buscado por PK (selectValueStmt) só para as chaves que
// passaram na cota; antes o SELECT único trazia key+value+expires de todas. Um
// objeto aninhado com arrays, números fracionários, strings, null e boolean
// prova que a serialização JSON não perde nada no caminho índice → valor.
const PK_VALUE_INTEGRITY_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "const complexo = { titulo: 'Coringa', ano: 2019, tags: ['dublado', 'dual'], notas: [9.5, 8, 7.25], nested: { a: [1, 2, 3], b: 'x' }, nulo: null, flag: true };",
  "insert.run('raw:v1:jackett:yts:movie:tt-complexa', JSON.stringify(complexo), now + 900000);",
  "insert.run('raw:v1:jackett:yts:movie:tt-simples', JSON.stringify({ lista: ['a', 'b', 'c'] }), now + 900001);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "assert.deepStrictEqual(cache.get('raw:v1:jackett:yts:movie:tt-complexa'), complexo, 'objeto aninhado volta inteiro via PK');",
  "assert.deepStrictEqual(cache.get('raw:v1:jackett:yts:movie:tt-simples'), { lista: ['a', 'b', 'c'] }, 'objeto simples volta inteiro');",
].join('\n');

test(
  'valor íntegro via busca por PK: objeto aninhado carrega do disco sem truncar',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(PK_VALUE_INTEGRITY_SCRIPT),
);

const MAINTAIN_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "cache.set('idx:v2:test-maintain-1', { data: 'test1' }, 3600);",
  "cache.set('idx:v2:test-maintain-2', { data: 'test2' }, 3600);",
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
  "const assert = require('node:assert');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const dbPath = process.env.CACHE_DB_PATH;',
  "fs.writeFileSync(dbPath, 'LIXO_CORROMPIDO_NOT_A_SQLITE_DATABASE_!!!');",
  "const corruptPath = dbPath + '.corrupt';",
  "assert.strictEqual(fs.existsSync(corruptPath), false, 'corruptPath nao existe antes do boot');",
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
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

