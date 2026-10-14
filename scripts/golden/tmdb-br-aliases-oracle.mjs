#!/usr/bin/env node
/**
 * Runner do oráculo do golden `tmdb-br-aliases` (child process descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo é `filterBrAliases` REAL, importado do
 * dist staged. Aqui vive só (1) o contrato de isolamento, verificado ANTES de
 * importar o oráculo — env mínima sem NODE_OPTIONS, CWD no staging em TEMP,
 * dotenv apontando para arquivo vazio, CACHE_PERSIST=false, RUST_CORE=off,
 * nenhuma credencial real — e (2) a tradução do corpus para a função certa.
 * Nunca lê .env real, nunca fala com rede (fetch com trap), nunca abre
 * data/*.db. O grafo estático (no pai) garante que não há node:http/net/... .
 *
 * Uso: node tmdb-br-aliases-oracle.mjs <job.json>
 * O job traz caminhos JÁ dentro do staging; a saída é UMA linha JSON em stdout.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: tmdb-br-aliases-oracle.mjs <job.json>');
let job;
try {
  job = JSON.parse(readFileSync(jobPath, 'utf8'));
} catch (e) {
  fail(`job ilegível: ${e.message}`);
}

// --- contrato de isolamento, ANTES de qualquer import do oráculo ---
if (process.env.NODE_OPTIONS) fail('NODE_OPTIONS herdado do host: a env do oráculo tem que ser limpa');
if (process.env.DOTENV_CONFIG_PATH !== job.dotenvPath) fail('DOTENV_CONFIG_PATH não aponta para o arquivo vazio');
if (process.env.CACHE_PERSIST !== 'false') fail("CACHE_PERSIST precisa ser 'false' (nada de cache.db real)");
if (process.env.RUST_CORE !== 'off') fail("RUST_CORE precisa ser 'off' (nenhuma ponte nativa no oráculo)");
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
if (typeof mod.filterBrAliases !== 'function') fail('o dist não exporta filterBrAliases');

/** Aceita só string ou null (sem coergir número/objeto/bool); null vira null. */
function list(value, field, id) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`caso ${id}: ${field} precisa ser lista`);
  return value.map((v) => {
    if (v === null) return null;
    if (typeof v !== 'string') fail(`caso ${id}: ${field} aceita só string ou null (sem coerção)`);
    return v;
  });
}

const rows = [];
for (const c of job.cases) {
  let parsed;
  try {
    parsed = JSON.parse(c.input);
  } catch (e) {
    fail(`caso ${c.id}: input não é JSON: ${e.message}`);
  }
  if (parsed?.op !== 'filter') fail(`caso ${c.id}: op desconhecida "${parsed?.op}"`);
  const candidates = list(parsed.candidates, 'candidates', c.id);
  const canonical = list(parsed.canonical, 'canonical', c.id);
  const expected = JSON.stringify(mod.filterBrAliases(candidates, canonical));
  if (typeof expected !== 'string') fail(`caso ${c.id}: oráculo não devolveu string`);
  rows.push({ id: c.id, expected });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases: rows })}\n`);
