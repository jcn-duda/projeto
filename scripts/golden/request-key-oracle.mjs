#!/usr/bin/env node
/**
 * Oráculo do golden das chaves de requisição (`src/utils/request-key.ts`).
 *
 * Mede a saída REAL do `dist` — nunca uma reimplementação do TS. Roda no
 * staging descartável montado por `dump-request-key.mjs` (CWD no staging, env
 * mínima, sem .env/data, `RUST_CORE=off`): lê o `job.json` (artefato absoluto +
 * casos), importa o artefato por caminho absoluto e devolve
 * `{ok:true, cases:[{id,out}]}` no stdout.
 *
 * `input` de cada caso é um JSON com `op`:
 * - `account` + `apiKey`   → `accountScope(apiKey)` (`apiKey` ausente = undefined)
 * - `scope`   + `options`  → `streamsCacheScope(options)`
 * - `key`     + `type`+`id`+`options` → `streamsCacheKey(type, id, options)`
 *
 * A saída é SEMPRE string; o golden compara byte a byte. O `JSON.stringify`
 * interno do `streamsCacheScope` serializa o `shape` na ORDEM DE INSERÇÃO do
 * objeto (chaves numéricas primeiro, por índice do array) — o oráculo não
 * canonicaliza nada: entrega o objeto como veio do `JSON.parse`, que preserva a
 * ordem textual do corpus.
 *
 * `fetch` é armado para explodir: o grafo (request-key → cache-keys) é puro e
 * não toca a rede.
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
  if (req.op === 'account') out = mod.accountScope(req.apiKey);
  else if (req.op === 'scope') out = mod.streamsCacheScope(req.options);
  else if (req.op === 'key') out = mod.streamsCacheKey(req.type, req.id, req.options);
  else throw new Error(`op desconhecida: ${req.op}`);
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
