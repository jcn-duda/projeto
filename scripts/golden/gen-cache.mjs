#!/usr/bin/env node
/**
 * Gera (ou verifica, com `--check`) o golden de cache:
 *   rust/golden/cache-keys.{jsonl,manifest.json}
 *   rust/golden/cache-quotas.{jsonl,manifest.json}
 *
 * Consome as duas entradas de registro (`registry-cache-keys.mjs` e
 * `registry-cache-quotas.mjs`) e o `dist` vivo. Espelha o formato de
 * `gen-stream-quotas.mjs` (manifest `adom-golden-manifest/1`, registry com um id,
 * hashes de corpus e saída), mas percorre a lista de entradas: os dois módulos
 * são o mesmo contrato de cache e um único `--check` cobre os dois.
 *
 * --check é só leitura: recomputa a saída com o dist e compara byte a byte com o
 * golden commitado, confere hashes do corpus, da fonte e do artefato.
 *
 * Uso: `node scripts/golden/gen-cache.mjs [--check] [--force]`
 *      (antes, se a tabela mudou: `node scripts/golden/build-corpus-cache.mjs`)
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cacheKeys from './registry-cache-keys.mjs';
import cacheQuotas from './registry-cache-quotas.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const ENTRIES = [cacheKeys, cacheQuotas];

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

function loadCorpus(entry) {
  let raw;
  try {
    raw = readFileSync(abs(entry.corpus));
  } catch {
    fail(`corpus ausente: ${entry.corpus} — rode build-corpus-cache.mjs`);
  }
  const parsed = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
  const cases = parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) fail(`corpus vazio ou sem "cases": ${entry.corpus}`);
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (typeof c?.input !== 'string') fail(`caso ${c.id}: input precisa ser string`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
  }
  return { sha: sha256(raw), cases };
}

async function renderJsonl(cases, f) {
  const lines = [];
  for (const c of cases) {
    let out;
    try {
      out = await f(c.input);
    } catch (e) {
      fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
    }
    if (typeof out !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
    lines.push(JSON.stringify({ id: c.id, input: c.input, expected: out }));
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function buildManifest(entry, corpus, outputSha) {
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

async function processEntry(entry) {
  const f = await entry.resolve();
  const corpus = loadCorpus(entry);
  const jsonl = await renderJsonl(corpus.cases, f);
  const outJsonl = abs(entry.outJsonl);
  const outManifest = abs(entry.outManifest);
  const manifest = buildManifest(entry, corpus, sha256(jsonl));

  if (CHECK) {
    let committed = null;
    try {
      committed = readFileSync(outJsonl);
    } catch {
      committed = null;
    }
    if (!committed || committed.length === 0) fail(`golden ausente ou vazio: ${entry.outJsonl}`);
    if (!committed.equals(jsonl)) fail(`${entry.outJsonl}: saída do dist diverge do golden (byte a byte)`);
    const old = readManifestIfExists(outManifest);
    if (!old) fail(`manifest ausente: ${entry.outManifest}`);
    if (old.format !== MANIFEST_FORMAT) fail('format do manifest divergente');
    if (old.corpus.sha256 !== corpus.sha) fail(`${entry.outManifest}: hash do corpus diverge do manifest`);
    if (old.output.sha256 !== sha256(committed)) fail(`${entry.outManifest}: hash da saída diverge do manifest`);
    if (old.function.sourceSha256 !== manifest.function.sourceSha256) {
      fail(`${entry.source} alterada desde a última geração; regenere (sem --check)`);
    }
    console.log(`[golden] OK ${entry.outJsonl}: ${corpus.cases.length} casos batem com o dist`);
    return;
  }

  const existing = readManifestIfExists(outManifest);
  if (existing && !FORCE && existing.function?.sourceSha256 !== manifest.function.sourceSha256) {
    fail(`${entry.source} mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)`);
  }
  mkdirSync(path.dirname(outJsonl), { recursive: true });
  writeFileSync(outJsonl, jsonl);
  writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${entry.outJsonl} (${corpus.cases.length} linhas) + ${entry.outManifest}`);
}

async function main() {
  for (const entry of ENTRIES) await processEntry(entry);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
