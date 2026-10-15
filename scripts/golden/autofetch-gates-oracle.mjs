#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-gates`: mede a saída REAL do `dist` para cada
 * caso do corpus. Roda em processo filho isolado (sem rede, sem config real).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `classifyEnqueue` → rótulo do portão que fechou, ou "null" (todos passaram)
 * - `rollbackFor`     → `JSON.stringify` das ações de rollback (array de strings)
 *
 * `classifyEnqueue` recebe as closures com efeito no runner; aqui elas são
 * construídas a partir dos booleanos do caso (`req.gates`). Campos ausentes
 * usam o caminho feliz: positivos = false, `try*` = true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
for (const name of ['classifyEnqueue', 'ENQUEUE_ROLLBACK']) {
  if (mod[name] == null) throw new Error(`autofetch-gates não exporta ${name}`);
}

const reason = (v) => (v == null ? 'null' : String(v));
// Positivos fecham com true; os `try*` fecham com false (aquisição falhou).
const flag = (g, key, def) => {
  const v = g?.[key];
  return typeof v === 'boolean' ? v : def;
};

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'classifyEnqueue': {
      const g = req.gates ?? {};
      const gates = {
        isPaused: () => flag(g, 'isPaused', false),
        isDead: () => flag(g, 'isDead', false),
        isCached: () => flag(g, 'isCached', false),
        markerActive: () => flag(g, 'markerActive', false),
        tryLock: () => flag(g, 'tryLock', true),
        trySlot: () => flag(g, 'trySlot', true),
        tryObraCap: () => flag(g, 'tryObraCap', true),
        accountBlocked: () => flag(g, 'accountBlocked', false),
        tryBudget: () => flag(g, 'tryBudget', true),
      };
      out = reason(mod.classifyEnqueue(gates));
      break;
    }
    case 'rollbackFor':
      out = JSON.stringify(mod.ENQUEUE_ROLLBACK[req.reason] ?? []);
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
