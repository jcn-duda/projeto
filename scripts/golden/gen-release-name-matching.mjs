#!/usr/bin/env node
/**
 * Gera (ou verifica, com `--check`) o golden de `src/utils/release-name-matching.ts`:
 * rust/golden/release-name-matching.jsonl + rust/golden/release-name-matching.manifest.json.
 *
 * Usa a entrada de `registry-release-name-matching.mjs` e o dist vivo. Espelha o
 * formato de dump-title-normalization.mjs (manifest `adom-golden-manifest/1`,
 * registry com um id, hashes de corpus e saída), sem depender dele: aquele
 * arquivo não exporta suas funções.
 *
 * --check é só leitura: recomputa a saída com o dist e compara byte a byte com
 * o golden commitado, confere hashes do corpus e da fonte do manifest.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import entry from './registry-release-name-matching.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
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
    raw = readFileSync(abs(entry.corpus));
  } catch {
    fail(`corpus ausente: ${entry.corpus}`);
  }
  const parsed = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
  const cases = parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) fail('corpus vazio ou sem "cases"');
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (typeof c?.input !== 'string') fail(`caso ${c.id}: input precisa ser string`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
  }
  return { sha: sha256(raw), cases };
}

function renderJsonl(cases, f) {
  const lines = cases.map((c) => {
    let out;
    try {
      out = f(c.input);
    } catch (e) {
      fail(`oracle lançou no caso ${c.id}: ${e.message}`);
    }
    if (typeof out !== 'string') fail(`oracle não devolveu string no caso ${c.id}`);
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
    registry: [entry.id],
    function: {
      name: entry.name,
      sourcePath: toPosix(entry.source),
      sourceSha256: sha256(readFileSync(abs(entry.source))),
      artifactPath: toPosix(entry.artifact),
      artifactSha256: sha256(readFileSync(abs(entry.artifact))),
    },
    corpus: { path: toPosix(entry.corpus), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(entry.outJsonl), sha256: outputSha, lines: corpus.cases.length },
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
  const f = await entry.resolve();
  const corpus = loadCorpus();
  const jsonl = renderJsonl(corpus.cases, f);
  const outJsonl = abs(entry.outJsonl);
  const outManifest = abs(entry.outManifest);
  const manifest = buildManifest(corpus, sha256(jsonl));

  if (CHECK) {
    const committed = (() => {
      try {
        return readFileSync(outJsonl);
      } catch {
        return null;
      }
    })();
    if (!committed || committed.length === 0) fail(`golden ausente ou vazio: ${entry.outJsonl}`);
    if (!committed.equals(jsonl)) fail('saída do dist diverge do golden commitado (byte a byte)');
    const old = readManifestIfExists(outManifest);
    if (!old) fail(`manifest ausente: ${entry.outManifest}`);
    if (old.format !== MANIFEST_FORMAT) fail('format do manifest divergente');
    if (old.corpus.sha256 !== corpus.sha) fail('hash do corpus diverge do manifest');
    if (old.output.sha256 !== sha256(committed)) fail('hash da saída diverge do manifest');
    if (old.function.sourceSha256 !== manifest.function.sourceSha256) {
      fail('fonte alterada desde a última geração; regenere (sem --check)');
    }
    console.log(`[golden] OK: ${corpus.cases.length} casos, saída e manifest batem com o dist`);
    return;
  }

  const existing = readManifestIfExists(outManifest);
  if (existing && !FORCE && existing.function?.sourceSha256 !== manifest.function.sourceSha256) {
    fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
  }
  mkdirSync(path.dirname(outJsonl), { recursive: true });
  writeFileSync(outJsonl, jsonl);
  writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${entry.outJsonl} (${corpus.cases.length} linhas)`);
  console.log(`[golden] manifest: ${entry.outManifest}`);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
