#!/usr/bin/env node
/**
 * Golden `magnet-bank-source` — reserva do banco (`pickSource`,
 * `src/providers/magnet-bank-fallback.ts`).
 *
 * Geração: `node scripts/golden/dump-magnet-bank-source.mjs` mede o `dist` REAL
 * pelo oráculo isolado (`golden-kit.mjs`) e grava
 * `rust/golden/magnet-bank-source.jsonl` + manifest. `--check`: só leitura.
 *
 * O oráculo é compartilhado com o golden `magnet-bank-instant` (mesmo child,
 * funções de dois módulos); este dump declara qual FONTE o manifest prende.
 */
import path from 'node:path';
import {
  fail, parseArgs, resolveCliPath, requireFreshDist, loadCorpus, runOracle,
  renderJsonl, buildManifest, generate, check, toPosix,
} from './golden-kit.mjs';

const REGISTRY = 'magnet-bank-source/pickSource';
const NAME = 'pickSource';
const SOURCE = 'src/providers/magnet-bank-fallback.ts';
const ARTIFACT = 'dist/src/providers/magnet-bank-fallback.js';
const ORACLE = 'scripts/golden/search-bank-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-magnet-bank-source.json';
const OUT_JSONL = 'rust/golden/magnet-bank-source.jsonl';
const OUT_MANIFEST = 'rust/golden/magnet-bank-source.manifest.json';
const OPS = ['pickSource'];

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
