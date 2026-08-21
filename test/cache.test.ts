import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as metrics from '../src/utils/metrics.js';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Chaves sem prefixo pertencem ao namespace padrão. Estes testes exercitam o
// LRU desse balde; o teto global é deliberadamente maior que cada cota.
const MAX_ENTRIES = 500;
const DLMAG_QUOTA = 4000;
const EXTRA = 5; // entradas além do teto: o reload tem que deixar de fora as de TTL mais curto
const TTL_S = 3600;

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

// Contrato 1 roda num processo filho curto: o módulo abre a conexão SQLite no
// require e não expõe close; com o filho morto, a conexão fecha e o tmpdir pode
// ser apagado de verdade — no processo do runner a deleção esbarraria em EBUSY.
// De quebra, o CACHE_DB_PATH/CACHE_PERSIST do runner nunca chegam ao módulo.
const RELOAD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST; // herança do runner não pode desligar o SQLite',
  "const { DatabaseSync } = require('node:sqlite');",
  `const total = ${MAX_ENTRIES} + ${EXTRA};`,
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  'seed.exec(',
  "  'CREATE TABLE IF NOT EXISTS cache (' +",
  "    'key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);'",
  ');',
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const base = Date.now() + 60000;',
  "seed.exec('BEGIN');",
  'for (let i = 0; i < total; i++) {',
  "  insert.run('k-' + i, JSON.stringify({ n: i }), base + i * 1000);",
  '}',
  "seed.exec('COMMIT');",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  '// Overflow IMEDIATAMENTE após o reload, antes de qualquer leitura: get()',
  '// renova a recência e mascararia a ordem reconstruída pelo loadFromDisk.',
  `cache.set('overflow', { n: 'overflow' }, ${TTL_S});`,
  '',
  '// Seleção DESC: k-0..k-4 (menores expires_at) nem chegam a ser carregadas.',
  "assert.strictEqual(cache.get('k-0'), null, 'k-0 nao pode ser recarregada');",
  "assert.strictEqual(cache.get('k-4'), null, 'as 5 de TTL mais curto saem juntas');",
  '',
  '// Ordem pós-reload: o menor expires_at entre os selecionados é o LRU e o',
  '// maior é o mais recente. O estouro expulsa k-5 e poupa k-2004.',
  "assert.strictEqual(cache.get('k-5'), null, 'k-5 e expulso como LRU do reload');",
  `assert.deepStrictEqual(cache.get('k-' + (total - 1)), { n: total - 1 }, 'k-2004 sobrevive');`,
  "assert.deepStrictEqual(cache.get('overflow'), { n: 'overflow' }, 'a nova entrada entra');",
  '',
  'let present = 0;',
  'for (let i = 0; i < total; i++) {',
  "  if (cache.get('k-' + i) !== null) present++;",
  '}',
  "if (cache.get('overflow') !== null) present++;",
  `assert.strictEqual(present, ${MAX_ENTRIES}, 'o total continua na cota padrão');`,
].join('\n');

test(
  'reload do SQLite: seleção DESC + ordem reconstruída expulsa o menor TTL selecionado na cota padrão',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — o contrato 1 precisa de Node 22+' },
  () => {
    runIsolatedCacheTest(RELOAD_SCRIPT);
  },
);

test('get() de entrada válida renova a recência: no estouro ela sobrevive e o LRU válido sai', () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    // Sem SQLite: o contrato 2 é sobre a ordem do Map em memória.
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`k-${i}`, { n: i }, TTL_S);

    // Toca na mais antiga: depois do estouro ela tem que continuar viva.
    assert.deepEqual(cache.get('k-0'), { n: 0 }, 'get de entrada válida devolve o valor');

    // Estoura a cota: o prune remove UMA entrada — a menos recentemente usada.
    cache.set('overflow', { n: 'overflow' }, TTL_S);

    assert.deepEqual(cache.get('k-0'), { n: 0 }, 'a entrada tocada sobrevive ao estouro');
    assert.equal(cache.get('k-1'), null, 'a menos recentemente usada (k-1) é a removida');
    assert.deepEqual(cache.get('overflow'), { n: 'overflow' }, 'a nova entrada entra no cache');

    let present = 0;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      if (cache.get(`k-${i}`) !== null) present++;
    }
    if (cache.get('overflow') !== null) present++;
    assert.equal(present, MAX_ENTRIES, 'o total continua dentro da cota após o estouro');
  } finally {
    // Restaura o ambiente do processo pai: não depende do isolamento do runner.
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
  }
});

