#!/usr/bin/env node
/**
 * Oráculo do golden `search-pool-coverage` — o TS do branch `esm`.
 *
 * Mede as funções REAIS de `dist/src/providers/search-pool-coverage.js`:
 *
 * - `pool`: `poolCovered(items, {season, requireDubbed})`. O piso do
 *   melhor-swarm (`minSeeders`) é lido DENTRO da função, de
 *   `autofetchLive.effective().autoFetchMinSeeders`; para o corpus cobrir vários
 *   pisos, o oráculo aplica `minSeeders` via `autofetchLive.set(...)` (API real
 *   do painel) e confere que o valor efetivo é o declarado — se o clamp mudar o
 *   número, o oráculo falha alto em vez de medir outra coisa.
 * - `idx`: `idxPoolCovered(releases, {season, episode})` mais a MEDIÇÃO do
 *   `packOnly` pelo contador real `search.idx.packOnly` (`metrics.snapshot()`),
 *   nunca por inferência. O resultado sai `{covered, packOnly}`.
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
if (!jobPath || !outPath) fail('uso: search-pool-coverage-oracle.mjs <job.json> <out.json>');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const base = path.join(job.repo, 'dist', 'src');
const mod = await import(pathToFileURL(path.join(base, 'providers', 'search-pool-coverage.js')).href)
  .catch((e) => fail(`import do oráculo falhou: ${e.message}`));
const autofetchLive = (await import(pathToFileURL(path.join(base, 'utils', 'autofetch-live.js')).href)
  .catch((e) => fail(`import do autofetch-live falhou: ${e.message}`))).default;
const metrics = await import(pathToFileURL(path.join(base, 'utils', 'metrics.js')).href)
  .catch((e) => fail(`import do metrics falhou: ${e.message}`));

for (const name of ['poolCovered', 'idxPoolCovered']) {
  if (typeof mod[name] !== 'function') fail(`o dist não exporta ${name}`);
}

/** Aplica o piso do melhor-swarm na config viva; devolve a restauração. */
function applyMinSeeders(value) {
  if (value === undefined) return () => {};
  const res = autofetchLive.set({ autoFetchMinSeeders: value });
  if (!res.ok) fail(`autofetchLive.set recusou minSeeders=${value}: ${res.errors.join('; ')}`);
  const effective = autofetchLive.effective().autoFetchMinSeeders;
  if (effective !== value) {
    fail(`minSeeders=${value} virou ${effective} no clamp; ajuste o corpus`);
  }
  return () => autofetchLive.reset();
}

function packOnlyCount() {
  return metrics.snapshot().counters['search.idx.packOnly'] || 0;
}

function render(c) {
  const restore = applyMinSeeders(c.minSeeders);
  try {
    switch (c.op) {
      case 'pool':
        return JSON.stringify(mod.poolCovered(c.items, {
          season: c.season ?? null,
          requireDubbed: c.requireDubbed === true,
        }));
      case 'idx': {
        const before = packOnlyCount();
        const covered = mod.idxPoolCovered(c.releases, {
          season: c.season ?? null,
          episode: c.episode ?? null,
        });
        const after = packOnlyCount();
        return JSON.stringify({ covered: Boolean(covered), packOnly: after > before });
      }
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
autofetchLive.reset();
fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
