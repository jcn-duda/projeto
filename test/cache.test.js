const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Constantes que espelham o que src/utils/cache.js usa internamente.
// Se o teto mudar de propósito, o teste acompanha.
const MAX_ENTRIES = 2000;
const EXTRA = 5; // entradas além do teto: o reload tem que deixar de fora as de TTL mais curto
const TTL_S = 3600;

// node:sqlite é experimental no Node 22+; em Node 18 o módulo de cache segue só
// em memória e o contrato 1 (persistência) não tem o que validar — skip claro.
let hasNodeSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const CACHE_MODULE = require.resolve('../src/utils/cache');

// Helper para executar scripts em processos isolados com banco temporário
function runIsolatedCacheTest(scriptContent) {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  // Banco em tmpdir do SO: o data/cache.db real do repo não pode ser tocado.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-cache-test-'));
  const dbPath = path.join(tempDir, 'cache.db');
  try {
    const res = spawnSync(process.execPath, ['-e', scriptContent], {
      env: { ...process.env, CACHE_DB_PATH: dbPath },
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
  'for (let i = 0; i < total; i++) {',
  "  insert.run('k-' + i, JSON.stringify({ n: i }), base + i * 1000);",
  '}',
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
  `assert.strictEqual(present, ${MAX_ENTRIES}, 'o total continua no teto');`,
].join('\n');

test(
  'reload do SQLite: seleção DESC + ordem reconstruída expulsa o menor TTL selecionado no estouro',
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
    delete require.cache[CACHE_MODULE];
    const cache = require(CACHE_MODULE);

    for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`k-${i}`, { n: i }, TTL_S);

    // Toca na mais antiga: depois do estouro ela tem que continuar viva.
    assert.deepEqual(cache.get('k-0'), { n: 0 }, 'get de entrada válida devolve o valor');

    // Estoura o teto: o prune remove UMA entrada — a menos recentemente usada.
    cache.set('overflow', { n: 'overflow' }, TTL_S);

    assert.deepEqual(cache.get('k-0'), { n: 0 }, 'a entrada tocada sobrevive ao estouro');
    assert.equal(cache.get('k-1'), null, 'a menos recentemente usada (k-1) é a removida');
    assert.deepEqual(cache.get('overflow'), { n: 'overflow' }, 'a nova entrada entra no cache');

    let present = 0;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      if (cache.get(`k-${i}`) !== null) present++;
    }
    if (cache.get('overflow') !== null) present++;
    assert.equal(present, MAX_ENTRIES, 'o total continua dentro do teto após o estouro');
  } finally {
    // Restaura o ambiente do processo pai: não depende do isolamento do runner.
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

const PERSISTENCE_SYNC_SCRIPT = [
  "const assert = require('node:assert');",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = require('node:sqlite');",
  `delete require.cache[${JSON.stringify(CACHE_MODULE)}];`,
  `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
  '',
  "cache.set('k-a', { msg: 'hello' }, 3600);",
  "cache.set('k-b', { count: 99 }, 3600);",
  "cache.set('k-c', { active: true }, 3600);",
  'assert.strictEqual(cache.size(), 3);',
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
  `assert.strictEqual(cache.size(), ${MAX_ENTRIES}, 'L1 respeita MAX_ENTRIES apos overflow');`,
  'const dbVerify = new DatabaseSync(process.env.CACHE_DB_PATH);',
  "const countRow = dbVerify.prepare('SELECT COUNT(*) as cnt FROM cache').get();",
  `assert.strictEqual(countRow.cnt, ${MAX_ENTRIES}, 'SQLite reflete MAX_ENTRIES apos prune em lote');`,
  "assert.strictEqual(cache.get('item-0'), null, 'item-0 expulso como LRU');",
  "assert.strictEqual(cache.get('item-9'), null, 'item-9 expulso como LRU');",
  `assert.deepStrictEqual(cache.get('item-' + (total - 1)), { n: total - 1 }, 'item mais recente permanece');`,
  'dbVerify.close();',
].join('\n');

test(
  'prune() e forgetMany(): remoção em lote via transação SQLite com statement pré-compilado',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(PRUNE_BATCH_SCRIPT);
  },
);

test('modo sem persistência (CACHE_PERSIST="false"): operações puras em memória com statements nulos', () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete require.cache[CACHE_MODULE];
    const cache = require(CACHE_MODULE);

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
    delete require.cache[CACHE_MODULE];
    const cache = require(CACHE_MODULE);

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
    delete require.cache[CACHE_MODULE];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