test('setMany: lote com UMA evicção por namespace — as mais antigas saem, as do lote ficam', () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    // Enche a cota do namespace padrão com entradas individuais.
    const quota = cache.QUOTAS.__default;
    for (let i = 0; i < quota; i++) cache.set(`a-${i}`, { n: i }, TTL_S);

    // Lote que estoura a cota em 3: a passada única de evicção derruba as três
    // mais antigas do LRU (a-0..a-2) e mantém todo o lote novo. Entrada com
    // TTL 0 é ignorada, igual ao set() unitário.
    cache.setMany([
      { key: 'b-0', value: 0, ttlSeconds: TTL_S },
      { key: 'b-1', value: 1, ttlSeconds: TTL_S },
      { key: 'b-2', value: 2, ttlSeconds: TTL_S },
      { key: 'b-invalida', value: 9, ttlSeconds: 0 },
    ]);

    assert.deepEqual(cache.get('b-0'), 0, 'entrada do lote fica');
    assert.deepEqual(cache.get('b-2'), 2, 'última entrada do lote fica');
    assert.equal(cache.get('b-invalida'), null, 'TTL 0 não entra, igual ao set()');
    assert.equal(cache.get('a-0'), null, 'a mais antiga é a vítima da evicção em lote');
    assert.equal(cache.get('a-2'), null, 'terceira mais antiga também sai (excesso = 3)');
    assert.deepEqual(cache.get('a-3'), { n: 3 }, 'a partir da quarta mais antiga sobrevive');
    assert.deepEqual(cache.get(`a-${quota - 1}`), { n: quota - 1 }, 'a mais recente sobrevive');
    assert.equal(cache.size(), quota, 'namespace volta exatamente à cota');

    // O set() unitário continua valendo (agora delega ao lote de 1).
    cache.set('single', { ok: true }, TTL_S);
    assert.deepEqual(cache.get('single'), { ok: true });
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
  }
});

const RESILIENT_LOAD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  'seed.exec(',
  "  'CREATE TABLE IF NOT EXISTS cache (' +",
  "    'key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);'",
  ');',
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "insert.run('val-1', JSON.stringify({ title: 'Filme A' }), now + 100000);",
  "insert.run('corrupt-1', 'NOT_VALID_JSON{', now + 100000);",
  "insert.run('val-2', JSON.stringify({ streams: ['s1'] }), now + 200000);",
  "insert.run('corrupt-2', '{\"incomplete\":', now + 200000);",
  "insert.run('val-3', JSON.stringify({ count: 42 }), now + 300000);",
  "insert.run('expired-val', JSON.stringify({ old: true }), now - 50000);",
  "insert.run('expired-corrupt', 'INVALID_OLD', now - 50000);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "assert.deepStrictEqual(cache.get('val-1'), { title: 'Filme A' }, 'val-1 carregado com sucesso');",
  "assert.deepStrictEqual(cache.get('val-2'), { streams: ['s1'] }, 'val-2 carregado com sucesso');",
  "assert.deepStrictEqual(cache.get('val-3'), { count: 42 }, 'val-3 carregado com sucesso');",
  "assert.strictEqual(cache.get('corrupt-1'), null, 'corrupt-1 ignorado com segurança');",
  "assert.strictEqual(cache.get('corrupt-2'), null, 'corrupt-2 ignorado com segurança');",
  "assert.strictEqual(cache.get('expired-val'), null, 'expirado valido removido no start');",
  "assert.strictEqual(cache.get('expired-corrupt'), null, 'expirado corrompido removido no start');",
  'assert.strictEqual(cache.size(), 3, \'tamanho do cache em memoria reflete apenas os validos\');',
  '',
  "cache.set('new-val', { live: true }, 3600);",
  "assert.deepStrictEqual(cache.get('new-val'), { live: true }, 'novas insercoes funcionam normalmente apos recuperacao');",
  'assert.strictEqual(cache.size(), 4);',
].join('\n');

