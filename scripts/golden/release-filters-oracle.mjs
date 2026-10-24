#!/usr/bin/env node
/**
 * Oráculo do golden de relevância crua (`src/utils/release-filters.ts`).
 *
 * Mede SÓ `filterRelevantRaw` (que contém o corte de `filterRelevantRawForYear`)
 * — a saída REAL do `dist`, nunca uma reimplementação do TS. Roda no staging
 * descartável montado por `dump-release-filters.mjs` (CWD no staging, env
 * mínima, sem .env/data, RUST_CORE=off): lê o `job.json` (artefato absoluto +
 * casos), importa o artefato por caminho absoluto e devolve
 * `{ok:true, cases:[{id,out}]}` no stdout.
 *
 * O `input` de cada caso é um JSON tipado: `items` (RawItem), `names`, `year`,
 * `altYear`, `isSeries`, `season`, `episode`, `multiWork`, `homeReleaseAt`, além
 * de três entradas de ambiente que o TS lê em tempo de chamada:
 * `now` (vira `Date.now()`), `preHomeCut` e `preHomeMarginMs` (viram
 * `config.search.preHomeReleaseCut` e `preHomeReleaseMarginMs`). O
 * `titlePrecisionTailCut` NÃO é alterado por caso: o TS o lê uma vez, ao carregar
 * o módulo (`TITLE_PRECISION_MIN`), e o golden fica no default do processo.
 *
 * A saída canônica é `{"kept":[índices],"rejected":[[índice,"motivo"],...]}`,
 * com os rejeitados na ordem em que o `onRejected` do TS dispara.
 * `fetch` é armado para explodir: o grafo é puro e não toca a rede.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);
// config.js fica ao lado de `utils/` no staging (dist/src/config.js).
const { default: config } = await import(
  pathToFileURL(path.resolve(path.dirname(job.artifact), '..', 'config.js')).href,
);
const realNow = Date.now;

try {
  const cases = job.cases.map((c) => {
    const req = JSON.parse(c.input);
    config.search.preHomeReleaseCut = req.preHomeCut;
    config.search.preHomeReleaseMarginMs = req.preHomeMarginMs;
    Date.now = () => req.now;
    const items = req.items.map((it) => ({ ...it }));
    const options = {
      names: req.names,
      year: req.year,
      altYear: req.altYear,
      isSeries: req.isSeries,
      season: req.season,
      episode: req.episode,
      multiWork: req.multiWork,
      homeReleaseAt: req.homeReleaseAt,
    };
    const rejected = [];
    const kept = mod.filterRelevantRaw(items, options, (item, reason) => {
      rejected.push([items.indexOf(item), reason]);
    });
    const keptSet = new Set(kept);
    const keptIdx = items.flatMap((it, i) => (keptSet.has(it) ? [i] : []));
    return { id: c.id, out: JSON.stringify({ kept: keptIdx, rejected }) };
  });
  process.stdout.write(JSON.stringify({ ok: true, cases }));
} finally {
  Date.now = realNow;
}
