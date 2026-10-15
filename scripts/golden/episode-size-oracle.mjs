#!/usr/bin/env node
/**
 * Oráculo do golden `episode-size`: mede a saída REAL do `dist` para cada caso
 * do corpus. Roda em processo filho isolado (sem rede, sem config real).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `streamTitleBytes` → número (bytes) ou "0"
 * - `streamSizeLabel`  → rótulo ("1.55 GB") ou "null"
 *
 * `parseSizeLabel` não é exportada pelo TS — os casos dela entram indiretos,
 * pelo `streamTitleBytes`; o lado Rust tem teste unitário próprio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

// O `runOracle` do golden-kit não injeta `artifact` no job: usa o default deste
// golden (mesma política do requireFreshDist do dump).
const mod = await import(
  pathToFileURL(path.resolve(job.repo, job.artifact ?? 'dist/src/providers/episode-size.js')).href
);

const label = (v) => (v == null ? 'null' : String(v));

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'streamTitleBytes':
      out = String(mod.streamTitleBytes(req.title));
      break;
    case 'streamSizeLabel':
      out = label(mod.streamSizeLabel(req.title));
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
