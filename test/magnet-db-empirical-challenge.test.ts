import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const _require = createRequire(import.meta.url);

/**
 * Rotulo legivel -> infoHash de 40 hex de verdade. O magnetdb so grava hash no
 * formato que `parseMagKey` aceita de volta; hash de brinquedo criaria chave
 * fisica que a recontagem nao conta, e o teste passaria sem provar nada.
 */
const MH = (label: string) => createHash('sha1').update(label).digest('hex');
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
const REQUEST_KEY_MODULE = _require.resolve('../src/utils/request-key.js');

function runMultiStageTest(scripts: string[]) {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-mag-adversarial-test-'));
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
  'adversarial: transicoes de estado rapidas (alive -> bad -> forgetBad -> alive com estresse em laco)',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const H = (s) => require('node:crypto').createHash('sha1').update(String(s)).digest('hex');",
      "",
      "// 1. Transicao unica com verificacao detalhada de contadores e recusa",
      "magnetdb.markAlive('premiumize', 'acc1', ['" + MH('hash-rapid-1') + "']);",
      "assert.strictEqual(magnetdb.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), true);",
      "assert.strictEqual(magnetdb.isBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 1);",
      "assert.strictEqual(st.sizeBad, 0);",
      "assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 1);",
      "",
      "// 2. alive -> bad (bad deve sobrepor alive imediatamente)",
      "magnetdb.markBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "');",
      "assert.strictEqual(magnetdb.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "assert.strictEqual(magnetdb.isBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), true);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 1);",
      "",
      "// 3. Tentativa de re-marcar alive enquanto bad deve ser recusada",
      "magnetdb.markAlive('premiumize', 'acc1', ['" + MH('hash-rapid-1') + "']);",
      "assert.strictEqual(magnetdb.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 1);",
      "",
      "// 4. bad -> forgetBad (limpa o bad)",
      "const removed = magnetdb.forgetBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "');",
      "assert.strictEqual(removed, true);",
      "assert.strictEqual(magnetdb.isBad('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), false);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0);",
      "assert.strictEqual(st.sizeBad, 0);",
      "",
      "// 5. forgetBad -> alive (agora markAlive e aceito novamente)",
      "magnetdb.markAlive('premiumize', 'acc1', ['" + MH('hash-rapid-1') + "']);",
      "assert.strictEqual(magnetdb.isAlive('premiumize', 'acc1', '" + MH('hash-rapid-1') + "'), true);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 1);",
      "assert.strictEqual(st.sizeBad, 0);",
      "",
      "// 6. Estresse em laco rapido (50 ciclos em 3 hashes distintos)",
      "const testHashes = ['loop-h1', 'loop-h2', 'loop-h3'].map(H);",
      "for (let i = 0; i < 50; i++) {",
      "  magnetdb.markAlive('premiumize', 'acc1', testHashes);",
      "  st = magnetdb.status();",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 4); // 1 preexistente + 3",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "",
      "  for (const h of testHashes) {",
      "    magnetdb.markBad('premiumize', 'acc1', h);",
      "  }",
      "  st = magnetdb.status();",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 1);",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 3);",
      "",
      "  for (const h of testHashes) {",
      "    magnetdb.forgetBad('premiumize', 'acc1', h);",
      "  }",
      "  st = magnetdb.status();",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeAlive, 1);",
      "  assert.strictEqual(st.byAdapter.premiumize?.sizeBad, 0);",
      "}",
      "",
      "// Deixa todos como alive antes de persistir",
      "magnetdb.markAlive('premiumize', 'acc1', testHashes);",
      "magnetdb.savePersistentCounts();",
      "cache.close();",
    ].join('\n');

    const stage2 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
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
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const H = (s) => require('node:crypto').createHash('sha1').update(String(s)).digest('hex');",
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
      "magnetdb.markAlive('premiumize', 'key-pm', [sharedHash]);",
      "magnetdb.markBad('torbox', 'key-tb', sharedHash);",
      "magnetdb.markLie('alldebrid', 'key-ad', sharedHash);",
      "magnetdb.markAlive('realdebrid', 'key-rd', [sharedHash]);",
      "magnetdb.markBad('debridlink', 'key-dl', sharedHash);",
      "",
      "// Verifica isolamento absoluto: estado em um adapter nao contamina outro",
      "assert.strictEqual(magnetdb.isAlive('premiumize', 'key-pm', sharedHash), true);",
      "assert.strictEqual(magnetdb.isBad('premiumize', 'key-pm', sharedHash), false);",
      "assert.strictEqual(magnetdb.isBad('torbox', 'key-tb', sharedHash), true);",
      "assert.strictEqual(magnetdb.isAlive('torbox', 'key-tb', sharedHash), false);",
      "assert.strictEqual(magnetdb.isLie('alldebrid', 'key-ad', sharedHash), true);",
      "assert.strictEqual(magnetdb.isAlive('realdebrid', 'key-rd', sharedHash), true);",
      "assert.strictEqual(magnetdb.isBad('debridlink', 'key-dl', sharedHash), true);",
      "",
      "// Adiciona chaves adicionais por adapter de forma concorrente/intercalada",
      "for (let i = 1; i <= 5; i++) {",
      "  magnetdb.markAlive('premiumize', 'key-pm', [H('pm-' + i)]);",
      "  magnetdb.markAlive('torbox', 'key-tb', [H('tb-' + i)]);",
      "  magnetdb.markAlive('alldebrid', 'key-ad', [H('ad-' + i)]);",
      "  magnetdb.markAlive('realdebrid', 'key-rd', [H('rd-' + i)]);",
      "  magnetdb.markAlive('debridlink', 'key-dl', [H('dl-' + i)]);",
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
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
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
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "",
      "// 1. Array com duplicatas e normalizacao case-insensitive",
      "magnetdb.markAlive('torbox', 'acc1', ['" + MH('a').toUpperCase() + "', '" + MH('a') + "', '" + MH('b').toUpperCase() + "', '" + MH('b') + "']);",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, '2 hashes unicos case-insensitive');",
      "",
      "// 2. Chamada repetida exatamente igual nao pode incrementar",
      "magnetdb.markAlive('torbox', 'acc1', ['" + MH('a').toUpperCase() + "', '" + MH('b').toUpperCase() + "']);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, 'repeticao deve manter 2');",
      "",
      "// 3. Chamada com mistura de existente e novo",
      "magnetdb.markAlive('torbox', 'acc1', ['" + MH('a') + "', '" + MH('c') + "']);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 3, 'apenas o novo hash_c deve incrementar para 3');",
      "",
      "// 4. renewAlive nao deve duplicar contadores",
      "magnetdb.renewAlive('torbox', 'acc1', ['" + MH('a') + "', '" + MH('b') + "', '" + MH('c') + "']);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 3, 'renewAlive nao pode duplicar');",
      "",
      "// 5. Idempotencia de markBad",
      "magnetdb.markBad('torbox', 'acc1', '" + MH('bad-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1);",
      "magnetdb.markBad('torbox', 'acc1', '" + MH('bad-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeBad, 1, 'markBad repetido deve manter 1');",
      "",
      "// 6. Idempotencia de markLie",
      "magnetdb.markLie('torbox', 'acc1', '" + MH('lie-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeLie, 1);",
      "magnetdb.markLie('torbox', 'acc1', '" + MH('lie-idem') + "');",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeLie, 1, 'markLie repetido deve manter 1');",
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
      "assert.strictEqual(st.sizeAlive, 3);",
      "assert.strictEqual(st.sizeBad, 1);",
      "assert.strictEqual(st.sizeLie, 1);",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);

test(
  'adversarial: eviccao via forgetMany, decremento limpo e protecao contra underflow',
  { skip: !hasNodeSqlite && 'node:sqlite indisponível — teste requer Node 22+' },
  () => {
    const stage1 = [
      "delete process.env.CACHE_PERSIST;",
      "const assert = require('node:assert');",
      `const cache = require(${JSON.stringify(CACHE_MODULE)});`,
      `const magnetdb = require(${JSON.stringify(MAGNETDB_MODULE)});`,
      "const H = (s) => require('node:crypto').createHash('sha1').update(String(s)).digest('hex');",
      `const { prefix } = require(${JSON.stringify(CACHE_KEYS_MODULE)});`,
      `const { accountScope } = require(${JSON.stringify(REQUEST_KEY_MODULE)});`,
      "",
      "// Insere 4 alive, 2 bad, 1 lie para realdebrid",
      "const hashes = ['ev-1', 'ev-2', 'ev-3', 'ev-4'].map(H);",
      "magnetdb.markAlive('realdebrid', 'acc1', hashes);",
      "magnetdb.markBad('realdebrid', 'acc1', '" + MH('ev-bad-1') + "');",
      "magnetdb.markBad('realdebrid', 'acc1', '" + MH('ev-bad-2') + "');",
      "magnetdb.markLie('realdebrid', 'acc1', '" + MH('ev-lie-1') + "');",
      "let st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 4);",
      "assert.strictEqual(st.sizeBad, 2);",
      "assert.strictEqual(st.sizeLie, 1);",
      "",
      "// Monta chaves brutas de 2 alive e 1 bad",
      "const scope = accountScope('acc1');",
      "const magP = prefix('mag');",
      "const aliveKey1 = `${magP}alive:realdebrid:${scope}:${H('ev-1')}`;",
      "const aliveKey2 = `${magP}alive:realdebrid:${scope}:${H('ev-2')}`;",
      "const badKey1 = `${magP}bad:realdebrid:${scope}:${H('ev-bad-1')}`;",
      "const nonMagKey = 'stream:v11:some-other-key';",
      "const nonExistentKey = `${magP}alive:realdebrid:${scope}:${H('not-found')}`;",
      "",
      "// 1. Eviccao mista em lote via cache.forgetMany",
      "cache.forgetMany([aliveKey1, aliveKey2, badKey1, nonMagKey, nonExistentKey]);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, 'alive decrementado de 4 para 2');",
      "assert.strictEqual(st.sizeBad, 1, 'bad decrementado de 2 para 1');",
      "assert.strictEqual(st.sizeLie, 1, 'lie intocado');",
      "",
      "// 2. Chamar forgetMany novamente nas mesmas chaves nao pode decrementar (evita underflow)",
      "cache.forgetMany([aliveKey1, aliveKey2, badKey1]);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 2, 'sem chave no cache, nao decrementa');",
      "assert.strictEqual(st.sizeBad, 1);",
      "",
      "// 3. Esvazia completamente alive para verificar comportamento em zero",
      "const aliveKey3 = `${magP}alive:realdebrid:${scope}:${H('ev-3')}`;",
      "const aliveKey4 = `${magP}alive:realdebrid:${scope}:${H('ev-4')}`;",
      "cache.forgetMany([aliveKey3, aliveKey4]);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'alive chega a 0');",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeAlive, 0);",
      "assert.strictEqual(st.byAdapter.realdebrid?.ttlRemainingSeconds.alive, null, 'sem divisao por zero');",
      "",
      "// 4. Teste de sobreeviccao: forgetMany com chaves inexistentes nunca decrementa abaixo de zero",
      "cache.forgetMany([aliveKey3, aliveKey4, `${magP}alive:realdebrid:${scope}:ghost`]);",
      "st = magnetdb.status();",
      "assert.strictEqual(st.sizeAlive, 0, 'garantia de nao-underflow');",
      "assert.strictEqual(st.byAdapter.realdebrid?.sizeAlive, 0);",
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
      "assert.strictEqual(st.sizeAlive, 0, 'alive mantem 0 apos restart');",
      "assert.strictEqual(st.sizeBad, 1, 'bad mantem 1 apos restart');",
      "assert.strictEqual(st.sizeLie, 1, 'lie mantem 1 apos restart');",
      "cache.close();",
    ].join('\n');

    runMultiStageTest([stage1, stage2]);
  },
);
