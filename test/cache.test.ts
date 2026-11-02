import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prefix } from '../src/utils/cache-keys.js';
import { kvClearPrefix, kvForget, kvPeek, kvSetForTest } from '../src/utils/native-kv.js';

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
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

// Caminho absoluto do módulo compilado, num único lugar. Os testes do processo
// pai recarregam com query única para nascer limpos (o cache.ts é dono de todo o
// estado mutável); os processos filhos importam SEM query para que o `./cache.js`
// interno do magnetdb aponte para a MESMA instância.
const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
const freshCache = (): Promise<any> => import(`${CACHE_URL}?fresh=${Date.now()}-${cacheSeq++}`);

test(
  'cache.ts recovery: erro transiente (caminho do banco é um diretório) NÃO gera .corrupt e cai em memória',
  { skip: !hasNodeSqlite && 'node:sqlite unavailable' },
  () => {
    const script = `
      import assert from 'node:assert';
      import fs from 'node:fs';
      delete process.env.CACHE_PERSIST;
      const dbPath = process.env.CACHE_DB_PATH;
      fs.mkdirSync(dbPath); // abertura falha sem ser corrupção (CANTOPEN/EISDIR)
      const cache = await import(${JSON.stringify(CACHE_URL)});

      // L1 memória segue de pé e o dado persistido NÃO é destruído.
      cache.set('test:transient', { ok: 1 }, 3600);
      assert.deepStrictEqual(cache.get('test:transient'), { ok: 1 });
      assert.strictEqual(fs.existsSync(dbPath + '.corrupt'), false, '.corrupt criado por erro transiente');
      assert.strictEqual(fs.statSync(dbPath).isDirectory(), true, 'caminho original alterado');
    `;
    runIsolatedCacheTest(script);
  },
);

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

test('get() de entrada válida renova a recência: no estouro ela sobrevive e o LRU válido sai', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    // Sem SQLite: o contrato 2 é sobre a ordem do Map em memória.
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

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

test('setMany: lote com UMA evicção por namespace — as mais antigas saem, as do lote ficam', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

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

// A escrita no disco é diferida para o próximo tick (lote em transação única),
// então o script espera um setImmediate antes de conferir o SQLite.
const PERSISTENCE_SYNC_SCRIPT = [
  "import assert from 'node:assert';",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = await import('node:sqlite');",
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
  '',
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
  "assert.deepStrictEqual(rowsAfterForget.map(r => r.key), ['k-a', 'k-b', 'k-c'], 'forget não apaga do arquivo (F4)');",
  '',
  'cache.clear();',
  'assert.strictEqual(cache.size(), 0);',
  "const rowsAfterClear = dbVerify.prepare('SELECT COUNT(*) as cnt FROM cache').get();",
  'assert.strictEqual(rowsAfterClear.cnt, 0, \'tabela SQLite limpa apos clear()\');',
  'dbVerify.close();',
].join('\n');

test(
  'persist grava no SQLite, forget fica no L1 e clear trunca a tabela',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(PERSISTENCE_SYNC_SCRIPT);
  },
);

const PRUNE_BATCH_SCRIPT = [
  "import assert from 'node:assert';",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = await import('node:sqlite');",
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
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

test(
  'prune(): as chaves expulsas saem da fila e o disco recebe só o teto',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(PRUNE_BATCH_SCRIPT);
  },
);

// Regressão do despejo em lote: forget ANTES do flush não pode ser desfeito
// pelo lote (a chave sai da fila junto com a memória).
const BATCH_FORGET_SCRIPT = [
  "import assert from 'node:assert';",
  'delete process.env.CACHE_PERSIST;',
  "const { DatabaseSync } = await import('node:sqlite');",
  `const cache = await import(${JSON.stringify(CACHE_URL)});`,
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
].join('\n');

test(
  'despejo em lote: forget/reescrita no mesmo tick valem na gravação adiada',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    runIsolatedCacheTest(BATCH_FORGET_SCRIPT);
  },
);

// C3 (F5.11): paridade do clear() com o clearNamespace no KV nativo. `adhold`
// sai pela ponte; `harvest` NÃO sai — dono é o gateway (fila/journal do
// colhedor), e o clear dele é a admin (`POST /harvest/clear`), não esta ponte.
test('clearNamespace: adhold alcança o KV nativo; harvest não toca a fila do gateway', async () => {
  const cache = await freshCache();
  const holdKey = `${prefix('adhold')}conta:${'a'.repeat(40)}`;
  const fila = `${prefix('harvest')}q`;
  kvClearPrefix(prefix('adhold'));
  kvSetForTest(holdKey, { at: 1 }, 600);
  kvSetForTest(fila, { at: 1 }, 600);
  try {
    assert.equal(cache.clearNamespace('adhold'), 1, 'a ponte removeu o hold semeado');
    assert.equal(kvPeek(holdKey), null, 'hold saiu do KV nativo');
    assert.equal(cache.clearNamespace('harvest'), 0, 'harvest não tem entrada no dispatch nativo do Node');
    assert.ok(kvPeek(fila) !== null, 'a fila do colhedor permanece no KV');
  } finally {
    kvForget(holdKey);
    kvForget(fila);
  }
});
