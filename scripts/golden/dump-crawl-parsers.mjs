#!/usr/bin/env node
/**
 * Golden `crawl-parsers` — parsers puros do raspador (fases C0/C1).
 *
 * Geração: `node scripts/golden/dump-crawl-parsers.mjs` importa as funções REAIS
 * do `dist` (via `crawl-parsers-oracle.mjs`) sobre `corpus-crawl-parsers.json`
 * (fixtures versionadas em `test/fixtures/`) e grava
 * `rust/golden/crawl-parsers.jsonl` + manifest. Determinístico: sem timestamp.
 *
 * `--check`: ESTRITAMENTE leitura — falha se golden/manifest faltar, estiver
 * vazio ou divergir (hash, comportamento do dist vivo, fonte alterada,
 * contagem, identidade function.name/sourcePath/artifactPath).
 *
 * COBERTURA: cada `op` tem piso explícito (`crawl-parsers-validation.mjs`).
 *
 * FONTE PRIMÁRIA: `readWorkTitle` (`work-name.ts`) é a régua compartilhada por 7
 * sites e a mais central do parser; o hash de fonte prende a geração a ela. Os
 * demais módulos ficam pelo hash do artefato e pelo corpus.
 */
import path from 'node:path';
import {
  parseArgs, resolveCliPath, requireFreshDist, loadCorpus, runOracle, renderJsonl,
  buildManifest, generate, check,
} from './golden-kit.mjs';
import { opCoverageViolations } from './crawl-parsers-validation.mjs';

const REGISTRY = 'crawl-parsers/crawlParsers';
const NAME = 'crawlParsers';
const SOURCE = 'src/providers/crawl-sites/work-name.ts';
const ARTIFACT = 'dist/src/providers/crawl-sites/work-name.js';
const ORACLE = 'scripts/golden/crawl-parsers-oracle.mjs';
const CORPUS = 'scripts/golden/corpus-crawl-parsers.json';
const OUT_JSONL = 'rust/golden/crawl-parsers.jsonl';
const OUT_MANIFEST = 'rust/golden/crawl-parsers.manifest.json';
const DIST_SOURCES = [
  'src/providers/crawl-sites/work-name.ts', 'src/providers/crawl-sites/shared.ts',
  'src/providers/crawl-sites/season-page.ts', 'src/providers/crawl-sites/mico-shared.ts',
  'src/providers/crawl-sites/sitemap-guard.ts', 'src/providers/crawl-sites/vaca.ts',
  'src/providers/crawl-sites/vaca-series-locate.ts',
  'src/providers/crawl-sites/bludv-discovery.ts', 'src/providers/crawl-sites/comandotorrents-discovery.ts',
  'src/providers/crawl-sites/nerdfilmes-discovery.ts', 'src/providers/crawl-sites/torrentdosfilmes-discovery.ts',
  'src/providers/crawl-sites/redetorrent-discovery.ts', 'src/providers/crawl-sites/hdrtorrents-discovery.ts',
  'src/providers/crawl-sites/apachetorrent-discovery.ts',
  'resolvers/text.ts', 'resolvers/profiles/*-parsers.ts',
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
  process.exit(1);
}
