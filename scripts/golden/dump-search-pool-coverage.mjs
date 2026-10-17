#!/usr/bin/env node
/**
 * Golden `search-pool-coverage` — cobertura por pool (F-1).
 *
 * Geração: `node scripts/golden/dump-search-pool-coverage.mjs` importa o `dist`
 * REAL do oráculo (`search-pool-coverage-oracle.mjs`) sobre
 * `corpus-search-pool-coverage.json` e grava
 * `rust/golden/search-pool-coverage.jsonl` + manifest. Determinístico: sem
 * timestamp. `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar,
 * vazio ou divergir (hash, comportamento do dist vivo, fonte alterada,
 * contagem).
 *
 * ORÁCULO DO ESM: o corpo TS de `src/providers/search-pool-coverage.ts` saiu
 * deste branch (virou casca do núcleo), então quem mede é o TypeScript do branch
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

const REGISTRY = 'search-pool-coverage/poolCovered';
const NAME = 'poolCovered';
const SOURCE = 'src/providers/search-pool-coverage.ts';
const ARTIFACT = 'dist/src/providers/search-pool-coverage.js';
const ORACLE = 'scripts/golden/search-pool-coverage-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-search-pool-coverage.json';
const OUT_JSONL = 'rust/golden/search-pool-coverage.jsonl';
const OUT_MANIFEST = 'rust/golden/search-pool-coverage.manifest.json';
const OPS = ['pool', 'idx'];

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
