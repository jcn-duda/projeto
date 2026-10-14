#!/usr/bin/env node
/**
 * Golden `crawl-policy` — política pura do motor de raspagem (fase C2).
 *
 * Geração: `node scripts/golden/dump-crawl-policy.mjs` importa as funções REAIS
 * do `dist` (via `crawl-policy-oracle.mjs`) sobre `corpus-crawl-policy.json` e
 * grava `rust/golden/crawl-policy.jsonl` + manifest. Determinístico: sem
 * timestamp; os hashes cobrem corpus, artefato e saída.
 *
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar, estiver
 * vazio ou divergir (hash, comportamento do dist vivo, fonte alterada,
 * contagem, identidade function.name/sourcePath/artifactPath).
 *
 * COBERTURA: cada `op` tem piso explícito (`crawl-policy-validation.mjs`); um
 * corpus que perde uma op reprova ANTES de medir/escrever.
 *
 * FONTE PRIMÁRIA: o manifest carrega UMA `sourcePath` (schema existente do
 * projeto); aqui é `crawl-site-select.ts`, o módulo de política mais rico. O
 * hash de fonte prende a geração a ele; os demais módulos são cobertos pelo
 * hash do ARTEFATO e pelo corpus.
 *
 * O oráculo roda isolado (ambiente mínimo, dotenv vazio) — ver `golden-kit.mjs`.
 */
import path from 'node:path';
import {
  REPO, fail, parseArgs, resolveCliPath, requireFreshDist, loadCorpus, runOracle,
  renderJsonl, buildManifest, generate, check, toPosix,
} from './golden-kit.mjs';
import { opCoverageViolations } from './crawl-policy-validation.mjs';

const REGISTRY = 'crawl-policy/crawlPolicy';
const NAME = 'crawlPolicy';
const SOURCE = 'src/providers/crawl-site-select.ts';
const ARTIFACT = 'dist/src/providers/crawl-site-select.js';
const ORACLE = 'scripts/golden/crawl-policy-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-crawl-policy.json';
const OUT_JSONL = 'rust/golden/crawl-policy.jsonl';
const OUT_MANIFEST = 'rust/golden/crawl-policy.manifest.json';
const DIST_SOURCES = [
  'src/providers/crawl-site-select.ts', 'src/providers/crawl-dispatch.ts',
  'src/providers/crawl-cycle.ts', 'src/providers/crawl-rate.ts',
  'src/providers/crawl-pauses.ts', 'src/providers/crawl-status-view.ts',
  'src/utils/crawler-live-schema.ts', 'src/utils/crawler-live-site.ts',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFreshDist(ARTIFACT, DIST_SOURCES);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS), (cases) => opCoverageViolations(cases));
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
