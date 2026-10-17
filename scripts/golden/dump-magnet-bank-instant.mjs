#!/usr/bin/env node
/**
 * Golden `magnet-bank-instant` — janela da via instantânea
 * (`isRecentRelease`/`instantWindow`, `src/providers/magnet-bank-instant.ts`).
 *
 * Geração: `node scripts/golden/dump-magnet-bank-instant.mjs` mede o `dist`
 * REAL pelo oráculo isolado (`golden-kit.mjs`, compartilhado com o golden
 * `magnet-bank-source`) e grava `rust/golden/magnet-bank-instant.jsonl` +
 * manifest. `--check`: só leitura.
 *
 * As datas do corpus são SÓ formas UTC do JS (com `Z`, date-only, ano ou
 * ano-mês): datetime sem offset é interpretado no FUSO do processo pelo JS e
 * ficaria dependente da máquina que gera o golden — decisão registrada no
 * módulo Rust (`adom_core::search_bank`).
 */
import path from 'node:path';
import {
  fail, parseArgs, resolveCliPath, requireFreshDist, loadCorpus, runOracle,
  renderJsonl, buildManifest, generate, check, toPosix,
} from './golden-kit.mjs';

const REGISTRY = 'magnet-bank-instant/instantWindow';
const NAME = 'instantWindow';
const SOURCE = 'src/providers/magnet-bank-instant.ts';
const ARTIFACT = 'dist/src/providers/magnet-bank-instant.js';
const ORACLE = 'scripts/golden/search-bank-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-magnet-bank-instant.json';
const OUT_JSONL = 'rust/golden/magnet-bank-instant.jsonl';
const OUT_MANIFEST = 'rust/golden/magnet-bank-instant.manifest.json';
const OPS = ['isRecentRelease', 'instantWindow'];

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
