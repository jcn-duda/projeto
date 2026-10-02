import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// De dist/test/ a raiz do repositório fica dois níveis acima.
const root = path.join(__dirname, '..', '..');

// Os seis testes que carregavam o cache.js ESM via require()/require.cache. A
// conversão os levou a import() nativo; este guard impede a regressão silenciosa
// (um require.cache esquecido voltaria a "funcionar" no Node 22 e só quebraria
// onde require(esm) não existe).
const TARGETS = [
  'cache.test.ts',
  'cache-sqlite.test.ts',
  'cache-namespaces.test.ts',
  'challenger-m1-debrid.test.ts',
  'magnet-db-persistence.test.ts',
  'magnet-db-empirical-challenge.test.ts',
];

// Quem dispara `node -e` para os contratos de persistência precisa pedir ESM
// explícito: o corpo dos scripts usa import/TLA, não CommonJS.
const SPAWNERS = [
  'cache.test.ts',
  'cache-sqlite.test.ts',
  'challenger-m1-debrid.test.ts',
  'magnet-db-persistence.test.ts',
  'magnet-db-empirical-challenge.test.ts',
];

test('testes de cache/magnetdb não voltam a carregar cache.js ESM via require()/require.cache', () => {
  for (const name of TARGETS) {
    const src = fs.readFileSync(path.join(root, 'test', name), 'utf8');
    assert.ok(!src.includes('createRequire'), `${name} ainda usa createRequire`);
    assert.ok(!src.includes('require.cache'), `${name} ainda usa require.cache`);
    assert.ok(!/\brequire\s*\(/.test(src), `${name} ainda usa require()`);
  }
});

test('scripts filhos dos testes de cache/magnetdb rodam como ESM explícito', () => {
  for (const name of SPAWNERS) {
    const src = fs.readFileSync(path.join(root, 'test', name), 'utf8');
    assert.ok(src.includes("'--input-type=module'"), `${name} não força --input-type=module nos filhos`);
  }
});
