#!/usr/bin/env node
/**
 * Oráculo do golden da apresentação de áudio (`src/utils/audio-quality.ts`).
 *
 * Mede SÓ `stripQualityTagBlob`, `audioFromTitle` e `looksPtBr` — a saída REAL
 * do `dist`, nunca uma reimplementação do TS. Roda no staging descartável
 * montado por `dump-audio-presentation.mjs` (CWD no staging, env mínima, sem
 * .env/data, RUST_CORE=off): lê o `job.json` (artefato absoluto + casos),
 * importa o artefato por caminho absoluto e devolve `{ok:true, cases:[{id,out}]}`
 * no stdout. O `input` de cada caso é um JSON com `op` (`strip`|`audio`|`looks`)
 * e `title`. `fetch` é armado para explodir: o grafo é puro e não toca a rede.
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
  if (req.op === 'strip') out = mod.stripQualityTagBlob(req.title);
  else if (req.op === 'audio') out = mod.audioFromTitle(req.title);
  else if (req.op === 'looks') out = mod.looksPtBr(req.title) ? '1' : '0';
  else throw new Error(`op desconhecida: ${req.op}`);
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
