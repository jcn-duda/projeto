#!/usr/bin/env node
/**
 * Oráculo do golden de `src/utils/stream-quotas-candidate.ts`: `QUALITY_KEYS`,
 * `streamQuality` e `selectQualityCandidates`, medidos no `dist` real.
 *
 * Roda no staging descartável de `dump-stream-quotas-candidate.mjs` (CWD no
 * staging, env mínima, sem .env, RUST_CORE=off). Entrada por caso:
 * - `{"op":"keys"}`
 * - `{"op":"quality","stream":{title?,name?,_quality?}}`
 * - `{"op":"select","streams":[{title?,name?,_quality?,_br?,_lied?}],"opts":{...}}`
 * Saída canônica: JSON da função (lista de chaves, string de qualidade ou
 * índices mantidos na ordem original). Os índices vêm do mapa de identidade dos
 * objetos parseados, equivalente ao subconjunto de objetos do TS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  if (req.op === 'keys') {
    out = mod.QUALITY_KEYS;
  } else if (req.op === 'quality') {
    out = mod.streamQuality(req.stream);
  } else if (req.op === 'select') {
    const index = new Map(req.streams.map((s, i) => [s, i]));
    const kept = mod.selectQualityCandidates(req.streams, req.opts ?? {});
    out = kept.map((s) => index.get(s));
  } else {
    throw new Error(`op desconhecida: ${req.op}`);
  }
  return { id: c.id, out: JSON.stringify(out) };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
