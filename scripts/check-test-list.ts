#!/usr/bin/env node
/**
 * Garante que todo arquivo .test.js sob test/, inclusive subdiretórios, está
 * no script `test` do package.json.
 *
 * A lista é explícita (e não um glob) porque `node --test "test/*.test.js"` só
 * expande padrão a partir do Node 21, e o engines daqui começa no 18. O preço
 * dessa escolha é um arquivo novo passar despercebido: o teste existe, ninguém
 * roda, e o verde do CI não significa nada. Esta checagem cobra a lista.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, '..');
const script = _require(path.join(root, 'package.json')).scripts.test;
const listed = new Set(script.match(/test\/[\w./-]+\.test\.js/g) || []);

function findTests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findTests(fullPath);
    if (!entry.isFile() || !entry.name.endsWith('.test.js')) return [];
    return [path.relative(root, fullPath).split(path.sep).join('/')];
  });
}

const found = findTests(path.join(root, 'test'));

const missing = found.filter((file) => !listed.has(file));
const stale = [...listed].filter((file) => !fs.existsSync(path.join(root, file)));

if (missing.length || stale.length) {
  if (missing.length) console.error(`fora do "npm test": ${missing.join(', ')}`);
  if (stale.length) console.error(`no "npm test" mas não existe: ${stale.join(', ')}`);
  process.exit(1);
}

console.log(`${found.length} arquivo(s) de teste, todos no "npm test".`);
