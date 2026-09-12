#!/usr/bin/env node
/**
 * Roda `node --test` sobre a lista EXPLÍCITA de arquivos em `testFiles`
 * (package.json). A lista vive fora da linha do script `npm test` porque no
 * Windows o cmd.exe recusa linha de comando acima de ~8191 caracteres
 * ("Linha de comando muito longa") — e a lista cresceu além disso.
 *
 * O spawn usa array de argumentos (sem shell), o que contorna esse limite
 * (CreateProcess aceita ~32k) sem dependência nova e sem virar glob — a
 * lista continua explícita e cobrada pelo check-test-list.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// De dist/scripts/ o package.json fica um nível acima; de scripts/, dois.
const up = path.join(__dirname, '..');
const root = fs.existsSync(path.join(up, 'package.json')) ? up : path.join(up, '..');

const pkg = _require(path.join(root, 'package.json'));
const testFiles: string[] = pkg.testFiles;
if (!Array.isArray(testFiles) || testFiles.length === 0) {
  console.error('package.json sem "testFiles" (lista explícita de testes) — recusando a rodar.');
  process.exit(1);
}

// Entradas são caminhos de FONTE (test/…); o build compila .ts → .js em dist/.
const distFiles = testFiles.map((f: string) => path.join(root, 'dist', f.replace(/\.ts$/, '.js')));
for (const f of distFiles) {
  if (!fs.existsSync(f)) {
    console.error(`arquivo de teste compilado não encontrado: ${path.relative(root, f)} — rode npm run build.`);
    process.exit(1);
  }
}

const child = spawn(
  process.execPath,
  ['--test', '--import', './dist/test/setup-env.js', ...distFiles.map((f) => path.relative(root, f))],
  { cwd: root, stdio: 'inherit' },
);
child.on('close', (code) => process.exit(code ?? 1));
