#!/usr/bin/env node
/**
 * Golden `autofetch-expired` — guarda de posse do expired-unready.
 *
 * Geração: `node scripts/golden/dump-autofetch-expired.mjs` roda o oráculo
 * sobre `corpus-autofetch-expired.json` e grava
 * `rust/golden/autofetch-expired.jsonl` + manifest.
 *
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar ou divergir.
 * `--force`: regenera mesmo se a fonte mudou.
 */
import {
  parseArgs, resolveCliPath, requireFreshDist, loadCorpus, renderJsonl,
  buildManifest, generate, check, runOracle, REPO,
} from './golden-kit.mjs';
import path from 'node:path';

const REGISTRY = 'autofetch-expired/expiredRemovalAllowed';
const NAME = 'expiredRemovalAllowed';
const SOURCE = 'src/providers/autofetch-expired.ts';
const ARTIFACT = 'dist/src/providers/autofetch-expired.js';
const ORACLE = 'scripts/golden/autofetch-expired-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-autofetch-expired.json';
const OUT_JSONL = 'rust/golden/autofetch-expired.jsonl';
const OUT_MANIFEST = 'rust/golden/autofetch-expired.manifest.json';
const DIST_SOURCES = ['src/providers/autofetch-expired.ts'];

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFreshDist(ARTIFACT, DIST_SOURCES);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
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
  process.exit(1);
}
