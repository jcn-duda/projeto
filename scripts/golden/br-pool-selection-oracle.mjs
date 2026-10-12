#!/usr/bin/env node
/**
 * Runner do oráculo do golden `br-pool-selection` (child descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo são `brDubbedPool`, `anyDubbedPool`,
 * `topSeededPool` (`dist/src/utils/autofetch-pools.js`) e
 * `pickBrDubbedByTargetQualities` (`dist/src/utils/autofetch-picks.js`) REAIS,
 * importados do dist staged. Aqui vive só (1) o contrato de isolamento,
 * verificado ANTES de importar o oráculo — env mínima sem NODE_OPTIONS, CWD no
 * staging em TEMP, dotenv apontando para arquivo vazio, CACHE_PERSIST=false,
 * RUST_CORE=off, nenhuma credencial real — e (2) a aplicação do corpus.
 *
 * Cada `input` é um JSON `{op,streams,season?,minSeeders?,ptFirst?,limit?,cached?}`
 * onde cada stream traz um `id` estável e só os campos que os pools leem. O
 * oráculo monta os objetos `Stream` no formato interno (`_br`, `_dubbed`, …),
 * chama a função por `op`, e devolve `{ids:[…],stable:true}` — os `id`s na ORDEM
 * do resultado. O `id` não é campo do addon: serve só para mapear a saída.
 *
 * Uso: node br-pool-selection-oracle.mjs <job.json>
 * O job traz caminhos JÁ dentro do staging; a saída é UMA linha JSON em stdout.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: br-pool-selection-oracle.mjs <job.json>');
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

const pools = await import(pathToFileURL(job.artifacts.pools).href).catch((e) =>
  fail(`import de autofetch-pools falhou: ${e.message}`),
);
const picks = await import(pathToFileURL(job.artifacts.picks).href).catch((e) =>
  fail(`import de autofetch-picks falhou: ${e.message}`),
);
for (const name of ['brDubbedPool', 'anyDubbedPool', 'topSeededPool']) {
  if (typeof pools[name] !== 'function') fail(`autofetch-pools não exporta ${name}`);
}
if (typeof picks.pickBrDubbedByTargetQualities !== 'function') {
  fail('autofetch-picks não exporta pickBrDubbedByTargetQualities');
}

/** Corpus stream → objeto `Stream` real (só os campos que os pools leem). */
function buildStream(s) {
  return {
    infoHash: s.infoHash,
    title: s.title,
    name: s.name,
    _seeders: s.seeders,
    _quality: s.quality,
    _br: s.br === true,
    _dubbed: s.dubbed === true,
    _dubClaim: s.dubClaim === true,
    _bankDub: s.bankDub === true,
    _lied: s.lied === true,
    _fromFallback: s.fromFallback === true,
    _fallbackFetchable: s.fallbackFetchable === true,
  };
}

const rows = [];
for (const c of job.cases) {
  let req;
  try {
    req = JSON.parse(c.input);
  } catch (e) {
    fail(`caso ${c.id}: input não é JSON: ${e.message}`);
  }
  if (!Array.isArray(req?.streams)) fail(`caso ${c.id}: streams precisa ser lista`);
  const ids = req.streams.map((s, i) => {
    if (typeof s?.id !== 'string' || !s.id) fail(`caso ${c.id}: stream ${i} sem id`);
    return s.id;
  });
  const streams = req.streams.map(buildStream);
  const byObj = new Map();
  streams.forEach((s, i) => byObj.set(s, ids[i]));
  const opts = { season: req.season ?? null, minSeeders: req.minSeeders ?? 0, ptFirst: req.ptFirst ?? true };
  const before = JSON.stringify(streams.map((s) => byObj.get(s)));

  let result;
  if (req.op === 'br') result = pools.brDubbedPool(streams, { season: req.season ?? null });
  else if (req.op === 'any') result = pools.anyDubbedPool(streams, { season: req.season ?? null });
  else if (req.op === 'top') result = pools.topSeededPool(streams, opts);
  else if (req.op === 'target') {
    result = picks.pickBrDubbedByTargetQualities(
      streams,
      new Set(req.cached ?? []),
      req.limit ?? 3,
      { season: req.season ?? null },
    );
  } else fail(`caso ${c.id}: op desconhecida "${req.op}"`);

  if (!Array.isArray(result)) fail(`caso ${c.id}: oráculo não devolveu lista`);
  const outIds = result.map((s) => {
    const id = byObj.get(s);
    if (typeof id !== 'string') fail(`caso ${c.id}: resultado trouxe stream fora do pool`);
    return id;
  });
  const stable = JSON.stringify(streams.map((s) => byObj.get(s))) === before;
  rows.push({ id: c.id, expected: JSON.stringify({ ids: outIds, stable }) });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases: rows })}\n`);
