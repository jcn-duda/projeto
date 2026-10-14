#!/usr/bin/env node
/**
 * Oráculo do golden de `filterInventoryRelevant` (`src/utils/release-filters.ts`).
 *
 * Roda SÓ a função real do `dist` (nunca uma reimplementação), dentro do
 * staging descartável montado por `dump-inventory-filter.mjs`. Lê o `job.json`
 * (artefato absoluto + casos) e devolve `{ok:true, cases:[{id,out}]}` no stdout.
 *
 * O `input` de cada caso é `{"items":[...], "options":{...}}`. A saída canônica
 * é `{"kept":[índices],"rejected":[[índice,"motivo"],...]}`, com os motivos na
 * ordem em que o `onRejected` dispara. Relógio: as datas de estreia do corpus
 * ficam longe de "agora" (2000 e 2090), então `Date.now()` não muda o veredito.
 * `fetch` é armado para explodir: a função é pura e não toca a rede.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const o = req.options;
  const items = req.items;
  const index = new Map(items.map((item, i) => [item, i]));
  const opts = {
    names: o.names,
    year: o.year,
    isSeries: o.isSeries,
    season: o.season ?? null,
    episode: o.episode ?? null,
    altYear: o.altYear ?? null,
    multiWork: o.multiWork ? { name: '', root: o.multiWork.root, years: [] } : null,
    homeReleaseAt: o.homeReleaseAt ?? null,
  };
  const rejected = [];
  const kept = mod.filterInventoryRelevant(items, opts, (item, reason) => {
    rejected.push([index.get(item), reason]);
  });
  const keptIdx = kept.map((item) => index.get(item));
  return { id: c.id, out: JSON.stringify({ kept: keptIdx, rejected }) };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
