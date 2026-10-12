#!/usr/bin/env node
/**
 * Runner do oráculo do golden `stream-display` (child descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo é a função REAL `streamDisplayName`
 * de `src/utils/stream-display.ts`, importada do `dist` staged. Aqui vive só
 * (1) o contrato de isolamento, verificado ANTES de importar — env mínima, CWD
 * em staging no TEMP, dotenv apontando para arquivo vazio, CACHE_PERSIST=false,
 * RUST_CORE=off, nenhuma credencial real (só valores fake com prefixo conhecido)
 * — e (2) a tradução do corpus para a chamada certa. Nunca lê .env real, nunca
 * abre data/*.db, nunca fala com debrid: o grafo importado não tem
 * node:http/net/child_process (garantido estaticamente pelo pai).
 *
 * O grupo `userOpts` usa a config da URL pelo caminho REAL do runtime:
 * `runtime.normalize` (mesma função que `decode` usa) + `runtime.run`, nunca um
 * objeto `opts` forjado. A prova de precedência do DEFAULT é o assert contra
 * `runtime.normalize(null)`: o valor tem que vir do env do grupo, não do .env.
 *
 * Uso: node stream-display-oracle.mjs <job.json>
 * Saída: UMA linha JSON em stdout:
 *   { ok, node, group, cases: [{ id, expected, expectedJson, orphanSurrogate }] }
 * `expectedJson` = JSON.stringify(resultado): SEMPRE JSON válido, inclusive com
 * surrogate UTF-16 órfão (o `expected` cru é o que o leitor Rust NÃO deve
 * parsear quando orphanSurrogate=true).
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FAKE_PREFIX = 'fakegolden-';
const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: stream-display-oracle.mjs <job.json>');
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
if (process.cwd() !== job.cwd) fail(`CWD inesperado no oráculo: ${process.cwd()}`);
for (const name of job.mustBeAbsent ?? []) {
  if (process.env[name] !== undefined) fail(`env proibida presente no oráculo: ${name}`);
}
for (const [name, value] of Object.entries(job.fakeEnv ?? {})) {
  if (!String(value).startsWith(FAKE_PREFIX)) fail(`valor fake sem prefixo conhecido: ${name}`);
  if (process.env[name] !== value) fail(`env fake divergente: ${name} (esperado o valor fake do job)`);
}

// Trap de rede: qualquer fetch explodiria antes de sair.
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const sd = await import(pathToFileURL(job.artifactPath).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
const rt = await import(pathToFileURL(job.runtimePath).href).catch((e) =>
  fail(`import do runtime falhou: ${e.message}`),
);
if (typeof sd.streamDisplayName !== 'function') fail('o dist não exporta streamDisplayName');
if (typeof rt.normalize !== 'function' || typeof rt.run !== 'function') fail('o runtime não exporta normalize/run');

// Precedência do DEFAULT: o config do grupo vem do env (não do .env real).
const defs = rt.normalize(null);
const wantStyle = job.config.style === 'full' ? 'full' : 'compact';
const wantShowSource = job.config.showSource === 'false' ? false : true;
if (defs.streamNameStyle !== wantStyle) fail(`default streamNameStyle=${defs.streamNameStyle}, esperado ${wantStyle}`);
if (defs.streamNameShowSource !== wantShowSource) fail(`default streamNameShowSource=${defs.streamNameShowSource}, esperado ${wantShowSource}`);

// Surrogate UTF-16 órfão: par cortado fora de lugar (compactTracker fatia em
// unidades UTF-16). É o quirk que o golden precisa congelar, não "consertar".
const ORPHAN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const rows = [];
for (const c of job.cases) {
  let out;
  try {
    const parsed = JSON.parse(c.input);
    const opts = parsed.opts ?? {};
    const call = () => sd.streamDisplayName(opts);
    out = parsed.userOpts === undefined ? call() : rt.run({ opts: rt.normalize(parsed.userOpts) }, call);
  } catch (e) {
    fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
  }
  if (typeof out !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
  rows.push({ id: c.id, expected: out, expectedJson: JSON.stringify(out), orphanSurrogate: ORPHAN.test(out) });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, group: job.config, cases: rows })}\n`);
