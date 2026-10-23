#!/usr/bin/env node
/**
 * Catraca de linhas do workspace Rust — par do `npm run lint:lines`.
 *
 * Regra: arquivo novo acima de 400 reprova; arquivo legado listado no baseline
 * só pode DIMINUIR. O baseline é `rust/.line-budget.json`, chave = caminho
 * relativo à raiz do repo. `--bless` regrava o baseline (escape visível no diff).
 *
 * Por que ratchet e não teto absoluto: o teto entrou no CI depois de o código
 * já ter 45 fontes maiores que ele, e o job ficou vermelho/pulado desde então —
 * gate permanentemente desligado não protege nada.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CRATES = path.join(ROOT, 'rust', 'crates');
const BASELINE = path.join(ROOT, 'rust', '.line-budget.json');
const LIMIT = 400;
const SKIP = new Set(['target', 'vendor']);
const BLESS = process.argv.includes('--bless');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.rs')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(CRATES).sort();
if (files.length === 0) {
  console.error('catraca .rs: nenhuma fonte em rust/crates - falha (vazio nao e verde)');
  process.exit(1);
}

const counts = new Map();
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  counts.set(rel, readFileSync(file, 'utf8').split('\n').length - 1);
}

if (BLESS) {
  const over = [...counts].filter(([, n]) => n > LIMIT).sort((a, b) => b[1] - a[1]);
  const body = Object.fromEntries(over);
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`catraca .rs: baseline regravado com ${over.length} arquivo(s)`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error('catraca .rs: baseline ausente ou invalido (rode --bless)');
  process.exit(1);
}

const failures = [];
for (const [rel, n] of counts) {
  const base = baseline[rel];
  if (base == null) {
    if (n > LIMIT) failures.push(`${rel}: ${n} linhas (novo, teto ${LIMIT})`);
    continue;
  }
  if (n > base) failures.push(`${rel}: ${n} linhas (regrediu de ${base})`);
}
for (const rel of Object.keys(baseline)) {
  const n = counts.get(rel);
  if (n == null) console.warn(`catraca .rs: ${rel} sumiu (remova do baseline)`);
  else if (n <= LIMIT) console.warn(`catraca .rs: ${rel} voltou ao teto (${n}); pode sair do baseline`);
}

console.log(`catraca .rs: ${counts.size} fonte(s), baseline ${Object.keys(baseline).length}, teto ${LIMIT}`);
if (failures.length) {
  for (const line of failures) console.error(`ACIMA/REGREDIU: ${line}`);
  process.exit(1);
}
