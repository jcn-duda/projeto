#!/usr/bin/env node
/**
 * Runner do oráculo do golden release-labels (child process descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo são `sourceFromTitle`,
 * `editionFromTitle` e `compactAudio` REAIS, importados do dist staged. Aqui
 * vive só (1) o contrato de isolamento, verificado ANTES de importar o oráculo
 * — env mínima sem NODE_OPTIONS, CWD no staging em TEMP, dotenv apontando para
 * arquivo vazio, CACHE_PERSIST=false, RUST_CORE=off, nenhuma credencial real —
 * e (2) a aplicação do corpus: cada `input` é um JSON `{op,text}` e a saída é a
 * string da função correspondente. Nunca lê .env real, nunca fala com rede,
 * nunca abre data/*.db.
 *
 * Uso: node release-labels-oracle.mjs <job.json>
 * O job traz caminhos JÁ dentro do staging; a saída é UMA linha JSON em stdout.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: release-labels-oracle.mjs <job.json>');
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

// Trap de rede: qualquer fetch explodiria antes de sair. O grafo estático (no
// pai) já garante que não há node:http/net/tls/dns/child_process no módulo.
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const mod = await import(pathToFileURL(job.artifactPath).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
if (
  typeof mod.sourceFromTitle !== 'function' ||
  typeof mod.editionFromTitle !== 'function' ||
  typeof mod.compactAudio !== 'function'
) {
  fail('o dist não exporta sourceFromTitle/editionFromTitle/compactAudio');
}

const rows = [];
for (const c of job.cases) {
  let parsed;
  try {
    parsed = JSON.parse(c.input);
  } catch (e) {
    fail(`caso ${c.id}: input não é JSON: ${e.message}`);
  }
  const op = parsed?.op;
  const text = parsed?.text;
  if (op !== 'source' && op !== 'edition' && op !== 'compact') fail(`caso ${c.id}: op desconhecida "${op}"`);
  if (typeof text !== 'string') fail(`caso ${c.id}: text precisa ser string (sem coerção)`);
  let expected;
  if (op === 'source') expected = mod.sourceFromTitle(text);
  else if (op === 'edition') expected = mod.editionFromTitle(text);
  else expected = mod.compactAudio(text);
  if (typeof expected !== 'string') fail(`caso ${c.id}: oráculo não devolveu string`);
  rows.push({ id: c.id, expected });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases: rows })}\n`);
