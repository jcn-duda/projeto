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
// Artefatos que os goldens delegados medem no oráculo. O primeiro ausente
// aponta exatamente o que falta buildar; nenhum deles é opcional.
const REQUIRED_DIST = [
  'dist/src/utils/release-filters.js',
  'dist/src/utils/audio-quality.js',
  'dist/src/utils/title-normalization.js',
  'dist/src/utils/stream-trace.js',
  'dist/src/utils/release-index-media.js',
];
const missingDist = REQUIRED_DIST.find((rel) => !fs.existsSync(path.join(ESM, rel)));
if (missingDist) {
  console.error(`[golden-esm] FALHA: dist do oráculo ausente em ${ESM} (${missingDist}).`);
  console.error('[golden-esm] Rode: cd ../adom-esm && npm run build');
  process.exit(1);
}

// Os goldens novos da F-1 (search-plan, collection-budget,
// search-pool-coverage) NÃO têm entrada npm no `package.json` do worktree
// oráculo — ele não é editado por esta fatia. Para esses, o mesmo contrato roda
// com `node` direto: `golden:<nome>[:check]` → `scripts/golden/dump-<nome>.mjs`.
// Se o script existir no package.json do esm, o caminho npm continua valendo
// (é o dos goldens antigos).
function esmHasScript(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ESM, 'package.json'), 'utf8'));
    return typeof pkg?.scripts?.[name] === 'string';
  } catch {
    return false;
  }
}

const r = esmHasScript(script)
  ? spawnSync('npm', ['run', script, ...args], { cwd: ESM, stdio: 'inherit', shell: true })
  : (() => {
    const m = /^golden:([a-z0-9-]+)(:check)?$/.exec(script);
    if (!m) {
      console.error(`[golden-esm] FALHA: o package.json do oráculo não tem o script "${script}"`);
      process.exit(1);
    }
    const dump = path.join('scripts', 'golden', `dump-${m[1]}.mjs`);
    if (!fs.existsSync(path.join(ESM, dump))) {
      console.error(`[golden-esm] FALHA: oráculo sem ${dump} (e sem o script "${script}" no package.json)`);
      process.exit(1);
    }
    return spawnSync(
      process.execPath,
      [dump, ...(m[2] ? ['--check'] : []), ...args],
      { cwd: ESM, stdio: 'inherit' },
    );
  })();
process.exit(r.status ?? 1);
