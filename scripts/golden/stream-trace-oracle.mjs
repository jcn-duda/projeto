#!/usr/bin/env node
/**
 * Oráculo do golden `stream-trace` (P5): child descartável que roda contra o
 * staging compilado e NUNCA é réplica — cada operação chama a função REAL do
 * módulo (create/clone/stage/setStage/drop/finalize/setChupim/sanitize/serialize).
 *
 * Aqui vive só (1) o contrato de isolamento, verificado ANTES de importar o
 * oráculo — env mínima sem NODE_OPTIONS, CWD no staging em TEMP, dotenv
 * apontando para arquivo vazio, CACHE_PERSIST=false, RUST_CORE=off, STREAM_TRACE
 * exato e nenhuma credencial real — e (2) o interpretador do descritor de
 * cenário. Nunca lê .env real, nunca fala com rede, nunca abre data/*.db.
 *
 * Protocolo do cenário (o `input` de cada caso):
 *   { clock?: {base, step}, ops: [ {op, ...} ], capture: "<var>"|"$last" }
 * Operações: create, clone, stage, setStage, drop, setChupim, finalize,
 * sanitizeLabel, serialize. `repeat` é recusado aqui de propósito: só o driver
 * expande (restrição de protocolo). Args podem ser um var (string), um objeto
 * literal, ou um marcador `{"$":"undef"|"null"|"nan"|"inf"|"-inf"}`.
 *
 * Saída: UMA linha JSON `{ok, cases:[{id, out}]}`; `out` é o texto exato
 * `JSON.stringify(valor capturado)` (undefined vira a string "undefined"), o
 * que mantém surrogate órfão de corte UTF-16 escapado no nível de string.
 *
 * Uso: node stream-trace-oracle.mjs <job.json>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const jobPath = process.argv[2];
if (!jobPath) fail('uso: stream-trace-oracle.mjs <job.json>');
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
if (process.env.STREAM_TRACE !== job.streamTrace) {
  fail(`STREAM_TRACE=${process.env.STREAM_TRACE}, esperado ${job.streamTrace}`);
}
for (const name of job.forbiddenEnv) {
  if (process.env[name]) fail(`env proibida presente no oráculo: ${name}`);
}
if (process.cwd() !== job.cwd) fail(`CWD inesperado no oráculo: ${process.cwd()}`);

// Trap de rede: qualquer fetch explode antes de sair. O grafo estático (no
// pai) já garante que não há node:http/net/tls/dns/child_process no módulo.
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

// Relógio fake determinístico, armado ANTES do import: createStreamTrace e
// finalizeTrace leem Date.now(), e o golden precisa ser reprodutível. Cada
// chamada soma `step` a partir de `base`, resetado por caso.
let clockBase = 1000;
let clockStep = 1;
let clockCalls = 0;
Date.now = () => {
  const v = clockBase + clockStep * clockCalls;
  clockCalls += 1;
  return v;
};

// Prova de "defaults lidos do config de verdade": o valor resolvido de
// config.search.streamTrace tem que casar com a variante de env do job.
const configMod = await import(pathToFileURL(job.configPath).href).catch((e) =>
  fail(`import do config falhou: ${e.message}`),
);
const resolvedEnabled = configMod.default?.search?.streamTrace;
if (resolvedEnabled !== job.expectedEnabled) {
  fail(`config.search.streamTrace=${resolvedEnabled}, esperado ${job.expectedEnabled}`);
}

const mod = await import(pathToFileURL(job.artifactPath).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
const REQUIRED = [
  'createStreamTrace', 'cloneStreamTrace', 'stageTrace', 'setTraceStage',
  'setTraceChupim', 'dropTrace', 'finalizeTrace', 'sanitizeTraceLabel', 'serializeTrace',
];
for (const name of REQUIRED) {
  if (typeof mod[name] !== 'function') fail(`o dist não exporta ${name}`);
}

const SPECIAL = { undef: undefined, null: null, nan: NaN, inf: Infinity, '-inf': -Infinity };
function decodeTop(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '$')) {
    const tag = String(v.$);
    if (!Object.prototype.hasOwnProperty.call(SPECIAL, tag)) fail(`tag especial desconhecida: ${tag}`);
    return SPECIAL[tag];
  }
  return v;
}
// undefined não é JSON: o wire do golden grava a palavra "undefined".
const jsonOf = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

function runCase(c) {
  const s = c.scenario;
  if (!Array.isArray(s?.ops) || s.ops.length === 0) fail(`caso ${c.id}: ops vazio`);
  if (typeof s.capture !== 'string' || !s.capture) fail(`caso ${c.id}: capture ausente`);
  clockBase = Number.isFinite(s.clock?.base) ? s.clock.base : 1000;
  clockStep = Number.isFinite(s.clock?.step) ? s.clock.step : 1;
  clockCalls = 0;
  const vars = new Map();
  let last;
  const refOf = (v) => {
    if (typeof v === 'string') {
      if (!vars.has(v)) fail(`caso ${c.id}: var desconhecida ${v}`);
      return vars.get(v);
    }
    return decodeTop(v);
  };
  for (const op of s.ops) {
    // repeat é do driver, não do oráculo: a expansão nunca replica o algoritmo.
    if (op.repeat !== undefined) fail(`caso ${c.id}: "repeat" é do driver; o oráculo recusa`);
    const into = op.into;
    const put = (val) => {
      if (into) vars.set(into, val);
      last = val;
      return val;
    };
    switch (op.op) {
      case 'create':
        put(mod.createStreamTrace());
        break;
      case 'clone':
        put(mod.cloneStreamTrace(refOf(op.from ?? 't')));
        break;
      case 'stage':
        put(mod.stageTrace(refOf(op.t ?? 't'), decodeTop(op.stage), decodeTop(op.count)));
        break;
      case 'setStage':
        put(mod.setTraceStage(refOf(op.t ?? 't'), decodeTop(op.stage), decodeTop(op.count)));
        break;
      case 'drop':
        put(mod.dropTrace(refOf(op.t ?? 't'), decodeTop(op.item), decodeTop(op.reason)));
        break;
      case 'setChupim':
        put(mod.setTraceChupim(refOf(op.t ?? 't'), decodeTop(op.note)));
        break;
      case 'finalize':
        put(mod.finalizeTrace(refOf(op.t ?? 't'), decodeTop(op.finalCount)));
        break;
      case 'sanitizeLabel':
        put(mod.sanitizeTraceLabel(decodeTop(op.label)));
        break;
      case 'serialize':
        put(mod.serializeTrace(refOf(op.t ?? 't')));
        break;
      // Reflexão pura (test-only): escreve num caminho da var para provar que o
      // clone copia itens/estágios por valor. Não é função do ledger e não
      // replica nenhum predicado.
      case 'assign': {
        const target = refOf(op.t ?? 't');
        const keys = String(op.path).split('.');
        let obj = target;
        for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
        obj[keys[keys.length - 1]] = decodeTop(op.value);
        put(target);
        break;
      }
      default:
        fail(`caso ${c.id}: op desconhecida "${op.op}"`);
    }
  }
  if (s.capture === '$last') return jsonOf(last);
  if (!vars.has(s.capture)) fail(`caso ${c.id}: capture aponta var desconhecida ${s.capture}`);
  return jsonOf(vars.get(s.capture));
}

const cases = [];
for (const c of job.cases) {
  try {
    cases.push({ id: c.id, out: runCase(c) });
  } catch (e) {
    fail(`caso ${c.id}: ${e.message}`);
  }
}
process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, cases })}\n`);
