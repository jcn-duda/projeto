#!/usr/bin/env node
/**
 * Paridade TS x Rust em dado real: lê os títulos/magnets de um magnets.db
 * (SQLite, somente leitura) e compara o veredito do TS com o do napi em lote.
 *
 * Uso: node scripts/rust/parity-real.mjs <caminho/magnets.db> [limite]
 *
 * Pré-requisitos: `npx tsc -p tsconfig.json` (dist/ atualizado) e o binário
 * dist/rust/adom_napi.node. Roda duas rodadas: sem nome da obra (exercita o
 * que não depende de matching) e com a primeira palavra longa do título como
 * nome (exercita matchesBrTitle).
 */
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

const dbPath = process.argv[2];
const limit = process.argv[3] ? Number(process.argv[3]) : Infinity;
if (!dbPath) {
  console.error('uso: node scripts/rust/parity-real.mjs <magnets.db> [limite]');
  process.exit(2);
}

const shadow = await import(pathToFileURL(path.join(root, 'dist/src/utils/rust-shadow.js')).href);
const { buildProbes, tsVerdict, compareBatch } = shadow;

const napiPath = path.join(root, 'dist/rust/adom_napi.node');
const napi = require(napiPath);
if (typeof napi.evaluateReleases !== 'function') {
  console.error(`evaluateReleases ausente em ${napiPath}; recompile o núcleo Rust.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('select title, uri from magnet').all();
db.close();

const selected = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
const items = selected.map((r) => ({ title: String(r.title ?? ''), magnet: String(r.uri ?? '') }));
console.log(`magnets lidos: ${rows.length}; avaliados: ${items.length}`);

// Primeira palavra longa (>= 5 letras) do título; nome de teste para matchesBrTitle.
function longWord(title) {
  const m = title.match(/[\p{L}]{5,}/u);
  return m ? m[0] : '';
}

const BATCH = 2000;

function runRound(label, makeProbes) {
  const probes = makeProbes();
  const tsList = probes.map((p) => tsVerdict(p));
  const rustList = [];
  for (let i = 0; i < probes.length; i += BATCH) {
    rustList.push(...napi.evaluateReleases(probes.slice(i, i + BATCH)));
  }
  const diffs = compareBatch(probes, tsList, rustList);
  const byField = new Map();
  for (const d of diffs) byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
  console.log(`\n== rodada: ${label} ==`);
  console.log(`total: ${probes.length}; divergências: ${diffs.length}`);
  for (const [field, n] of [...byField.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field}: ${n}`);
  }
  for (const d of diffs.slice(0, 10)) {
    console.log(`  #${d.index} [${d.field}] ${JSON.stringify(d.title)}\n    ts=${JSON.stringify(d.ts)}\n    rust=${JSON.stringify(d.rust)}`);
  }
  return diffs.length;
}

const a = runRound("sem nome (names=[], isSeries=false)", () =>
  buildProbes(items, { names: [], year: null, isSeries: false }, Number.MAX_SAFE_INTEGER));
// buildProbes usa um nome só por lote; cada item recebe o seu (uma sonda por chamada).
const b = runRound("com nome (primeira palavra longa de cada título)", () =>
  items.map((it) => buildProbes([it], { names: [longWord(it.title)], year: null, isSeries: false }, 1)[0]));
process.exitCode = a + b > 0 ? 1 : 0;
