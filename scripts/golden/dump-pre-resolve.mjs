#!/usr/bin/env node
/**
 * Golden `pre-resolve` — as duas regras que o G4 deixou no crate `adom-napi`
 * (`pre_resolve.rs`): o score de escolha do candidato (`resolveCandidateScore`)
 * e a regex de temporada do título do laço do protetor BR.
 *
 * Geração: `node scripts/golden/dump-pre-resolve.mjs` importa o `dist` REAL do
 * oráculo (`pre-resolve-oracle.mjs`) sobre `corpus-pre-resolve.json` e grava
 * `rust/golden/pre-resolve.jsonl` + manifest. Determinístico: sem timestamp.
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar, vazio ou
 * divergir (hash, comportamento do dist vivo, fonte alterada, contagem).
 *
 * ORÁCULO DO ESM: o TS de `src/providers/jackett-resolve.ts` saiu deste branch
 * (o laço virou uma chamada ao núcleo), então quem mede é o TypeScript do
 * branch `esm`, num worktree ao lado — igual aos goldens de filtros. O `--check`
 * deste branch delega (`run-esm-golden.mjs`); nada aqui roda o shim como
 * oráculo. Os `.jsonl` são os mesmos dos dois lados; o cargo test confere o
 * Rust contra o mesmo arquivo.
 *
 * Isolamento: ver `golden-kit.mjs` (child com env mínima e dotenv vazio).
 */
import path from 'node:path';
import {
  fail, parseArgs, resolveCliPath, requireFreshDist, loadCorpus, runOracle,
  renderJsonl, buildManifest, generate, check, toPosix,
} from './golden-kit.mjs';

const REGISTRY = 'pre-resolve/preResolve';
const NAME = 'preResolve';
const SOURCE = 'src/providers/jackett-resolve.ts';
const ARTIFACT = 'dist/src/providers/jackett-resolve.js';
const ORACLE = 'scripts/golden/pre-resolve-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-pre-resolve.json';
const OUT_JSONL = 'rust/golden/pre-resolve.jsonl';
const OUT_MANIFEST = 'rust/golden/pre-resolve.manifest.json';

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
  for (const op of ['score', 'rank', 'season']) {
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