test(
  'loadFromDisk(): deserialização resiliente pula linhas corrompidas e carrega todas as válidas',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(RESILIENT_LOAD_SCRIPT);
  },
);

// A escrita no disco é diferida para o próximo tick (lote em transação única),
// então o script espera um setImmediate antes de conferir o SQLite.
const PERSISTENCE_SYNC_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  '(async () => {',
  "cache.set('k-a', { msg: 'hello' }, 3600);",
  "cache.set('k-b', { count: 99 }, 3600);",
  "cache.set('k-c', { active: true }, 3600);",
  'assert.strictEqual(cache.size(), 3);',
  '',
  '// O despejo em lote roda no próximo tick.',
  'await new Promise((resolve) => setImmediate(resolve));',
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const rows = dbVerify.prepare('SELECT key, value FROM cache ORDER BY key ASC').all();",
  'assert.strictEqual(rows.length, 3, \'3 registros persistidos no SQLite\');',
  "assert.strictEqual(rows[0].key, 'k-a');",
  "assert.deepStrictEqual(JSON.parse(rows[0].value), { msg: 'hello' });",
  '',
  "cache.forget('k-b');",
  "assert.strictEqual(cache.get('k-b'), null, 'k-b esquecido no L1');",
  'assert.strictEqual(cache.size(), 2);',
  "const rowsAfterForget = dbVerify.prepare('SELECT key FROM cache ORDER BY key ASC').all();",
  'assert.strictEqual(rowsAfterForget.length, 2);',
  "assert.deepStrictEqual(rowsAfterForget.map(r => r.key), ['k-a', 'k-c']);",
  '',
  'cache.clear();',
  'assert.strictEqual(cache.size(), 0);',
  "const rowsAfterClear = dbVerify.prepare('SELECT COUNT(*) as cnt FROM cache').get();",
  'assert.strictEqual(rowsAfterClear.cnt, 0, \'tabela SQLite limpa apos clear()\');',
  'dbVerify.close();',
  '})().catch((err) => { console.error(err); process.exit(1); });',
].join('\n');

test(
  'persistência e forget com statements pré-compilados: sincronia L1 (memória) e L2 (SQLite)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(PERSISTENCE_SYNC_SCRIPT);
  },
);

const PRUNE_BATCH_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  `const total = ${MAX_ENTRIES} + 10;`,
  'for (let i = 0; i < total; i++) {',
  "  cache.set('item-' + i, { n: i }, 3600);",
  '}',
  `assert.strictEqual(cache.size(), ${MAX_ENTRIES}, 'L1 respeita a cota padrão apos overflow');`,
  '// Espera o despejo em lote: as chaves expulsas pelo prune saíram da fila',
  '// junto com a memória, então o disco recebe exatamente o teto.',
  'await new Promise((resolve) => setImmediate(resolve));',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const countRow = dbVerify.prepare('SELECT COUNT(*) as cnt FROM cache').get();",
  `assert.strictEqual(countRow.cnt, ${MAX_ENTRIES}, 'SQLite reflete a cota padrão apos prune em lote');`,
  "assert.strictEqual(cache.get('item-0'), null, 'item-0 expulso como LRU');",
  "assert.strictEqual(cache.get('item-9'), null, 'item-9 expulso como LRU');",
  `assert.deepStrictEqual(cache.get('item-' + (total - 1)), { n: total - 1 }, 'item mais recente permanece');`,
  'dbVerify.close();',
].join('\n');

