#!/usr/bin/env node
/**
 * Oráculo do golden `search-plan` — o TS do branch `esm`, nunca uma
 * reimplementação do Rust.
 *
 * Roda no child isolado de `golden-kit.mjs` (env mínima, dotenv vazio,
 * `RUST_CORE=off`, `CACHE_PERSIST=false`) e mede as funções REAIS exportadas por
 * `dist/src/providers/search-plan.js`, com os mesmos argumentos que o corpus
 * declara:
 *
 * - `plan` → `planJackettQueries(query, ptQuery, selected, ptBr, isolate,
 *   sweepQuery, originalQuery, multiWorkQuery)`;
 * - `ptSweepIndexers`, `liveIndexers` → listas;
 * - `ptSweepQuery(titlePt)`;
 * - `ptSweepQueryFor({titles})` / `dubbedSweepQueryFor({titles})`.
 *
 * Saída: arquivo JSON `{ok, cases:[{id, out}]}` com `out` STRING (o
 * `JSON.stringify` do valor), contrato do `renderJsonl` do kit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const [jobPath, outPath] = process.argv.slice(2);
if (!jobPath || !outPath) fail('uso: search-plan-oracle.mjs <job.json> <out.json>');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const artifact = path.join(job.repo, 'dist', 'src', 'providers', 'search-plan.js');
const mod = await import(pathToFileURL(artifact).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
for (const name of ['planJackettQueries', 'ptSweepIndexers', 'ptSweepQuery',
  'ptSweepQueryFor', 'dubbedSweepQueryFor', 'liveIndexers']) {
  if (typeof mod[name] !== 'function') fail(`o dist não exporta ${name}`);
}

function render(c) {
  switch (c.op) {
    case 'plan':
      return JSON.stringify(mod.planJackettQueries(
        c.query,
        c.ptQuery ?? null,
        c.selectedIndexers ?? [],
        c.ptBrIndexers ?? [],
        c.isolateIndexers ?? [],
        c.sweepQuery ?? null,
        c.originalQuery ?? null,
        c.multiWorkQuery ?? null,
      ));
    case 'ptSweepIndexers':
      return JSON.stringify(mod.ptSweepIndexers(
        c.selectedIndexers ?? [],
        c.ptBrIndexers ?? [],
        c.indexOnlyIndexers ?? [],
      ));
    case 'liveIndexers':
      return JSON.stringify(mod.liveIndexers(
        c.selectedIndexers ?? [],
        c.indexOnlyIndexers ?? [],
        c.exemptIndexers ?? [],
      ));
    case 'ptSweepQuery':
      return JSON.stringify(mod.ptSweepQuery(c.titlePt ?? null));
    case 'ptSweepQueryFor':
      return JSON.stringify(mod.ptSweepQueryFor({ titles: c.titles ?? null }));
    case 'dubbedSweepQueryFor':
      return JSON.stringify(mod.dubbedSweepQueryFor({ titles: c.titles ?? null }));
    default:
      throw new Error(`op desconhecida: ${c.op}`);
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
fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
