#!/usr/bin/env node
/**
 * Golden `autofetch-seeds-pick` — seleção do pool seeds (pickSeedsPool).
 *
 * Geração: `node scripts/golden/dump-autofetch-seeds-pick.mjs` roda o oráculo
 * sobre `corpus-autofetch-seeds-pick.json` e grava
 * `rust/golden/autofetch-seeds-pick.jsonl` + manifest.
 *
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar ou divergir.
 * `--force`: regenera mesmo se a fonte mudou.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs, resolveCliPath, requireFreshDist, loadCorpus, renderJsonl,
  buildManifest, generate, check, REPO,
} from './golden-kit.mjs';

const REGISTRY = 'autofetch-seeds-pick/pickSeedsPool';
const NAME = 'pickSeedsPool';
const SOURCE = 'src/providers/autofetch-seeds-pool.ts';
const ARTIFACT = 'dist/src/providers/autofetch-seeds-pool.js';
const ORACLE = 'scripts/golden/autofetch-seeds-pick-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-autofetch-seeds-pick.json';
const OUT_JSONL = 'rust/golden/autofetch-seeds-pick.jsonl';
const OUT_MANIFEST = 'rust/golden/autofetch-seeds-pick.manifest.json';
const DIST_SOURCES = [
  'src/providers/autofetch-seeds-pool.ts',
  'src/providers/autofetch-policy.ts',
  'src/utils/autofetch-pools.ts',
];
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
const HOST_ALLOW = [
  'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'OS', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
];

function runOracleExtra(corpus) {
  const oracleAbs = path.join(REPO, ORACLE);
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const work = fs.mkdtempSync(path.join(TEMP_BASE, 'golden-asp-'));
  const jobPath = path.join(work, 'job.json');
  const outPath = path.join(work, 'out.json');
  const dotenvPath = path.join(work, 'empty-dotenv');
  fs.writeFileSync(dotenvPath, '');
  fs.writeFileSync(jobPath, JSON.stringify({
    repo: REPO,
    artifact: ARTIFACT,
    cases: corpus.cases.map((c) => ({ id: c.id, input: c.input })),
  }));
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DOTENV_CONFIG_PATH = dotenvPath;
  env.CACHE_PERSIST = 'false';
  env.RUST_CORE = 'off';
  env.ADDON_LOG_LEVEL = 'silent';
  try {
    execFileSync(process.execPath, [oracleAbs, jobPath, outPath], {
      cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    });
  } catch (e) {
    throw new Error(`oráculo falhou: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  if (!parsed?.ok || !Array.isArray(parsed.cases)) throw new Error('oráculo não reportou ok');
  const byId = new Map(parsed.cases.map((r) => [r.id, r.out]));
  if (byId.size !== corpus.cases.length) throw new Error('contagem diverge do corpus');
  return { meta: parsed.meta ?? null, byId };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFreshDist(ARTIFACT, DIST_SOURCES);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
  const { byId } = runOracleExtra(corpus);
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
