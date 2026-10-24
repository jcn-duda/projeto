#!/usr/bin/env node
/**
 * Runner do oráculo do golden `search-name-helpers` (child descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo são as funções REAIS de
 * `search-names.ts`, importadas do `dist` staged. Aqui vive só (1) o contrato de
 * isolamento, verificado ANTES de importar — env mínima, CWD em staging no
 * TEMP, dotenv apontando para arquivo vazio, CACHE_PERSIST=false, RUST_CORE=off,
 * nenhuma credencial — e (2) a tradução do corpus para a função certa. Nunca lê
 * .env real, nunca abre data/*.db, nunca fala com debrid: o grafo importado não
 * tem node:http/net/child_process (garantido estaticamente pelo pai).
 *
 * Uso: node search-name-helpers-oracle.mjs <job.json>
 * Saída: UMA linha JSON em stdout, com `expected = JSON.stringify(resultado)`.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: search-name-helpers-oracle.mjs <job.json>');
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
for (const name of ['resolveSearchNames', 'resolveOriginalStepName', 'parseStremioId',
  'buildSearchQuery', 'numeralSearchVariant', 'markDebridName', 'matchesQualityFilter']) {
  if (typeof mod[name] !== 'function') fail(`o dist não exporta ${name}`);
}

/** Traduz um caso do corpus para `JSON.stringify(resultado)` com o oráculo REAL. */
function render(input) {
  const c = JSON.parse(input);
  switch (c.op) {
    case 'resolveSearchNames':
      return JSON.stringify(mod.resolveSearchNames({ meta: c.meta, titles: c.titles, imdbId: c.imdbId }));
    case 'resolveOriginalStepName':
      return JSON.stringify(mod.resolveOriginalStepName(c.original ?? null, c.primaryName ?? null));
    case 'parseStremioId':
      return JSON.stringify(mod.parseStremioId(c.id));
    case 'buildSearchQuery':
      return JSON.stringify(mod.buildSearchQuery(c.meta ?? null, { season: c.season, episode: c.episode }));
    case 'numeralSearchVariant':
      return JSON.stringify(mod.numeralSearchVariant(c.query));
    case 'markDebridName':
      return JSON.stringify(mod.markDebridName(c.name ?? '', c.short ?? '', c.cached === true));
    case 'matchesQualityFilter':
      return JSON.stringify(mod.matchesQualityFilter(c.title, c.filters ?? undefined));
    default:
      throw new Error(`op desconhecida: ${c.op}`);
  }
}

const rows = [];
for (const c of job.cases) {
  let expected;
  try {
    expected = render(c.input);
  } catch (e) {
    fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
  }
  if (typeof expected !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
  rows.push({ id: c.id, expected });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases: rows })}\n`);
