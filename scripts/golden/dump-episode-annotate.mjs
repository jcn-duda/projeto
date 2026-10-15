#!/usr/bin/env node
/**
 * Golden `episode-annotate` — Parte 5 da migração Rust: os núcleos PUROS de
 * `src/providers/episode-size.ts` (`episodesCovered`, `exactEpisodeBytes`,
 * `annotatePackSizes`, `annotateMovieSizes`, `fillMissingSizes`,
 * `fillTorrentTotals`). O IO (`fsz`/`tsz`) fica no oráculo, que popula o memo
 * antes de medir cada caso.
 *
 * Geração: `node scripts/golden/dump-episode-annotate.mjs` (rode `npm run
 * build` antes) grava `rust/golden/episode-annotate.jsonl` + manifest.
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar ou divergir.
 * `--force`: regenera mesmo se a fonte mudou.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  parseArgs, resolveCliPath, requireFreshDist, loadCorpus, renderJsonl,
  buildManifest, generate, check, runOracle, REPO,
} from './golden-kit.mjs';

const REGISTRY = 'episode-annotate/episodeAnnotate';
const NAME = 'episodeAnnotate';
const SOURCE = 'src/providers/episode-size.ts';
const ARTIFACT = 'dist/src/providers/episode-size.js';
const ORACLE = 'scripts/golden/episode-annotate-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-episode-annotate.json';
const OUT_JSONL = 'rust/golden/episode-annotate.jsonl';
const OUT_MANIFEST = 'rust/golden/episode-annotate.manifest.json';
const DIST_SOURCES = ['src/providers/episode-size.ts'];

const OPS = new Set(['covered', 'exact', 'pack', 'movie', 'fill', 'totals']);
/** Valida `op` e os campos obrigatórios de cada formato. */
function validate(cases) {
  const problems = [];
  for (const c of cases) {
    const req = JSON.parse(c.input);
    if (!OPS.has(req.op)) problems.push(`${c.id}: op inválida ${req.op}`);
    if ((req.op === 'covered' || req.op === 'exact') && !('season' in req)) {
      problems.push(`${c.id}: op ${req.op} exige season`);
    }
    if (req.op === 'exact' && !Array.isArray(req.files)) {
      problems.push(`${c.id}: op exact exige files`);
    }
    if (['pack', 'movie', 'fill', 'totals'].includes(req.op) && !Array.isArray(req.streams)) {
      problems.push(`${c.id}: op ${req.op} exige streams`);
    }
  }
  return problems;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFreshDist(ARTIFACT, DIST_SOURCES);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS), validate);
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
