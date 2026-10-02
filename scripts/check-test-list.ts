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
// A lista explícita mora na chave `testFiles` do package.json (o script
// `npm test` não a carrega mais: no Windows o cmd.exe recusa a linha acima
// de ~8191 caracteres; o runner dist/scripts/run-tests.js a lê daqui).
const testFiles: unknown = _require(path.join(root, 'package.json')).testFiles;
if (!Array.isArray(testFiles) || testFiles.length === 0) {
  console.error('package.json sem "testFiles" (lista explícita de testes)');
  process.exit(1);
}
const listed = new Set<string>(
  (testFiles as string[]).map((p: string) => p.replace(/^dist\//, '')),
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

// Os 6 scripts de bancada (`test:stress`, `test:adversarial`,
// `test:adversarial-m1`, `test:protector-m1`, `test:challenger-m2` e
// `test:ranking-challenger`) executam estes 10 arquivos. A lista é um manifesto
// de propósito: se um script perder um arquivo, o harness sumir do disco ou
// deixar de compilar, a checagem precisa acusar — derivar dos scripts não veria
// a remoção.
const HARNESS_FILES = [
  'test/m1-stress-challenge.ts',
  'test/m1-stress-challenge-protectors.ts',
  'test/stress-m1-challenger.ts',
  'test/empirical-e2e-challenger.ts',
  'test/adversarial-m1-parser-harness.ts',
  'test/adversarial-m1-parser-part2.ts',
  'test/m1-protector-adversarial-stress.ts',
  'test/m1-protector-adversarial-part2.ts',
  'test/challenger-m2-parser-deep-stress.ts',
  'scripts/empirical-ranking-challenger.ts',
];

const allScripts = Object.values(_require(path.join(root, 'package.json')).scripts as Record<string, string>).join(' ');

const harnessErrors: string[] = [];
for (const harness of HARNESS_FILES) {
  const srcPath = path.join(root, harness);
  if (!fs.existsSync(srcPath)) {
    harnessErrors.push(`harness fonte não encontrado: ${harness}`);
  }
  const jsName = harness.replace(/\.ts$/, '.js');
  const distPath = path.join(root, 'dist', jsName);
  if (!fs.existsSync(distPath)) {
    harnessErrors.push(`harness compilado (dist) não encontrado: dist/${jsName}`);
  }
  if (!allScripts.includes(jsName)) {
    harnessErrors.push(`harness não referenciado em package.json scripts: ${jsName}`);
  }
}

if (missing.length || stale.length || harnessErrors.length) {
  if (missing.length) console.error(`fora do "npm test": ${missing.join(', ')}`);
  if (stale.length) console.error(`no "npm test" mas não existe: ${stale.join(', ')}`);
  if (harnessErrors.length) console.error(`erros nos harnesses:\n  ${harnessErrors.join('\n  ')}`);
  process.exit(1);
}

console.log(`${found.length} arquivo(s) de teste no "npm test", ${HARNESS_FILES.length} harness(es) validados.`);

