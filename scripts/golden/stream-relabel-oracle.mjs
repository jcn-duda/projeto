#!/usr/bin/env node
/**
 * Runner do oráculo do golden `stream-relabel` (child descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo é a função REAL `relabel` de
 * `src/utils/stream-relabel.ts`, importada do `dist` staged. Aqui vive só:
 *
 *   1) o contrato de isolamento, verificado ANTES de importar — env mínima,
 *      CWD em staging no TEMP, dotenv apontando para arquivo vazio,
 *      CACHE_PERSIST=false, RUST_CORE=off, nenhuma credencial, NODE_OPTIONS
 *      ausente — e o trap de rede (qualquer `fetch` explode);
 *   2) a tradução do corpus para a função certa, sem reimplementar nada.
 *
 * O estilo (`streamNameStyle`/`streamNameShowSource`) é aplicado pelo caminho
 * REAL de `opts()`: `runtime.run({ opts }, fn)`. Nunca reimplementamos a
 * resolução default->usuário->config do `streamDisplayName`; só entregamos o
 * overlay por usuário e deixamos o código de produção decidir. As chaves de
 * `opts` são whitelisted (só estilo/fonte): qualquer credencial ou chave
 * desconhecida derruba o caso.
 *
 * Prova de não-mutação: o `stream` de entrada é serializado antes e depois de
 * cada `relabel`; qualquer diferença encerra o oráculo, então o golden só
 * existe para entradas comprovadamente não-mutadas.
 *
 * Uso: node stream-relabel-oracle.mjs <job.json>
 * Saída: UMA linha JSON em stdout, com `expected = JSON.stringify(resultado)`.
 * O `expected` é capturado no nível da STRING: jamais re-parseado aqui, para
 * não corromper code units UTF-16 isoladas (surrogates) em U+FFFD.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: stream-relabel-oracle.mjs <job.json>');
let job;
try {
  job = JSON.parse(readFileSync(jobPath, 'utf8'));
} catch (e) {
  fail(`job ilegível: ${e.message}`);
}

// --- contrato de isolamento, ANTES de qualquer import do oráculo ---
if (process.env.NODE_OPTIONS) fail('NODE_OPTIONS herdado do host: a env tem que ser limpa');
if (process.env.DOTENV_CONFIG_PATH !== job.dotenvPath) fail('DOTENV_CONFIG_PATH não aponta para o arquivo vazio');
if (process.env.CACHE_PERSIST !== 'false') fail("CACHE_PERSIST precisa ser 'false' (nada de cache.db real)");
if (process.env.RUST_CORE !== 'off') fail("RUST_CORE precisa ser 'off' (oráculo é TS puro)");
for (const name of job.forbiddenEnv) {
  if (process.env[name]) fail(`env proibida presente no oráculo: ${name}`);
}
if (process.cwd() !== job.cwd) fail(`CWD inesperado no oráculo: ${process.cwd()}`);

// Trap de rede: qualquer fetch explodiria antes de sair.
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const mod = await import(pathToFileURL(job.artifactPath).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
if (typeof mod.relabel !== 'function') fail('o dist não exporta relabel');
// `runtime.run` é o caminho real de `opts()`; o módulo é o mesmo que o
// stream-display já importou (mesma URL resolvida), então o overlay vale.
const runtime = await import(new URL('../runtime.js', pathToFileURL(job.artifactPath)).href).catch((e) =>
  fail(`import do runtime falhou: ${e.message}`),
);
if (typeof runtime.run !== 'function') fail('o dist não exporta runtime.run');
if (typeof runtime.opts !== 'function') fail('o dist não exporta runtime.opts');

// Só estilo/fonte pode vir do usuário: nada de credencial, token ou chave.
const ALLOWED_OPT_KEYS = new Set(['streamNameStyle', 'streamNameShowSource']);

/** Traduz um caso do corpus para `JSON.stringify(saída)` com o oráculo REAL. */
function render(c) {
  const stream = c.stream;
  if (stream === null || typeof stream !== 'object' || Array.isArray(stream)) {
    throw new Error('stream do caso precisa ser um objeto');
  }
  const options = c.options && typeof c.options === 'object' ? c.options : {};
  const opts = c.opts;
  if (opts !== undefined) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new Error('opts do caso precisa ser um objeto');
    }
    for (const key of Object.keys(opts)) {
      if (!ALLOWED_OPT_KEYS.has(key)) throw new Error(`opts com chave não permitida: ${key}`);
    }
  }
  const before = JSON.stringify(stream);
  const call = () => mod.relabel(stream, options);
  const output = opts !== undefined ? runtime.run({ opts }, call) : call();
  const after = JSON.stringify(stream);
  if (after !== before) throw new Error('relabel MUTOU o stream de entrada');
  if (typeof output !== 'string') throw new Error('relabel não devolveu string');
  return JSON.stringify(output);
}

const rows = [];
for (const c of job.cases) {
  let expected;
  try {
    expected = render(JSON.parse(c.input));
  } catch (e) {
    fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
  }
  rows.push({ id: c.id, expected });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases: rows })}\n`);
