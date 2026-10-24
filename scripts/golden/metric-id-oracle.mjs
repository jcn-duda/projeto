#!/usr/bin/env node
/**
 * Oráculo do golden da normalização de id de métrica de `src/utils/metric-id.ts`:
 * `safeMetricId` e `indexerFallbackMetricKey`.
 *
 * Mede a saída REAL do `dist` — nunca uma reimplementação do TS. Roda no staging
 * descartável montado por `dump-metric-id.mjs` (CWD no staging, env mínima, sem
 * `.env`/`data`, `RUST_CORE=off`): lê o `job.json` (artefato absoluto + casos),
 * importa o artefato por caminho absoluto e devolve `{ok:true, cases:[{id,out}]}`
 * no stdout.
 *
 * O módulo é `pure` (o grafo de import é o próprio arquivo: `metric-id.ts` não
 * importa nada), então não há config/listas a injetar — o `input` de cada caso é
 * um JSON com `op`:
 * - `safe` → `safeMetricId(value)`; `value` AUSENTE chega como `undefined`
 *   (ramo `value || ''`), distinto de `value:null`.
 * - `key`  → `indexerFallbackMetricKey(value)` (mesma normalização + prefixo).
 *
 * `fetch` é armado para explodir: o grafo é puro e não toca a rede.
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
  if (req.op === 'safe') out = mod.safeMetricId(req.value);
  else if (req.op === 'key') out = mod.indexerFallbackMetricKey(req.value);
  else throw new Error(`op desconhecida: ${req.op}`);
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