function wrapAsync(scriptLines: any) {
  // Os scripts precisam esperar o tick do despejo; `node -e` é CommonJS, então
  // o corpo roda dentro de uma IIFE assíncrona.
  return ["const assert = require('node:assert');", '(async () => {', ...scriptLines.slice(1), '})().catch((err) => { console.error(err); process.exit(1); });'].join('\n');
}

test(
  'prune() e forgetMany(): remoção em lote via transação SQLite com statement pré-compilado',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(wrapAsync(PRUNE_BATCH_SCRIPT.split('\n')));
  },
);

// Regressão do despejo em lote: forget ANTES do flush não pode ser desfeito
// pelo lote (a chave sai da fila junto com a memória).
const BATCH_FORGET_SCRIPT = [
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "cache.set('lote-1', { n: 1 }, 3600);",
  "cache.set('lote-2', { n: 2 }, 3600);",
  "cache.set('lote-3', { n: 3 }, 3600);",
  "cache.forget('lote-2');",
  '// Reescrita da mesma chave no mesmo tick: só a última vale.',
  "cache.set('lote-3', { n: 30 }, 3600);",
  '',
  'await new Promise((resolve) => setImmediate(resolve));',
  '',
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const rows = dbVerify.prepare('SELECT key, value FROM cache ORDER BY key ASC').all();",
  'assert.strictEqual(rows.length, 2, \'forget antes do flush impede a escrita\');',
  "assert.deepStrictEqual(rows.map((r) => r.key), ['lote-1', 'lote-3']);",
  "assert.deepStrictEqual(JSON.parse(rows[1].value), { n: 30 }, 'última escrita da chave é a que fica');",
  'dbVerify.close();',
];

test(
  'despejo em lote: forget/reescrita no mesmo tick valem na gravação adiada',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(wrapAsync(BATCH_FORGET_SCRIPT));
  },
);

test('estouro de dlmag despeja só o próprio namespace e preserva streams', () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    cache.set('streams:v5:movie:tt-vizinho', { streams: ['preservado'] }, TTL_S);
    for (let i = 0; i < DLMAG_QUOTA; i++) cache.set(`dlmag:url-${i}`, { n: i }, TTL_S);
    cache.set('dlmag:overflow', { n: 'overflow' }, TTL_S);

    assert.deepEqual(cache.get('streams:v5:movie:tt-vizinho'), { streams: ['preservado'] });
    assert.equal(cache.get('dlmag:url-0'), null, 'LRU de dlmag sai na própria cota');
    assert.deepEqual(cache.get('dlmag:overflow'), { n: 'overflow' });
    assert.equal(cache.snapshot().namespaces.dlmag.entries, DLMAG_QUOTA);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('cotas da Fase 3: raw limitado, streams ampliado, davail de entrada barata', () => {
  // raw guarda itens grandes (até ~100 KB por entrada), então a cota fica bem
  // abaixo das de entrada minúscula; davail é só 0/1 por hash (fase 3), o que
  // permite cota alta sem custo de memória; o teto global continua sendo a
  // soma das cotas + folga.
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);
    assert.equal(cache.QUOTAS.raw, 800);
    assert.equal(cache.QUOTAS.streams, 2000);
    assert.equal(cache.QUOTAS.davail, 5000);
    assert.equal(cache.MAX_ENTRIES, 17000);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    delete _require.cache[CACHE_MODULE];
  }
});

test('estouro de raw despeja só o próprio namespace e preserva streams', () => {
  // Mesmo contrato do dlmag: o namespace do resultado bruto gira sozinho e
  // não pode expulsar listas prontas de streams.
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);
    const RAW_QUOTA = cache.QUOTAS.raw;

    cache.set('streams:v5:movie:tt-vizinho', { streams: ['preservado'] }, TTL_S);
    for (let i = 0; i < RAW_QUOTA; i += 1) {
      cache.set(`raw:v1:jackett:yts:movie:t-${i}`, { items: [] }, TTL_S);
    }
    cache.set('raw:v1:jackett:yts:movie:overflow', { items: ['overflow'] }, TTL_S);

    assert.deepEqual(cache.get('streams:v5:movie:tt-vizinho'), { streams: ['preservado'] });
    assert.equal(cache.get('raw:v1:jackett:yts:movie:t-0'), null, 'LRU de raw sai na própria cota');
    assert.deepEqual(cache.get('raw:v1:jackett:yts:movie:overflow'), { items: ['overflow'] });
    assert.equal(cache.snapshot().namespaces.raw.entries, RAW_QUOTA);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    delete _require.cache[CACHE_MODULE];
  }
});

