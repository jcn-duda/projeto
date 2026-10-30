import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Rotulo legivel -> infoHash de 40 hex de verdade. O magnetdb so grava hash no
 * formato que `parseMagKey` aceita de volta; hash de brinquedo criaria chave
 * fisica que a recontagem nao conta, e o teste passaria sem provar nada.
 */
const MH = (label: string) => createHash('sha1').update(label).digest('hex');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

// URLs absolutas dos módulos compilados. Os filhos importam cache/magnetdb SEM
// query: assim o `./cache.js` interno do magnetdb resolve para a MESMA instância.
const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
const MAGNETDB_URL = new URL('../src/utils/magnetdb.js', import.meta.url).href; const MAGNETDB_WRITES_URL = new URL('./helpers/pipeline-oracle/play/magnetdb-writes.js', import.meta.url).href;
const CACHE_KEYS_URL = new URL('../src/utils/cache-keys.js', import.meta.url).href;
const REQUEST_KEY_URL = new URL('../src/utils/request-key.js', import.meta.url).href;
const DEBRID_STATE_URL = new URL('../src/utils/debrid-state-native.js', import.meta.url).href;

function runMultiStageTest(scripts: string[]) {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-mag-adversarial-test-'));
  const dbPath = path.join(tempDir, 'cache.db');
  try {
    for (const scriptContent of scripts) {
      // `--input-type=module`: o corpo é ESM nativo (imports/TLA), nunca CJS.
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', scriptContent], {
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
  'adversarial: transicoes de estado rapidas (alive -> bad -> forgetBad -> alive com estresse em laco)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "import assert from 'node:assert';",
      "import { createHash } from 'node:crypto';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "const H = (s) => createHash('sha1').update(String(s)).digest('hex');",
      "",
      "// 1. Transicao unica com verificacao detalhada de contadores e recusa",
      "magnetdbWrites.markAlive('premiumize', 'acc1', ['" + MH('hash-rapid-1') + "']);",
      "assert.strictEqual(magnetdbWrites.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), true);",
      "assert.strictEqual(magnetdbWrites.isBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 1);",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 1);",
      "",
      "// 2. alive -> bad (bad deve sobrepor alive imediatamente)",
      "magnetdbWrites.markBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "');",
      "assert.strictEqual(magnetdbWrites.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "assert.strictEqual(magnetdbWrites.isBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), true);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 1);",
      "",
      "// 3. Tentativa de re-marcar alive enquanto bad deve ser recusada",
      "magnetdbWrites.markAlive('premiumize', 'acc1', ['" + MH('hash-rapid-1') + "']);",
      "assert.strictEqual(magnetdbWrites.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 1);",
      "",
      "// 4. bad -> forgetBad (limpa o bad)",
      "const removed = magnetdbWrites.forgetBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "');",
      "assert.strictEqual(removed, true);",
      "assert.strictEqual(magnetdbWrites.isBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 0);",
      "",
      "// 5. forgetBad -> alive (agora markAlive e aceito novamente)",
      "magnetdbWrites.markAlive('premiumize', 'acc1', ['" + MH('hash-rapid-1') + "']);",
      "assert.strictEqual(magnetdbWrites.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), true);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 1);",
      "assert.strictEqual(st.sizeBad, 0);",
      "",
      "// 6. Estresse em laco rapido (50 ciclos em 3 hashes distintos)",
      "const testHashes = ['loop-h1', 'loop-h2', 'loop-h3'].map(H);",
      "for (let i = 0; i < 50; i++) {",
      "  magnetdbWrites.markAlive('premiumize', 'acc1', testHashes);",
      "  st = magnetdb.status();",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 4); // 1 preexistente + 3",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "",
      "  for (const h of testHashes) {",
      "    magnetdbWrites.markBad('premiumize', 'acc1', h);",
      "  }",
      "  st = magnetdb.status();",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 1);",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 3);",
      "",
      "  for (const h of testHashes) {",
      "    magnetdbWrites.forgetBad('premiumize', 'acc1', h);",
      "  }",
      "  st = magnetdb.status();",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 1);",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "}",
      "",
      "// Deixa todos como alive antes de persistir",
      "magnetdbWrites.markAlive('premiumize', 'acc1', testHashes);",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "import assert from 'node:assert';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 4, '4 hashes vivos devem persistir apos o laco');",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 4);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'adversarial: isolamento e concorrencia entre 5 adaptadores com hashes sobrepostos',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "import assert from 'node:assert';",
      "import { createHash } from 'node:crypto';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "const H = (s) => createHash('sha1').update(String(s)).digest('hex');",
      "",
      "const adapters = ['premiumize', 'torbox', 'alldebrid', 'realdebrid', 'debridlink'];",
      "const sharedHash = H('shared-target-hash-12345');",
      "",
      "// Hash compartilhado com estados contraditorios em adapters diferentes:",
      "// premiumize: alive",
      "// torbox: bad",
      "// alldebrid: lie",
      "// realdebrid: alive",
      "// debridlink: bad",
      "magnetdbWrites.markAlive('premiumize', 'key-pm', [sharedHash]);",
      "magnetdbWrites.markBad('torbox', 'key-tb', sharedHash);",
      "magnetdbWrites.markLie('alldebrid', 'key-ad', sharedHash);",
      "magnetdbWrites.markAlive('realdebrid', 'key-rd', [sharedHash]);",
      "magnetdbWrites.markBad('debridlink', 'key-dl', sharedHash);",
      "",
      "// Verifica isolamento absoluto: estado em um adapter nao contamina outro",
      "assert.strictEqual(magnetdbWrites.isAlive('premiumize', 'key-pm', sharedHash), true);",
      "assert.strictEqual(magnetdbWrites.isBad('premiumize', 'key-pm', sharedHash), false);",
      "assert.strictEqual(magnetdbWrites.isBad('torbox', 'key-tb', sharedHash), true);",
      "assert.strictEqual(magnetdbWrites.isAlive('torbox', 'key-tb', sharedHash), false);",
      "assert.strictEqual(magnetdbWrites.isLie('alldebrid', 'key-ad', sharedHash), true);",
      "assert.strictEqual(magnetdbWrites.isAlive('realdebrid', 'key-rd', sharedHash), true);",
      "assert.strictEqual(magnetdbWrites.isBad('debridlink', 'key-dl', sharedHash), true);",
      "",
      "// Adiciona chaves adicionais por adapter de forma concorrente/intercalada",
      "for (let i = 1; i <= 5; i++) {",
      "  magnetdbWrites.markAlive('premiumize', 'key-pm', [H('pm-' + i)]);",
      "  magnetdbWrites.markAlive('torbox', 'key-tb', [H('tb-' + i)]);",
      "  magnetdbWrites.markAlive('alldebrid', 'key-ad', [H('ad-' + i)]);",
      "  magnetdbWrites.markAlive('realdebrid', 'key-rd', [H('rd-' + i)]);",
      "  magnetdbWrites.markAlive('debridlink', 'key-dl', [H('dl-' + i)]);",
      "}",
      "",
      "const st = magnetdb.status();",
      "// premiumize: 1 shared + 5 = 6 alive, 0 bad, 0 lie",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 6);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "// torbox: 5 alive, 1 bad, 0 lie",
      "assert.strictEqual(st.byAdapter.torbox?.sizeAlive, 5);",
      "assert.strictEqual(st.byAdapter.torbox?.sizeBad, 1);",
      "// alldebrid: 5 alive, 0 bad, 1 lie",
      "assert.strictEqual(st.byAdapter.alldebrid?.sizeAlive, 5);",
      "assert.strictEqual(st.byAdapter.alldebrid?.sizeLie, 1);",
      "// realdebrid: 1 shared + 5 = 6 alive, 0 bad, 0 lie",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeAlive, 6);",
      "// debridlink: 5 alive, 1 bad, 0 lie",
      "assert.strictEqual(st.byAdapter.debridlink?.sizeAlive, 5);",
      "assert.strictEqual(st.byAdapter.debridlink?.sizeBad, 1);",
      "",
      "// Totais globais consolidados",
      "assert.strictEqual(st.sizeAlive, 27);",
      "assert.strictEqual(st.sizeBad, 2);",
      "assert.strictEqual(st.sizeLie, 1);",
      "",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "import assert from 'node:assert';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 27);",
      "assert.strictEqual(st.sizeBad, 2);",
      "assert.strictEqual(st.sizeLie, 1);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 6);",
      "assert.strictEqual(st.byAdapter.torbox?.sizeBad, 1);",
      "assert.strictEqual(st.byAdapter.alldebrid?.sizeLie, 1);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'adversarial: idempotencia estrita contra double-increment (markAlive, renewAlive, markBad, markLie)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "import assert from 'node:assert';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "",
      "// 1. Array com duplicatas e normalizacao case-insensitive",
      "magnetdbWrites.markAlive('torbox', 'acc1', ['" + MH('a').toUpperCase() + "', '" + MH('a') + "', '" + MH('b').toUpperCase() + "', '" + MH('b') + "']);",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, '2 hashes unicos case-insensitive');",
      "",
      "// 2. Chamada repetida exatamente igual nao pode incrementar",
      "magnetdbWrites.markAlive('torbox', 'acc1', ['" + MH('a').toUpperCase() + "', '" + MH('b').toUpperCase() + "']);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, 'repeticao deve manter 2');",
      "",
      "// 3. Chamada com mistura de existente e novo",
      "magnetdbWrites.markAlive('torbox', 'acc1', ['" + MH('a') + "', '" + MH('c') + "']);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 3, 'apenas o novo hash_c deve incrementar para 3');",
      "",
      "// 4. renewAlive nao deve duplicar contadores",
      "magnetdbWrites.renewAlive('torbox', 'acc1', ['" + MH('a') + "', '" + MH('b') + "', '" + MH('c') + "']);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 3, 'renewAlive nao pode duplicar');",
      "",
      "// 5. Idempotencia de markBad",
      "magnetdbWrites.markBad('torbox', 'acc1', '" + MH('bad-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1);",
      "magnetdbWrites.markBad('torbox', 'acc1', '" + MH('bad-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1, 'markBad repetido deve manter 1');",
      "",
      "// 6. Idempotencia de markLie",
      "magnetdbWrites.markLie('torbox', 'acc1', '" + MH('lie-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeLie, 1);",
      "magnetdbWrites.markLie('torbox', 'acc1', '" + MH('lie-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeLie, 1, 'markLie repetido deve manter 1');",
      "",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "import assert from 'node:assert';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 3);",
      "assert.strictEqual(st.sizeBad, 1);",
      "assert.strictEqual(st.sizeLie, 1);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'adversarial: evicção nativa (forgetBad/forgetBadOf/poda), sem underflow e sem segundo escritor',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "import assert from 'node:assert';",
      "import { createHash } from 'node:crypto';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      `const { magnetState } = await import(${JSON.stringify(DEBRID_STATE_URL)});`,
      `const { prefix } = await import(${JSON.stringify(CACHE_KEYS_URL)});`,
      `const { accountScope } = await import(${JSON.stringify(REQUEST_KEY_URL)});`,
      "const H = (s) => createHash('sha1').update(String(s)).digest('hex');",
      "",
      "// Insere 4 alive, 2 bad, 1 lie para realdebrid",
      "const hashes = ['ev-1', 'ev-2', 'ev-3', 'ev-4'].map(H);",
      "magnetdbWrites.markAlive('realdebrid', 'acc1', hashes);",
      "magnetdbWrites.markBad('realdebrid', 'acc1', '" + MH('ev-bad-1') + "');",
      "magnetdbWrites.markBad('realdebrid', 'acc1', '" + MH('ev-bad-2') + "');",
      "magnetdbWrites.markLie('realdebrid', 'acc1', '" + MH('ev-lie-1') + "');",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 4);",
      "assert.strictEqual(st.sizeBad, 2);",
      "assert.strictEqual(st.sizeLie, 1);",
      "// 1. mag é do Rust: `cache.forgetMany` com chave mag é NO-OP.",
      "// Um segundo escritor apagaria linha fresca que o núcleo ainda conta.",
      "const scope = accountScope('acc1');",
      "const magP = prefix('mag');",
      "const aliveKey1 = `${magP}alive:realdebrid:${scope}:${H('ev-1')}`;",
      "const aliveKey2 = `${magP}alive:realdebrid:${scope}:${H('ev-2')}`;",
      "const badKey1 = `${magP}bad:realdebrid:${scope}:${H('ev-bad-1')}`;",
      "cache.forgetMany([aliveKey1, aliveKey2, badKey1, 'stream:v11:some-other-key', `${magP}alive:realdebrid:${scope}:ghost`]);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 4, 'o Node não evicta mag: alive intacto');",
      "assert.strictEqual(st.sizeBad, 2, 'o Node não evicta mag: bad intacto');",
      "assert.strictEqual(magnetState().state('realdebrid', 'acc1', H('ev-1'), Date.now()), 'alive', 'a linha nativa continua lá');",
      "// 2. Evicção de verdade: forgetBad (por conta) decrementa e é idempotente",
      "assert.strictEqual(magnetdbWrites.forgetBad('realdebrid', 'acc1', '" + MH('ev-bad-1') + "'), true);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1, 'bad decrementado de 2 para 1');",
      "assert.strictEqual(magnetdbWrites.forgetBad('realdebrid', 'acc1', '" + MH('ev-bad-1') + "'), false, 'idempotente');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1, 'segunda passada não decrementa de novo (sem underflow)');",
      "// 3. forgetBadOf (sem apiKey) apaga em TODAS as contas e baixa o agregado",
      "assert.strictEqual(magnetdb.forgetBadOf('realdebrid', '" + MH('ev-bad-2') + "'), true);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeBad ?? 0, 0);",
      "assert.strictEqual(magnetdb.forgetBadOf('realdebrid', '" + MH('ev-bad-2') + "'), false, 'idempotente');",
      "// 4. alive/lie saem pela varredura nativa — o ÚNICO caminho que apaga e contabiliza",
      "const realNow = Date.now;",
      "Date.now = () => realNow() + 8 * 86400 * 1000;",
      "try { magnetdb.sweepNativeNamespaces(); } finally { Date.now = realNow; }",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'alive chega a 0 pela poda nativa');",
      "assert.strictEqual(st.sizeLie, 0, 'lie vencido também é contabilizado');",
      "assert.strictEqual(st.l1Entries, 0, 'nenhuma linha viva sobrou no núcleo');",
      "assert.deepStrictEqual(Object.keys(st.byAdapter), [], 'namespace vazio zera a amostra (sem divisão por zero)');",
      "// 5. Poda repetida não decrementa abaixo de zero",
      "Date.now = () => realNow() + 9 * 86400 * 1000;",
      "try { magnetdb.sweepNativeNamespaces(); } finally { Date.now = realNow; }",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'garantia de não-underflow');",
      "assert.strictEqual(st.sizeLie, 0);",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeAlive ?? 0, 0);",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "import assert from 'node:assert';",
      "delete process.env.CACHE_PERSIST;",
      `const cache = await import(${JSON.stringify(CACHE_URL)});`,
      `const magnetdb = await import(${JSON.stringify(MAGNETDB_URL)}); const magnetdbWrites = await import(${JSON.stringify(MAGNETDB_WRITES_URL)});`,
      "const st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'alive mantem 0 apos restart');",
      "assert.strictEqual(st.sizeBad, 0, 'bad mantem 0 apos restart');",
      "assert.strictEqual(st.sizeLie, 0, 'lie mantem 0 apos restart');",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);
