#!/usr/bin/env node
/**
 * OrÃ¡culo do golden `stream-ranking-sort`: mede a saÃ­da REAL do `dist` para
 * cada caso do corpus. Roda em processo filho isolado (sem rede, sem config
 * real â€” o dotenv vazio e `RUST_CORE=off` vÃªm do gerador).
 *
 * O input de cada caso Ã© `{ streams, options, instantHashes }`; o callback
 * `options.instant` Ã© materializado a partir de `instantHashes` (o porte Rust
 * recebe o HashSet). A saÃ­da Ã© SEMPRE string: `JSON.stringify` canÃ´nico
 * (chaves ordenadas recursivamente) de `{ streams, drops }`, onde `drops` Ã© o
 * que o `sortAndLimit` registrou no trace real (`trace.items` sem o `id`
 * posicional). O waiver viaja MARCADO nos streams de saÃ­da
 * (`_seedFloorWaived`), como no TS; `qualityRelaxed` Ã© mÃ©trica (sem eco no
 * output observÃ¡vel) e nÃ£o participa do golden.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no orÃ¡culo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
const traceMod = await import(pathToFileURL(path.resolve(job.repo, job.traceArtifact)).href);

const canon = (v) => Array.isArray(v)
  ? v.map(canon)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const options = { ...(req.options ?? {}) };
  if (Array.isArray(req.instantHashes)) {
    const live = new Set(req.instantHashes);
    options.instant = (hash) => live.has(hash);
  }
  const trace = traceMod.createStreamTrace();
  options.trace = trace;
  const streams = mod.sortAndLimit(req.streams ?? [], options);
  const drops = (trace.items ?? []).map(({ id, ...rest }) => rest);
  return { id: c.id, out: JSON.stringify(canon({ streams, drops })) };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