test('LRU de dlmag é escolhido dentro do namespace, não pela ordem global', () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    cache.set('meta:movie:tt-vizinho', { title: 'vizinho antigo' }, TTL_S);
    for (let i = 0; i < DLMAG_QUOTA; i++) cache.set(`dlmag:lru-${i}`, { n: i }, TTL_S);
    assert.deepEqual(cache.get('dlmag:lru-0'), { n: 0 }, 'renova o LRU de dlmag');
    cache.set('dlmag:overflow', { n: 'overflow' }, TTL_S);

    assert.deepEqual(cache.get('meta:movie:tt-vizinho'), { title: 'vizinho antigo' });
    assert.deepEqual(cache.get('dlmag:lru-0'), { n: 0 }, 'entrada renovada sobrevive');
    assert.equal(cache.get('dlmag:lru-1'), null, 'próximo LRU do dlmag é expulso');
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

const DLMAG_DOMINATED_LOAD_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  'const seed = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "seed.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);');",
  "const insert = seed.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');",
  'const now = Date.now();',
  "seed.exec('BEGIN');",
  `for (let i = 0; i < ${DLMAG_QUOTA} + 10; i++) {`,
  "  insert.run('dlmag:url-' + i, JSON.stringify({ n: i }), now + 7 * 24 * 3600 * 1000 + i);",
  '}',
  "insert.run('streams:v5:movie:tt123:{}:account:none', JSON.stringify({ streams: ['s1'] }), now + 900 * 1000);",
  "insert.run('streams:v4:movie:tt-antigo:{}:account:none', JSON.stringify({ streams: ['antigo'] }), now + 900 * 1000 + 1);",
  "insert.run('meta:movie:tt123', JSON.stringify({ name: 'Filme' }), now + 86400 * 1000);",
  "insert.run('tmdb:tt123', JSON.stringify({ pt: 'Filme' }), now + 7 * 24 * 3600 * 1000);",
  "seed.exec('COMMIT');",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "assert.deepStrictEqual(cache.get('streams:v5:movie:tt123:{}:account:none'), { streams: ['s1'] }, 'streams sobrevive ao reload');",
  "assert.strictEqual(cache.get('streams:v4:movie:tt-antigo:{}:account:none'), null, 'namespace v4 invalidado não ocupa cota');",
  "assert.deepStrictEqual(cache.get('meta:movie:tt123'), { name: 'Filme' }, 'meta sobrevive ao reload');",
  "assert.deepStrictEqual(cache.get('tmdb:tt123'), { pt: 'Filme' }, 'tmdb sobrevive ao reload');",
  `assert.strictEqual(cache.snapshot().namespaces.dlmag.entries, ${DLMAG_QUOTA}, 'dlmag respeita a própria cota');`,
].join('\n');

test(
  'loadFromDisk: banco dominado por dlmag ainda carrega streams, meta e tmdb',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => runIsolatedCacheTest(DLMAG_DOMINATED_LOAD_SCRIPT),
);

