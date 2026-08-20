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

// Rodando de dist/scripts/ os testes compilados estão em dist/test e o
// package.json um nível acima; de scripts/, tudo mora um nível acima.
const up = path.join(__dirname, '..');
const buildRoot = fs.existsSync(path.join(up, 'package.json')) ? up : null;
const root = buildRoot || path.join(up, '..'); // raiz do package.json
const testsRoot = buildRoot || up; // raiz onde test/ tem os .test.js
const script = _require(path.join(root, 'package.json')).scripts.test;
// As entradas do `npm test` apontam para dist/ (o build compila .ts → .js);
// normaliza para o caminho relativo à raiz sem o prefixo do build.
const listed = new Set<string>(
  (script.match(/(?:dist\/)?test\/[\w./-]+\.test\.js/g) || []).map((p: string) => p.replace(/^dist\//, '')),
);

function findTests(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findTests(fullPath);
    if (!entry.isFile() || !entry.name.endsWith('.test.js')) return [];
    return [path.relative(testsRoot, fullPath).split(path.sep).join('/')];
  });
}

const found = findTests(path.join(testsRoot, 'test'));

const missing = found.filter((file: string) => !listed.has(file));
// A fonte do teste é .ts; o .js listado só existe depois do build (em dist/).
// Checa a existência da fonte, que é o que esta lista se propõe a cobrar.
const stale = [...listed].filter((file) => !fs.existsSync(path.join(root, file.replace(/\.js$/, '.ts'))));

if (missing.length || stale.length) {
  if (missing.length) console.error(`fora do "npm test": ${missing.join(', ')}`);
  if (stale.length) console.error(`no "npm test" mas não existe: ${stale.join(', ')}`);
  process.exit(1);
}

console.log(`${found.length} arquivo(s) de teste, todos no "npm test".`);
