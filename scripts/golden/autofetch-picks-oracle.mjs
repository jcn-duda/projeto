#!/usr/bin/env node
/**
 * Runner do oráculo do golden `autofetch-picks` (child descartável).
 *
 * Este arquivo NÃO é o oráculo: o oráculo são as funções REAIS de
 * `dist/src/utils/autofetch-picks.js`, importadas do staging. Aqui vive só
 * (1) o contrato de isolamento, verificado ANTES de importar o oráculo — env
 * mínima sem NODE_OPTIONS, CWD no staging em TEMP, dotenv vazio,
 * CACHE_PERSIST=false, RUST_CORE=off, nenhuma credencial real — e (2) a
 * aplicação do corpus.
 *
 * Cada `input` é um JSON `{op, streams?, cached?, limit?, season?, minSeeders?,
 * ptFirst?, cachedOnly?, showUncachedBr?, brReservedSlots?, known?, missHashes?,
 * autoFetchBr?, cacheCheck?, autofetchSource?}` onde cada stream traz um `id`
 * estável e só os campos que os picks leem. A saída por op (chaves nesta ORDEM,
 * que o teste Rust reproduz byte a byte):
 *   pickBr/pickAny/pickTop/uncachedBr → {"ids":[…],"stable":true}
 *   hasCachedBr/hasCachedAny/canAutoFetch → {"value":bool,"stable":true}
 *   cachedTargets → {"qualities":[…],"stable":true}   (ordem lexicográfica)
 *   filterKnown → {"ids":[…],"visibleBr":[…],"stable":true} (visibleBr ordenado)
 * `uncachedBr` preserva a ORDEM DE SELEÇÃO do Set (casca original do hash);
 * `visibleBr`/`qualities` são conjuntos → saída ordenada p/ determinismo.
 *
 * Uso: node autofetch-picks-oracle.mjs <job.json>  → UMA linha JSON em stdout.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: autofetch-picks-oracle.mjs <job.json>');
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

globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const picks = await import(pathToFileURL(job.artifacts.picks).href).catch((e) =>
  fail(`import de autofetch-picks falhou: ${e.message}`),
);
for (const name of [
  'pickBrDubbedCandidates', 'pickAnyDubbedCandidates', 'pickTopSeededCandidates',
  'hasCachedBrDubbed', 'hasCachedAnyDubbed', 'cachedBrDubbedTargetQualities',
  'uncachedBrHashes', 'canAutoFetchBr', 'filterKnownCache',
]) {
  if (typeof picks[name] !== 'function') fail(`autofetch-picks não exporta ${name}`);
}

/** Corpus stream → objeto `Stream` real (só os campos que os picks leem). */
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

  // canAutoFetchBr não usa streams: só os flags do toggle e do adapter.
  if (req.op === 'canAutoFetch') {
    const value = picks.canAutoFetchBr(
      { autoFetchBr: req.autoFetchBr === true },
      { cacheCheck: req.cacheCheck === true, autofetchSource: req.autofetchSource === true },
    );
    rows.push({ id: c.id, expected: JSON.stringify({ value: value === true, stable: true }) });
    continue;
  }

  if (!Array.isArray(req?.streams)) fail(`caso ${c.id}: streams precisa ser lista`);
  const ids = req.streams.map((s, i) => {
    if (typeof s?.id !== 'string' || !s.id) fail(`caso ${c.id}: stream ${i} sem id`);
    return s.id;
  });
  const streams = req.streams.map(buildStream);
  const byObj = new Map();
  const byHash = new Map();
  streams.forEach((s, i) => {
    byObj.set(s, ids[i]);
    if (s.infoHash !== undefined && s.infoHash !== null) byHash.set(String(s.infoHash), ids[i]);
  });
  const opts = { season: req.season ?? null, minSeeders: req.minSeeders ?? 0, ptFirst: req.ptFirst ?? true };
  const cached = new Set(req.cached ?? []);
  const before = JSON.stringify(streams.map((s) => byObj.get(s)));
  const toIds = (list) => list.map((s) => {
    const id = byObj.get(s);
    if (typeof id !== 'string') fail(`caso ${c.id}: resultado trouxe stream fora do pool`);
    return id;
  });
  const hashToIds = (set) => [...set].map((h) => {
    const id = byHash.get(String(h));
    if (typeof id !== 'string') fail(`caso ${c.id}: hash fora do pool: ${h}`);
    return id;
  });

  let expected;
  switch (req.op) {
    case 'pickBr':
      expected = { ids: toIds(picks.pickBrDubbedCandidates(streams, cached, req.limit ?? 1, opts)) };
      break;
    case 'pickAny':
      expected = { ids: toIds(picks.pickAnyDubbedCandidates(streams, cached, req.limit ?? 1, opts)) };
      break;
    case 'pickTop':
      expected = { ids: toIds(picks.pickTopSeededCandidates(streams, cached, req.limit ?? 1, opts)) };
      break;
    case 'uncachedBr':
      expected = { ids: hashToIds(picks.uncachedBrHashes(streams, cached, req.limit ?? 0)) };
      break;
    case 'hasCachedBr':
      expected = { value: picks.hasCachedBrDubbed(streams, cached) === true };
      break;
    case 'hasCachedAny':
      expected = { value: picks.hasCachedAnyDubbed(streams, cached) === true };
      break;
    case 'cachedTargets':
      expected = { qualities: [...picks.cachedBrDubbedTargetQualities(streams, cached, opts)].sort() };
      break;
    case 'filterKnown': {
      const out = picks.filterKnownCache(streams, cached, {
        cachedOnly: req.cachedOnly ?? true,
        showUncachedBr: req.showUncachedBr ?? false,
        brReservedSlots: req.brReservedSlots ?? 0,
        known: req.known ?? true,
        missHashes: req.missHashes ? new Set(req.missHashes) : undefined,
      });
      expected = { ids: toIds(out.streams), visibleBr: hashToIds(out.visibleBr).sort() };
      break;
    }
    default:
      fail(`caso ${c.id}: op desconhecida "${req.op}"`);
  }

  const stable = JSON.stringify(streams.map((s) => byObj.get(s))) === before;
  rows.push({ id: c.id, expected: JSON.stringify({ ...expected, stable }) });
}

process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases: rows })}\n`);
