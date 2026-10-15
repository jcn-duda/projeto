#!/usr/bin/env node
/**
 * Oráculo do golden `stream-ranking-dedupe`: mede a saída REAL do `dist` para
 * cada caso do corpus. Roda em processo filho isolado (sem rede, sem config
 * real — o dotenv vazio e `RUST_CORE=off` vêm do gerador).
 *
 * O input de cada caso é `{ streams, indexerPriority }`; a saída é SEMPRE
 * string: `JSON.stringify` canônico (chaves ordenadas recursivamente, para o
 * Rust não depender da ordem de serialização) de
 * `{ streams, drops }`, onde `drops` é o que `dedupeByHash` registrou no
 * trace real (`trace.items` sem o `id` posicional — o Rust reconstrói
 * `s1..sN` pela ordem).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
const traceMod = await import(pathToFileURL(path.resolve(job.repo, job.traceArtifact)).href);

const canon = (v) => Array.isArray(v)
  ? v.map(canon)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const trace = traceMod.createStreamTrace();
  const streams = mod.dedupeByHash(req.streams ?? [], req.indexerPriority ?? [], trace);
  const drops = (trace.items ?? []).map(({ id, ...rest }) => rest);
  return { id: c.id, out: JSON.stringify(canon({ streams, drops })) };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
