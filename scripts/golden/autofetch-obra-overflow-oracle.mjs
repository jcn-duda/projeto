#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-obra-overflow`: mede a saída REAL do `dist`.
 * Roda em processo filho isolado (sem rede, sem config real).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `qualityRank`             → número (peso da faixa; `-1` = desconhecida)
 * - `overflowUpgradeAllowed`  → "true"/"false"
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
for (const name of ['qualityRank', 'overflowUpgradeAllowed']) {
  if (typeof mod[name] !== 'function') throw new Error(`autofetch-obra-overflow não exporta ${name}`);
}

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'qualityRank':
      out = String(mod.qualityRank(req.q));
      break;
    case 'overflowUpgradeAllowed':
      out = String(mod.overflowUpgradeAllowed(req.entries ?? [], req.input ?? {}));
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
