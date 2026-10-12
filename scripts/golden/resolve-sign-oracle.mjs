#!/usr/bin/env node
/**
 * Runner do oráculo do golden resolve-sign (child process descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo é signResolve/verifyResolve REAIS,
 * importados do dist staged. Aqui só vive (1) o contrato de isolamento,
 * verificado ANTES de importar o oráculo — env mínima, CWD staging em TEMP,
 * dotenv apontando para arquivo vazio, CACHE_PERSIST=false, sem segredo real —
 * e (2) a aplicação das mutações de assinatura descritas no corpus. Nunca lê
 * .env real, nunca fala com debrid, nunca abre data/*.db.
 *
 * Uso: node resolve-sign-oracle.mjs <job.json>
 * O job traz caminhos JÁ dentro do staging e a chave FICTÍCIA esperada; a saída
 * é UMA linha JSON em stdout.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: resolve-sign-oracle.mjs <job.json>');
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
for (const name of job.forbiddenEnv) {
  if (process.env[name]) fail(`env proibida presente no oráculo: ${name}`);
}
if (process.cwd() !== job.cwd) fail(`CWD inesperado no oráculo: ${process.cwd()}`);

// Trap de rede: qualquer fetch explodiria antes de sair. O grafo estático (no
// pai) já garante que não há node:http/net/child_process no módulo importado.
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const mod = await import(pathToFileURL(job.artifactPath).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
const { signResolve, verifyResolve } = mod;
if (typeof signResolve !== 'function' || typeof verifyResolve !== 'function') {
  fail('o dist não exporta signResolve/verifyResolve');
}

// Proveniência: a chave EFETIVA tem que ser a fictícia esperada e nenhuma
// credencial real pode estar carregada (config.debrid.apiKey vazio fora do
// grupo de fallback).
const cfg = (await import(pathToFileURL(job.configPath).href)).default;
const rt = await import(pathToFileURL(job.runtimePath).href);
const effective = cfg.debrid.resolveSecret || rt.defaults().debridApiKey;
if (cfg.debrid.apiKey !== job.expect.apiKey) fail('config.debrid.apiKey difere do esperado (chave real vazaria?)');
if (cfg.debrid.resolveSecret !== job.expect.resolveSecret) fail('config.debrid.resolveSecret difere do esperado');
if (effective !== job.expect.effective) fail('chave efetiva difere da fictícia esperada');
if (effective && !effective.startsWith('adom-golden-resolve-sign-FAKE-')) {
  fail('chave efetiva sem o prefixo fictício: recusando assinar com chave de aparência real');
}

const sha256 = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex');

function mutate(kind, hex) {
  switch (kind) {
    case 'flipLastHex':
      return hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');
    case 'upper':
      return hex.toUpperCase();
    case 'dropLast':
      return hex.slice(0, -1);
    case 'appendSpace':
      return `${hex} `;
    case 'empty':
      return '';
    default:
      return fail(`mutação de assinatura desconhecida: ${kind}`);
  }
}

const expectedById = new Map();
const rows = [];
for (const c of job.cases) {
  const expected = signResolve(c.infoHash, c.ep, c.hint);
  let sig;
  if (c.sigMode === 'expected') {
    sig = expected;
  } else if (c.sigMode === 'literal') {
    sig = c.sigValue;
  } else if (c.sigMode === 'from') {
    if (!expectedById.has(c.sigFrom)) fail(`${c.id}: sigFrom '${c.sigFrom}' não precede este caso`);
    sig = expectedById.get(c.sigFrom);
  } else if (c.sigMode === 'mutate') {
    sig = mutate(c.sigMutate, expected);
  } else {
    fail(`sigMode desconhecido em ${c.id}: ${c.sigMode}`);
  }
  const verified = verifyResolve(c.infoHash, c.ep, sig, c.hint);
  expectedById.set(c.id, expected);
  rows.push({ id: c.id, sig, expected, verified });
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    node: process.version,
    keySource: job.keySource,
    effectiveKeySha256: sha256(effective),
    effectiveKeyEmpty: effective === '',
    cases: rows,
  })}\n`,
);