test('hit/miss por namespace: contadores globais ganham o sufixo do balde', () => {
  // Linha de base das fases do cache: o global diz SE o cache está pegando,
  // o sufixo diz QUAL namespace está pagando rede de novo.
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);
    metrics.reset();

    cache.set('raw:v1:jackett:yts:movie:coringa', { itens: [] }, TTL_S);
    assert.deepEqual(cache.get('raw:v1:jackett:yts:movie:coringa'), { itens: [] });
    cache.get('raw:v1:jackett:yts:movie:faltante'); // miss dentro do namespace
    cache.get('sem-prefixo'); // miss no balde padrão

    const counters = metrics.snapshot().counters;
    assert.equal(counters['cache.hit'], 1, 'contador global de hit preservado');
    assert.equal(counters['cache.hit.raw'], 1, 'hit ganha o sufixo do namespace');
    assert.equal(counters['cache.miss'], 2, 'contador global de miss preservado');
    assert.equal(counters['cache.miss.raw'], 1, 'miss ganha o sufixo do namespace');
    assert.equal(counters['cache.miss.__default'], 1, 'chave sem prefixo cai no balde padrão');
  } finally {
    metrics.reset();
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    delete _require.cache[CACHE_MODULE];
  }
});

test('modo sem persistência (CACHE_PERSIST="false"): operações puras em memória com statements nulos', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete process.env.CACHE_DB_PATH;
    // Cache-busting import: ESM modules are cached by specifier. A unique
    // query string forces Node to load a fresh instance that reads the
    // updated env at load time.
    const cache = await import(`../src/utils/cache.js?test=mem-${Date.now()}`);

    cache.set('mem-1', { a: 1 }, 3600);
    cache.set('mem-2', { b: 2 }, 3600);
    assert.strictEqual(cache.size(), 2);
    assert.deepStrictEqual(cache.get('mem-1'), { a: 1 });

    cache.forget('mem-1');
    assert.strictEqual(cache.get('mem-1'), null);
    assert.strictEqual(cache.size(), 1);

    cache.forgetMany(['mem-2']);
    assert.strictEqual(cache.get('mem-2'), null);
    assert.strictEqual(cache.size(), 0);

    cache.set('mem-3', { c: 3 }, 3600);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.get('mem-3'), null);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
  }
});

