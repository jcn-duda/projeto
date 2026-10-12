#!/usr/bin/env node
/**
 * Gera (ou verifica, com `--check`) o golden de
 * `src/utils/indexer-priority.ts`:
 *   rust/golden/indexer-priority.jsonl + rust/golden/indexer-priority.manifest.json
 *
 * Cobre as duas funções puras do módulo, escolhidas por `op` no caso:
 *   - `priorityMap`        → op `"map"`
 *   - `compareIndexerPriority` → op `"compare"`
 *
 * O oráculo é o `dist` COMPILADO do módulo real. Ele importa só um TIPO
 * (`import type { StreamCandidate }`), apagado no emit: o módulo não puxa
 * config, `.env`, rede nem outro runtime — a árvore de import é o próprio
 * arquivo. `priorityMap` devolve um `Map`, que não é `JSON.stringify`-ável:
 * serializa-se explicitamente `[...map.entries()]` (ordem de inserção), nunca
 * as chaves de um objeto. O porte Rust devolve o mesmo vetor de pares.
 *
 * Espelha o formato de `gen-stream-quotas.mjs` (manifest
 * `adom-golden-manifest/1`, hashes de corpus/fonte/artefato), sem depender
 * dele.
 *
 * --check é só leitura: recomputa a saída com o dist e compara byte a byte com
 * o golden commitado, conferindo os hashes de corpus, fonte e artefato.
 * Negativos (golden ausente/vazio, tamper, fonte mudada) falham com exit 1.
 *
 * Uso: `node scripts/golden/dump-indexer-priority.mjs [--check] [--force]`
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_HASH_LINE_ENDINGS, shaSourceLf } from './source-fingerprint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';

const ENTRY = {
  id: 'indexer-priority/priorityMap',
  name: 'priorityMap',
  source: 'src/utils/indexer-priority.ts',
  artifact: 'dist/src/utils/indexer-priority.js',
  corpus: 'scripts/golden/corpus-indexer-priority.json',
  outJsonl: 'rust/golden/indexer-priority.jsonl',
  outManifest: 'rust/golden/indexer-priority.manifest.json',
};

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const FORCE = args.has('--force');

const fail = (msg) => {
  console.error(`[golden] FALHA: ${msg}`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const abs = (rel) => path.join(REPO, rel);
const toPosix = (p) => p.split(path.sep).join('/');

function loadCorpus() {
  let raw;
  try {
    raw = readFileSync(abs(ENTRY.corpus));
  } catch {
    fail(`corpus ausente: ${ENTRY.corpus}`);
  }
  const parsed = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
  const cases = parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) fail('corpus vazio ou sem "cases"');
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (typeof c?.input !== 'string') fail(`caso ${c.id}: input precisa ser string`);
    const op = JSON.parse(c.input)?.op;
    if (op !== 'map' && op !== 'compare') fail(`caso ${c.id}: op desconhecida: ${op}`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
  }
  return { sha: sha256(raw), cases };
}

/** Oráculo: carrega o emissor do TS e devolve a saída textual de um caso. */
async function oracle() {
  const mod = await import(pathToFileURL(abs(ENTRY.artifact)).href);
  return (input) => {
    const c = JSON.parse(input);
    if (c.op === 'map') {
      const ids = c.ids ?? [];
      const before = JSON.stringify(ids);
      const map = mod.priorityMap(ids);
      // Eco de não-mutação: `priorityMap` não pode alterar o array de ids.
      const stable = JSON.stringify(ids) === before;
      return JSON.stringify({ map: [...map.entries()], stable });
    }
    if (c.op === 'compare') {
      // `ranks` null/ausente é o `null` do desempate (`!ranks`); lista vazia é
      // um Map de tamanho 0. Os dois devolvem 0.
      const ranks = c.ranks === undefined || c.ranks === null ? null : mod.priorityMap(c.ranks);
      const before = ranks === null ? 'null' : JSON.stringify([...ranks.entries()]);
      const a = { _indexer: c.a ?? null };
      const b = { _indexer: c.b ?? null };
      const diff = mod.compareIndexerPriority(a, b, ranks);
      const after = ranks === null ? 'null' : JSON.stringify([...ranks.entries()]);
      return JSON.stringify({ diff, stable: after === before });
    }
    throw new Error(`op desconhecida: ${c.op}`);
  };
}

function renderJsonl(cases, f) {
  const lines = cases.map((c) => {
    let out;
    try {
      out = f(c.input);
    } catch (e) {
      fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
    }
    if (typeof out !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
    return JSON.stringify({ id: c.id, input: c.input, expected: out });
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function buildManifest(corpus, outputSha) {
  return {
    format: MANIFEST_FORMAT,
    // Política do hash da fonte: cobre o texto com CRLF → LF (portátil entre
    // checkouts); não vale para corpus/artefato.
    sourceHashLineEndings: SOURCE_HASH_LINE_ENDINGS,
    registry: [ENTRY.id],
    function: {
      name: ENTRY.name,
      sourcePath: toPosix(ENTRY.source),
      sourceSha256: shaSourceLf(readFileSync(abs(ENTRY.source))),
      artifactPath: toPosix(ENTRY.artifact),
      artifactSha256: sha256(readFileSync(abs(ENTRY.artifact))),
    },
    corpus: { path: toPosix(ENTRY.corpus), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(ENTRY.outJsonl), sha256: outputSha, lines: corpus.cases.length },
    node: { major: Number(process.versions.node.split('.')[0]) },
    git: { revision: gitRevision() },
  };
}

function readManifestIfExists(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const f = await oracle();
  const corpus = loadCorpus();
  const jsonl = renderJsonl(corpus.cases, f);
  const outJsonl = abs(ENTRY.outJsonl);
  const outManifest = abs(ENTRY.outManifest);
  const manifest = buildManifest(corpus, sha256(jsonl));

  if (CHECK) {
    let committed = null;
    try {
      committed = readFileSync(outJsonl);
    } catch {
      committed = null;
    }
    if (!committed || committed.length === 0) fail(`golden ausente ou vazio: ${ENTRY.outJsonl}`);
    if (!committed.equals(jsonl)) fail(`${ENTRY.outJsonl}: saída do dist diverge do golden (byte a byte)`);
    const old = readManifestIfExists(outManifest);
    if (!old) fail(`manifest ausente: ${ENTRY.outManifest}`);
    if (old.format !== MANIFEST_FORMAT) fail('format do manifest divergente');
    if (old.corpus?.sha256 !== corpus.sha) fail(`${ENTRY.outManifest}: hash do corpus diverge do manifest`);
    if (old.output?.sha256 !== sha256(committed)) fail(`${ENTRY.outManifest}: hash da saída diverge do manifest`);
    if (old.function?.sourceSha256 !== manifest.function.sourceSha256) {
      fail(`${ENTRY.source} alterada desde a última geração; regenere (sem --check)`);
    }
    if (old.function?.artifactSha256 !== manifest.function.artifactSha256) {
      fail(`${ENTRY.artifact} alterado desde a última geração; regenere (sem --check)`);
    }
    console.log(`[golden] OK ${ENTRY.outJsonl}: ${corpus.cases.length} casos batem com o dist`);
    return;
  }

  const existing = readManifestIfExists(outManifest);
  if (existing && !FORCE && existing.function?.sourceSha256 !== manifest.function.sourceSha256) {
    fail(`${ENTRY.source} mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)`);
  }
  mkdirSync(path.dirname(outJsonl), { recursive: true });
  writeFileSync(outJsonl, jsonl);
  writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${ENTRY.outJsonl} (${corpus.cases.length} linhas) + ${ENTRY.outManifest}`);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
