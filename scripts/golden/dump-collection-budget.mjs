#!/usr/bin/env node
/**
 * Golden `collection-budget` — orçamento da coleta (F-1).
 *
 * Geração: `node scripts/golden/dump-collection-budget.mjs` importa o `dist`
 * REAL do oráculo (`collection-budget-oracle.mjs`) sobre
 * `corpus-collection-budget.json` e grava `rust/golden/collection-budget.jsonl`
 * + manifest. Determinístico: sem timestamp. `--check`: ESTRITAMENTE leitura —
 * falha se golden/manifest faltar, vazio ou divergir (hash, comportamento do dist
 * vivo, fonte alterada, contagem).
 *
 * ORÁCULO DO ESM: o corpo TS de `src/providers/collection-budget.ts` saiu deste
 * branch (virou casca do núcleo), então quem mede é o TypeScript do branch
 * `esm`, num worktree ao lado. O `--check` deste branch delega
 * (`run-esm-golden.mjs`); nada aqui roda o shim como oráculo. Os `.jsonl` são os
 * mesmos dos dois lados; o cargo test confere o Rust contra o mesmo arquivo.
 *
 * Isolamento: ver `golden-kit.mjs` (child com env mínima e dotenv vazio).
 */
import path from 'node:path';
import {
  fail, parseArgs, resolveCliPath, requireFreshDist, loadCorpus, runOracle,
  renderJsonl, buildManifest, generate, check, toPosix,
} from './golden-kit.mjs';

const REGISTRY = 'collection-budget/computeCollectionBudget';
const NAME = 'computeCollectionBudget';
const SOURCE = 'src/providers/collection-budget.ts';
const ARTIFACT = 'dist/src/providers/collection-budget.js';
const ORACLE = 'scripts/golden/collection-budget-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-collection-budget.json';
const OUT_JSONL = 'rust/golden/collection-budget.jsonl';
const OUT_MANIFEST = 'rust/golden/collection-budget.manifest.json';
const OPS = ['budget', 'grace'];

/** Cada `op` do corpus precisa de pelo menos um caso: corpus que perde uma
 * operação reprova ANTES de medir/escrever (senão o golden encolhe calado). */
function coverageViolations(cases) {
  const seen = new Set();
  const violations = [];
  for (const c of cases) {
    let req;
    try {
      req = JSON.parse(c.input);
    } catch {
      violations.push(`${c.id}: input não é JSON`);
      continue;
    }
    if (typeof req.op !== 'string') violations.push(`${c.id}: input sem op`);
    else seen.add(req.op);
  }
  for (const op of OPS) {
    if (!seen.has(op)) violations.push(`op ausente no corpus: ${op}`);
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFreshDist(ARTIFACT, [SOURCE]);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS), (cases) => coverageViolations(cases));
  const { byId } = runOracle(ORACLE, corpus);
  const jsonl = renderJsonl(corpus, byId);
  const manifest = buildManifest({
    registry: REGISTRY, name: NAME, source: SOURCE, artifact: ARTIFACT,
    corpus, outPath: OUT_JSONL, jsonl, config: { corpusPath: CORPUS },
  });
  const outDir = resolveCliPath(args.out, path.dirname(OUT_JSONL));
  const outJsonlAbs = path.join(outDir, path.basename(OUT_JSONL));
  const outManifestAbs = path.join(outDir, path.basename(OUT_MANIFEST));
  if (args.check) {
    check({
      outJsonlAbs, outManifestAbs, jsonl, manifest, corpus, source: SOURCE,
      registry: REGISTRY, name: NAME, artifact: ARTIFACT,
    });
  } else {
    generate({ outJsonlAbs, outManifestAbs, jsonl, manifest, corpus, source: SOURCE, force: args.force });
  }
}

try { main(); } catch (e) {
  console.error(`[golden] FALHA: ${e?.message || e}`);
  console.error(`[golden] destino: ${toPosix(OUT_JSONL)}`);
  process.exit(1);
}
