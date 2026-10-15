#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-keys`: mede a saída REAL do `dist` para cada caso
 * do corpus. Roda em processo filho isolado (sem rede, sem config real).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `deadKey` → a chave `autofetch:v3:dead:<adapter>:<conta>:<hash>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
if (typeof mod.deadKey !== 'function') throw new Error('autofetch-keys não exporta deadKey');

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'deadKey':
      out = String(mod.deadKey(req.adapterId, req.account, req.infoHash));
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
