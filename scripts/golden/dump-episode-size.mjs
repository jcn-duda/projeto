#!/usr/bin/env node
/**
 * Golden `episode-size` — rótulo de tamanho (💾/📦) do título do stream.
 *
 * Geração: `node scripts/golden/dump-episode-size.mjs` importa as funções REAIS
 * do `dist` (via oráculo) sobre `corpus-episode-size.json` e grava
 * `rust/golden/episode-size.jsonl` + manifest.
 *
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar ou divergir.
 * `--force`: regenera mesmo se a fonte mudou.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  parseArgs, resolveCliPath, requireFreshDist, loadCorpus, renderJsonl,
  buildManifest, generate, check, runOracle, REPO,
} from './golden-kit.mjs';

const REGISTRY = 'episode-size/episodeSize';
const NAME = 'episodeSize';
const SOURCE = 'src/providers/episode-size.ts';
const ARTIFACT = 'dist/src/providers/episode-size.js';
const ORACLE = 'scripts/golden/episode-size-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-episode-size.json';
const OUT_JSONL = 'rust/golden/episode-size.jsonl';
const OUT_MANIFEST = 'rust/golden/episode-size.manifest.json';
const DIST_SOURCES = ['src/providers/episode-size.ts'];

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
