#!/usr/bin/env node
/**
 * Oráculo do golden `collection-budget` — o TS do branch `esm`.
 *
 * Mede as funções REAIS de `dist/src/providers/collection-budget.js` sobre o
 * `config` REAL de `dist/src/config.js`. Como o corpus quer vários combos de
 * config, cada caso declara os quatro números (`replyDeadline`,
 * `debridReserve`, `brPartialGrace`, `debridCheckFloor`); o oráculo os APLICA no
 * objeto de config antes da chamada e restaura depois. São exatamente os mesmos
 * números que o teste Rust passa por parâmetro — nenhuma constante duplicada.
 *
 * Saída: `{ok, cases:[{id, out}]}`, `out` = `JSON.stringify(valor)`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const [jobPath, outPath] = process.argv.slice(2);
if (!jobPath || !outPath) fail('uso: collection-budget-oracle.mjs <job.json> <out.json>');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const budgetMod = await import(pathToFileURL(
  path.join(job.repo, 'dist', 'src', 'providers', 'collection-budget.js'),
).href).catch((e) => fail(`import do oráculo falhou: ${e.message}`));
const config = (await import(pathToFileURL(
  path.join(job.repo, 'dist', 'src', 'config.js'),
).href).catch((e) => fail(`import do config falhou: ${e.message}`))).default;

for (const name of ['computeCollectionBudget', 'computePriorityGrace']) {
  if (typeof budgetMod[name] !== 'function') fail(`o dist não exporta ${name}`);
}
const FIELDS = ['replyDeadline', 'debridReserve', 'brPartialGrace', 'debridCheckFloor'];
const original = Object.fromEntries(FIELDS.map((f) => [f, config[f]]));

/** Aplica o config declarado; devolve a função que restaura. */
function applyConfig(over) {
  const saved = Object.fromEntries(FIELDS.map((f) => [f, config[f]]));
  for (const field of FIELDS) {
    if (over[field] === undefined) continue;
    if (typeof over[field] !== 'number' || !Number.isFinite(over[field])) {
      fail(`config.${field} do corpus não é número finito`);
    }
    config[field] = over[field];
  }
  return () => {
    for (const field of FIELDS) config[field] = saved[field];
  };
}

function render(c) {
  const restore = applyConfig(c.config ?? {});
  try {
    switch (c.op) {
      case 'budget':
        return JSON.stringify(budgetMod.computeCollectionBudget(c.deadlineAt ?? null, c.now ?? 0));
      case 'grace':
        return JSON.stringify(budgetMod.computePriorityGrace());
      default:
        throw new Error(`op desconhecida: ${c.op}`);
    }
  } finally {
    restore();
  }
}

const cases = job.cases.map((c) => {
  let out;
  try {
    out = render(JSON.parse(c.input));
  } catch (e) {
    fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
  }
  return { id: c.id, out };
});
// Restauração final defensiva: o processo morre em seguida, mas o estado tem que
// voltar ao original antes de qualquer outra medição no mesmo child.
for (const field of FIELDS) config[field] = original[field];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
