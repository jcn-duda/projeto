#!/usr/bin/env node
/**
 * Oráculo do golden da via do banco de magnets — o TS REAL do `dist`, nunca uma
 * reimplementação do Rust.
 *
 * Roda no child isolado de `golden-kit.mjs` (env mínima, dotenv vazio,
 * `RUST_CORE=off`, `CACHE_PERSIST=false`) e mede:
 *
 * - `pickSource` → `dist/src/providers/magnet-bank-fallback.js`; a saída é o
 *   ÍNDICE da fonte escolhida (`sources.indexOf`) ou "null" — o empate do
 *   `reduce` fica com a primeira, e o índice prova isso;
 * - `isRecentRelease` → `dist/src/providers/magnet-bank-instant.js`, "1"/"0";
 * - `instantWindow` → JSON do `{windowMs,lastCollection,newest,stability,fresh}`.
 *
 * `meta.year` vira STRING antes de entrar (o TS faz `String(meta.year ?? '')`),
 * e números/`null` seguem essa mesma coerção.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const [jobPath, outPath] = process.argv.slice(2);
if (!jobPath || !outPath) fail('uso: search-bank-oracle.mjs <job.json> <out.json>');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const load = (rel) => import(pathToFileURL(path.join(job.repo, rel)).href)
  .catch((e) => fail(`import do oráculo falhou (${rel}): ${e.message}`));

const fallback = await load('dist/src/providers/magnet-bank-fallback.js');
const instant = await load('dist/src/providers/magnet-bank-instant.js');
for (const [mod, name] of [[fallback, 'pickSource'], [instant, 'isRecentRelease'], [instant, 'instantWindow']]) {
  if (typeof mod[name] !== 'function') fail(`o dist não exporta ${name}`);
}

/** Coerções do TS: `String(value || '')` e `String(meta.year ?? '')`. */
const jsString = (value) => String(value ?? '');
const asTime = (value) => {
  const text = jsString(value);
  if (!text) return 0;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
};

function render(c) {
  const req = JSON.parse(c.input);
  if (req.op === 'pickSource') {
    const chosen = fallback.pickSource(req.sources, new Set(req.failed), Boolean(req.allFailed));
    return chosen === null ? 'null' : String(req.sources.indexOf(chosen));
  }
  if (req.op === 'isRecentRelease') {
    const meta = req.meta === null || req.meta === undefined ? null : {
      year: req.meta.year ?? '',
      released: req.meta.released ?? null,
      firstAired: req.meta.firstAired ?? null,
    };
    return instant.isRecentRelease(meta, req.now) ? '1' : '0';
  }
  if (req.op === 'instantWindow') {
    const meta = req.meta === null || req.meta === undefined ? null : {
      year: req.meta.year ?? '',
      released: req.meta.released ?? null,
      firstAired: req.meta.firstAired ?? null,
    };
    return JSON.stringify(instant.instantWindow(req.works, meta, req.now));
  }
  fail(`op desconhecida no caso ${c.id}: ${req.op}`);
}

const cases = job.cases.map((c) => ({ id: c.id, out: render(c) }));
fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