test('close() libera o SQLite sem derrubar o L1 e aceita chamada repetida', {
  skip: !hasNodeSqlite && 'node:sqlite indisponível — precisa de Node 22+',
}, () => {
  // O shutdown do addon chama cache.close(). Ele roda com requisições ainda
  // drenando, então fechar o L2 não pode quebrar quem ainda lê ou escreve — e
  // o handler pode ser chamado duas vezes (SIGTERM e depois SIGINT).
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-cache-close-'));
  const dbPath = path.join(tempDir, 'cache.db');

  try {
    delete process.env.CACHE_PERSIST;
    process.env.CACHE_DB_PATH = dbPath;
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    cache.set('antes', { n: 1 }, TTL_S);
    cache.close();

    // L1 continua servindo: fechar o disco não pode zerar o cache em memória.
    assert.deepEqual(cache.get('antes'), { n: 1 }, 'leitura pós-close continua valendo');
    // E escrita tardia degrada para só-memória em vez de estourar.
    assert.doesNotThrow(() => cache.set('depois', { n: 2 }, TTL_S));
    assert.deepEqual(cache.get('depois'), { n: 2 });
    assert.doesNotThrow(() => cache.close(), 'close() repetido é seguro');

    // O checkpoint TRUNCATE fecha o WAL; sobrar -wal significa que o banco não
    // foi fechado de verdade e o próximo boot recupera em vez de abrir limpo.
    assert.equal(fs.existsSync(`${dbPath}-wal`), false, 'o -wal tem que sumir no close');
  } finally {
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    // O módulo fica fechado; a próxima suíte que o exigir recarrega do zero.
    delete _require.cache[CACHE_MODULE];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('teto global despeja e termina: prune não pode repetir a mesma chave', () => {
  // Regressão: o laço do teto lia store.keys().next() e só empilhava a chave
  // em `dropped`, deixando a remoção para o forgetMany do fim. Sem a deleção
  // dentro do laço, store.size nunca caía, a MESMA chave era empilhada para
  // sempre e o array estourava — RangeError dentro de cache.set(), derrubando
  // a requisição em curso. Não bastava a cota por namespace: ela impede o teto
  // global de ser alcançado hoje, mas cada prefixo NOVO traz __default a mais.
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    // Prefixos desconhecidos pegam a cota __default; com o suficiente deles a
    // soma passa do teto global e o prune por teto entra em cena.
    const porNamespace = cache.QUOTAS.__default;
    const namespaces = Math.ceil(cache.MAX_ENTRIES / porNamespace) + 1;
    for (let ns = 0; ns < namespaces; ns += 1) {
      for (let i = 0; i < porNamespace; i += 1) {
        cache.set(`teto${ns}:${i}`, { i }, TTL_S);
      }
    }

    assert.ok(
      cache.size() <= cache.MAX_ENTRIES,
      `store parou em ${cache.size()}, acima do teto ${cache.MAX_ENTRIES}`,
    );
    // O set seguinte é o que estourava: prova que o laço termina.
    cache.set('teto-final:1', { ok: true }, TTL_S);
    assert.deepEqual(cache.get('teto-final:1'), { ok: true });
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    delete _require.cache[CACHE_MODULE];
  }
});

const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

test('getWithStale: três estados — fresco, expirado na graça, fora da janela', async () => {
  // Contrato do SWR: dentro do TTL o valor sai fresco; entre o TTL e o fim da
  // graça sai stale SEM apagar a entrada (o consumidor responde com ela
  // enquanto revalida); depois da graça, a semântica dura do get().
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete _require.cache[CACHE_MODULE];
    const cache = _require(CACHE_MODULE);

    cache.set('swr:fresh', { n: 1 }, TTL_S);
    assert.deepEqual(cache.getWithStale('swr:fresh', 300), { value: { n: 1 }, stale: false });

    // TTL de 50 ms: expira rápido e entra na janela de graça sem espera longa.
    cache.set('swr:grace', { n: 2 }, 0.05);
    cache.set('swr:gone', { n: 3 }, 0.05);
    await sleep(120);

    assert.deepEqual(cache.getWithStale('swr:grace', 300), { value: { n: 2 }, stale: true });
    assert.deepEqual(
      cache.getWithStale('swr:grace', 300),
      { value: { n: 2 }, stale: true },
      'leitura stale não chama forget: a segunda leitura vê a mesma entrada',
    );

    // Fora da janela de graça: null e entrada apagada de vez.
    assert.equal(cache.getWithStale('swr:gone', 0.02), null);
    assert.equal(cache.getWithStale('swr:gone', 300), null, 'a entrada foi apagada, não só escondida');

    // Chave ausente é miss, não stale.
    assert.equal(cache.getWithStale('swr:inexistente', 300), null);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    delete _require.cache[CACHE_MODULE];
  }
});

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
  "insert.run('streams:v4:movie:tt-antigo:{}:account:none', JSON.stringify({ streams: ['antigo'] }), now + 900000);",
  "insert.run('streams:v5:movie:tt-novo:{}:account:none', JSON.stringify({ streams: ['novo'] }), now + 900000);",
  'seed.close();',
  '',
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  // TTL futuro nas duas: a v4 some por ser versão morta, não por expirar.
  "assert.deepStrictEqual(cache.get('streams:v5:movie:tt-novo:{}:account:none'), { streams: ['novo'] }, 'v5 sobe do disco');",
  "assert.strictEqual(cache.get('streams:v4:movie:tt-antigo:{}:account:none'), null, 'v4 nao entra no L1');",
  '',
  // Reabre o banco: o DELETE tem que ter corrido no SQLite, não só no Map.
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const staleRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'streams:v4:%'\").all();",
  "assert.strictEqual(staleRows.length, 0, 'linha streams:v4 apagada do disco');",
  "const liveRows = dbVerify.prepare(\"SELECT key FROM cache WHERE key LIKE 'streams:v5:%'\").all();",
  "assert.strictEqual(liveRows.length, 1, 'linha streams:v5 preservada no disco');",
  'dbVerify.close();',
].join('\n');

test(
  'descarte de versão obsoleta no disco — streams: v4 some, v5 sobe no boot',
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