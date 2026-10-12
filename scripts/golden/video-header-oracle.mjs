#!/usr/bin/env node
/**
 * Oráculo do golden de resolução de vídeo (`src/utils/video-header.ts`).
 *
 * Mede SÓ `parseVideoResolution`, `parseMp4Tail`, `isMp4` e
 * `qualityFromResolution` — a saída REAL do `dist`, nunca uma reimplementação do
 * TS. Roda no staging descartável montado por `dump-video-header.mjs` (CWD no
 * staging, env mínima, sem .env/data, RUST_CORE=off): lê o `job.json` (artefato
 * absoluto + casos), importa o artefato por caminho absoluto e devolve
 * `{ok:true, cases:[{id,out}]}` no stdout.
 *
 * O `input` de cada caso é um JSON tipado: `{"op":"head|tail|ismp4","hex":...}`
 * ou `{"op":"quality","width":W,"height":H}`. Bytes nunca viram string: o hex é
 * decodificado para Buffer antes de chamar a função. A saída canônica é `null`,
 * `true|false`, `"<rótulo>"` ou `{"width":W,"height":H}` — sem coerção.
 * `fetch` é armado para explodir: o grafo é puro e não toca a rede.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);

function canonical(op, out) {
  if (op === 'quality') return out === null ? 'null' : JSON.stringify(out);
  if (op === 'ismp4') return out ? 'true' : 'false';
  return out === null ? 'null' : JSON.stringify({ width: out.width, height: out.height });
}

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const bytes = typeof req.hex === 'string' ? Buffer.from(req.hex, 'hex') : null;
  let out;
  if (req.op === 'head') out = mod.parseVideoResolution(bytes);
  else if (req.op === 'tail') out = mod.parseMp4Tail(bytes);
  else if (req.op === 'ismp4') out = mod.isMp4(bytes);
  else if (req.op === 'quality') out = mod.qualityFromResolution(req.width, req.height);
  else throw new Error(`op desconhecida: ${req.op}`);
  return { id: c.id, out: canonical(req.op, out) };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
