#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-progress`: mede a saída REAL do `dist` para cada
 * caso do corpus. Roda em processo filho isolado (sem rede, sem config real).
 *
 * O módulo TS usa um `Map` GLOBAL de processo; cada caso usa um `adapterId`
 * único (o próprio id) e limpa a memória no fim, então os casos não se
 * contaminam dentro do mesmo processo. As contagens de memória são DELTAS
 * sobre uma baseline capturada no início do caso.
 *
 * Ops (a saída é SEMPRE string JSON):
 * - `sequence`  → {results:[{stalled:[...],signals}],created,afterForget}
 * - `forgetOne` → {createdAfterDerive,afterForgetOne,final}
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);

const sorted = (set) => [...set].sort();

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  if (req.op === 'sequence') {
    const lot = { adapterId: req.adapterId, account: req.account, hashes: req.hashes, threshold: req.threshold };
    const base = mod.progressMemorySize();
    const results = req.passes.map((statuses) => {
      const r = mod.deriveStall(lot, statuses);
      return { stalled: sorted(r.stalled), signals: r.signals };
    });
    const created = mod.progressMemorySize() - base;
    mod.forgetLotProgress(req.adapterId, req.account, req.hashes);
    const afterForget = mod.progressMemorySize() - base;
    out = JSON.stringify({ results, created, afterForget });
  } else if (req.op === 'forgetOne') {
    const lot = { adapterId: req.adapterId, account: req.account, hashes: req.hashes, threshold: req.threshold };
    const base = mod.progressMemorySize();
    mod.deriveStall(lot, req.pass);
    const createdAfterDerive = mod.progressMemorySize() - base;
    mod.forgetProgress(req.adapterId, req.account, req.forgetHash);
    const afterForgetOne = mod.progressMemorySize() - base;
    mod.forgetLotProgress(req.adapterId, req.account, req.hashes);
    const final = mod.progressMemorySize() - base;
    out = JSON.stringify({ createdAfterDerive, afterForgetOne, final });
  } else {
    throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
