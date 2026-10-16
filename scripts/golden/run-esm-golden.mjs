#!/usr/bin/env node
/**
 * Ponte local para os goldens cuja fonte TS saiu deste branch (o oráculo é o
 * TypeScript do branch `esm`): o filtro de relevância
 * (`golden:release-filters[...]`) e o de inventário
 * (`golden:inventory-filter[...]`) rodam DENTRO do worktree `../adom-esm`,
 * igual aos passos do `.github/workflows/rust.yml`.
 *
 * Sem o worktree, falha com a instrução exata de montagem — o mesmo contrato
 * dos demais checks de oráculo esm. Nada aqui roda o shim deste branch como
 * oráculo: isso mediria o Rust contra ele mesmo.
 *
 * Uso: node run-esm-golden.mjs <npm-script> [args-passados...]
 * Ex.: node run-esm-golden.mjs golden:release-filters:check
 *      node run-esm-golden.mjs golden:release-filters --force
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESM = path.resolve(REPO, '..', 'adom-esm');

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('[golden-esm] FALHA: falta o nome do script npm (ex.: golden:release-filters:check)');
  process.exit(1);
}
if (!fs.existsSync(path.join(ESM, 'package.json'))) {
  console.error(`[golden-esm] FALHA: worktree do oráculo ausente em ${ESM}`);
  console.error('[golden-esm] O TS destes filtros saiu deste branch; o oráculo é o branch `esm`.');
  console.error('[golden-esm] Monte o worktree e prepare o dist (uma vez):');
  console.error('[golden-esm]   git worktree add ../adom-esm esm');
  console.error('[golden-esm]   cd ../adom-esm && npm ci && npm run build');
  console.error('[golden-esm] Depois rode este comando de novo. No CI (rust.yml) isso é feito sozinho.');
  process.exit(1);
}
if (!fs.existsSync(path.join(ESM, 'dist', 'src', 'utils', 'release-filters.js'))) {
  console.error(`[golden-esm] FALHA: dist do oráculo ausente em ${ESM} (dist/src/utils/release-filters.js).`);
  console.error('[golden-esm] Rode: cd ../adom-esm && npm run build');
  process.exit(1);
}

const r = spawnSync('npm', ['run', script, ...args], { cwd: ESM, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
