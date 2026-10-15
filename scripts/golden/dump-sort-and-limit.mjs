#!/usr/bin/env node
/**
 * Golden `stream-ranking-sort` â€” `sortAndLimit` de `src/utils/stream-ranking.ts`.
 *
 * GeraÃ§Ã£o: `node scripts/golden/dump-sort-and-limit.mjs` roda o corpus contra
 * o orÃ¡culo do `dist` REAL e grava `rust/golden/stream-ranking-sort.jsonl` +
 * manifest. `--check`: ESTRITAMENTE leitura â€” falha se golden/manifest faltar
 * ou divergir do dist vivo. `--force`: regenera mesmo se a fonte mudou.
 *
 * O output do orÃ¡culo Ã© JSON canÃ´nico (chaves ordenadas): ver o cabeÃ§alho do
 * orÃ¡culo. O grafo importado Ã© LARGO (search-names â†’ config â†’ cache), por
 * isso a isolaÃ§Ã£o Ã© por AMBIENTE (dotenv vazio, CACHE_PERSIST=false,
 * RUST_CORE=off), igual aos outros dumps de providers/policy.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs, resolveCliPath, requireFreshDist, loadCorpus, renderJsonl,
  buildManifest, generate, check, REPO,
} from './golden-kit.mjs';

const REGISTRY = 'stream-ranking/sortAndLimit';
const NAME = 'sortAndLimit';
const SOURCE = 'src/utils/stream-ranking.ts';
const ARTIFACT = 'dist/src/utils/stream-ranking.js';
const TRACE_ARTIFACT = 'dist/src/utils/stream-trace.js';
const ORACLE = 'scripts/golden/sort-and-limit-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-sort-and-limit.json';
const OUT_JSONL = 'rust/golden/stream-ranking-sort.jsonl';
const OUT_MANIFEST = 'rust/golden/stream-ranking-sort.manifest.json';
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
const HOST_ALLOW = [
  'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'OS', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
];

/** Roda o orÃ¡culo com o campo extra `traceArtifact` no job. */
function runOracleTrace(corpus) {
  const oracleAbs = path.join(REPO, ORACLE);
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const work = fs.mkdtempSync(path.join(TEMP_BASE, 'golden-sort-'));
  const jobPath = path.join(work, 'job.json');
  const outPath = path.join(work, 'out.json');
  const dotenvPath = path.join(work, 'empty-dotenv');
  fs.writeFileSync(dotenvPath, '');
  fs.writeFileSync(jobPath, JSON.stringify({
    repo: REPO,
    artifact: ARTIFACT,
    traceArtifact: TRACE_ARTIFACT,
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
    throw new Error(`orÃ¡culo falhou: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  if (!parsed?.ok || !Array.isArray(parsed.cases)) throw new Error('orÃ¡culo nÃ£o reportou ok');
  const byId = new Map(parsed.cases.map((r) => [r.id, r.out]));
  if (byId.size !== corpus.cases.length) throw new Error('contagem diverge do corpus');
  return { byId };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFreshDist(ARTIFACT, [SOURCE, 'src/utils/stream-trace.ts', 'src/utils/search-names.ts']);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
  const { byId } = runOracleTrace(corpus);
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
