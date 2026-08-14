const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Constantes que espelham o que src/utils/cache.js usa internamente (o teto não
// é exportado pelo módulo). Se o teto mudar de propósito, o teste acompanha.
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
    const originalDbPath = process.env.CACHE_DB_PATH;
    const originalPersist = process.env.CACHE_PERSIST;
    // Banco em tmpdir do SO: o data/cache.db real do repo não pode ser lido.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-cache-test-'));
    const dbPath = path.join(tempDir, 'cache.db');
    try {
      const res = spawnSync(process.execPath, ['-e', RELOAD_SCRIPT], {
        env: { ...process.env, CACHE_DB_PATH: dbPath },
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.ifError(res.error);
      assert.strictEqual(
        res.status,
        0,
        'reload não reconstruiu a ordem (LRU = menor TTL selecionado):\n' + res.stdout + res.stderr,
      );
    } finally {
      // Restaura o ambiente do processo pai: o runner não pode ser o único
      // isolamento entre CACHE_DB_PATH/CACHE_PERSIST.
      if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
      else process.env.CACHE_DB_PATH = originalDbPath;
      if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
      else process.env.CACHE_PERSIST = originalPersist;
      // O filho já saiu: conexão fechada, o tmpdir apaga de verdade.
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
