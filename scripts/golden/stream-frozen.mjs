#!/usr/bin/env node
// Harness do gate de paridade congelada do /stream (Fase 1).
//
// Uso:
//   node scripts/golden/stream-frozen.mjs replay --case <id> [--dir <raiz>] [--encoded e30]
//   node scripts/golden/stream-frozen.mjs record --case <id> --type movie|series --id <streamId> \
//     [--dir <raiz>] [--encoded e30] [--timeout-ms 90000] [--indexers csv]
//   node scripts/golden/stream-frozen.mjs batch --mode replay|record [--cases <arquivo.json>] \
//     [--dir <raiz>] [--encoded e30] [--timeout-ms 90000] [--indexers csv]
//   node scripts/golden/stream-frozen.mjs manifest <caso>
//   node scripts/golden/stream-frozen.mjs compare <caso>
//   node scripts/golden/stream-frozen.mjs verify
//
// replay/record importam `dist/src/app.js` (createApp + listen(0)), NUNCA
// `src/addon.ts`: aquele sobe o processo, warmup e colhedor. As envs do gate
// são setadas antes do import (o módulo frozen lê no import).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO,
  DEFAULT_ROOT,
  DEFAULT_CASES,
  DEFAULT_ENCODED,
  HarnessError,
  fail,
  readJsonFile,
  sha256,
  caseDir,
  resolveIndexers,
  prepareEnv,
  cleanupTemp,
  loadApp,
  startServer,
  stopServer,
  postConfig,
  getStream,
  waitForFile,
  captureFrozenStderr,
} from './stream-frozen-runtime.mjs';
import { compareResponses } from './stream-frozen-compare.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REQUIRED_INPUTS = ['meta', 'index', 'collect', 'fallback', 'config'];

function usage() {
  console.log(`uso:
  replay --case <id> [--dir <raiz>] [--encoded e30] [--timeout-ms 90000]
  record --case <id> --type movie|series --id <streamId> [--dir <raiz>] [--encoded e30]
         [--timeout-ms 90000] [--indexers csv]
  batch  --mode replay|record [--cases <arquivo.json>] [--dir <raiz>] [--encoded e30]
         [--timeout-ms 90000] [--indexers csv]
  manifest <caso> | compare <caso> | verify`);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`argumento posicional inesperado: ${arg}`);
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} exige valor`);
    flags[name] = value;
    i += 1;
  }
  return flags;
}

function rootOf(args) {
  return path.resolve(REPO, args.dir || DEFAULT_ROOT);
}

function ensureCase(root, id) {
  const dir = caseDir(root, id);
  if (!existsSync(dir)) fail(`caso ausente: ${dir}`);
  return dir;
}

function readRequest(dir) {
  const file = path.join(dir, 'request.json');
  if (!existsSync(file)) fail(`request.json ausente no caso: ${file}`);
  const request = readJsonFile(file, file);
  if (!request.type || !request.stream_id) fail(`request.json sem type/stream_id: ${file}`);
  return request;
}

function reportFrozen(capture, verbose) {
  // Só os logs do módulo; as mensagens do próprio harness também usam `[frozen]`
  // e não devem entrar na lista.
  const lines = [...new Set(capture.lines.filter((line) => line.includes('collect ausente')))];
  if (lines.length === 0) return;
  if (verbose) {
    console.error('[frozen] log(s) de captura:');
    for (const line of lines) console.error(`  ${line}`);
    return;
  }
  console.log(`[frozen] aviso: ${lines.length} log(s) [frozen] — captura incompleta (veja as linhas acima)`);
}

async function runReplay(args) {
  if (!args.case) fail('replay exige --case');
  const root = rootOf(args);
  const id = args.case;
  const dir = ensureCase(root, id);
  const request = readRequest(dir);
  const encoded = args.encoded || DEFAULT_ENCODED;
  if (request.encoded_sha256 && sha256(encoded) !== request.encoded_sha256) {
    fail(`--encoded não confere com request.json (esperado sha256 ${request.encoded_sha256})`);
  }
  const expected = path.join(dir, 'expected', 'node-response.json');
  if (!existsSync(expected)) fail(`referência ausente: ${expected} (grave o caso com record)`);
  const out = path.join(dir, 'expected', 'node-replay.json');
  rmSync(out, { force: true });
  const indexers = resolveIndexers({ indexers: args.indexers, dir, root });
  const { tempDir } = prepareEnv({ mode: 'replay', dir, id, indexers });
  const timeoutMs = Number(args['timeout-ms'] || 90000);
  const capture = captureFrozenStderr();
  let server;
  try {
    const app = await loadApp();
    const started = await startServer(app);
    server = started.server;
    await getStream({ base: started.base, encoded, type: request.type, id: request.stream_id, timeoutMs });
    await waitForFile(out, timeoutMs);
    const result = compareResponses(readJsonFile(expected), readJsonFile(out));
    if (result.ok) {
      console.log(`[frozen] replay ${id}: PASS — ${result.got.streams.length} stream(s), cacheMaxAge=${result.got.cacheMaxAge}`);
      reportFrozen(capture, false);
      return 0;
    }
    console.error(`[frozen] replay ${id}: FAIL`);
    for (const line of result.lines) console.error(`  ${line}`);
    reportFrozen(capture, true);
    return 1;
  } finally {
    capture.restore();
    await stopServer(server);
    cleanupTemp(tempDir);
  }
}

function verifyRecord({ dir, configFile, responseFile, manifestFile, indexers }) {
  const required = [
    ...REQUIRED_INPUTS.map((name) => path.join('inputs', `${name}.json`)),
    path.join('expected', 'node-response.json'),
    'manifest.json',
  ];
  const missing = required.filter((rel) => !existsSync(path.join(dir, rel)));
  if (missing.length > 0) fail(`captura incompleta; faltam: ${missing.join(', ')}`);

  const collect = readJsonFile(path.join(dir, 'inputs', 'collect.json'));
  if (!Array.isArray(collect) || collect.length === 0) fail('collect.json sem entradas (coleta não rodou)');
  const partials = collect.filter((entry) => entry?.response?.partial === true);
  if (partials.length > 0) {
    const detail = partials.map((entry) => `imdb=${entry?.key?.imdb} scope=${entry?.key?.scope} live=${JSON.stringify(entry?.response?.live)}`).join('; ');
    fail(`captura parcial (partial=true em ${partials.length} entrada(s)): ${detail}`);
  }
  const liveValues = [...new Set(collect.map((entry) => String(entry?.response?.live?.all ?? '<null>')))];
  const items = collect.reduce((sum, entry) => sum + (Array.isArray(entry?.response?.items) ? entry.response.items.length : 0), 0);

  const debridFile = path.join(dir, 'inputs', 'debrid.json');
  const applyFile = path.join(dir, 'inputs', 'apply-debrid.json');
  const debrid = existsSync(debridFile) ? readJsonFile(debridFile) : { calls: [] };
  const apply = existsSync(applyFile) ? readJsonFile(applyFile) : [];
  const calls = Array.isArray(debrid?.calls) ? debrid.calls.length : 0;
  const applies = Array.isArray(apply) ? apply.length : 0;
  if (calls === 0) console.error('[frozen] aviso: debrid.json sem calls (nenhuma checagem registrada)');
  if (applies === 0) console.error('[frozen] aviso: apply-debrid.json sem entradas');

  const manifest = readJsonFile(manifestFile);
  const configHash = sha256(readFileSync(configFile));
  if (!manifest?.files?.['inputs/config.json']) {
    fail('manifest sem inputs/config.json (config.json foi apagado pelo reset?)');
  }
  if (manifest.files['inputs/config.json'] !== configHash) {
    fail('sha256 de inputs/config.json não bate com o manifest');
  }

  const response = readJsonFile(responseFile);
  const streams = Array.isArray(response?.streams) ? response.streams.length : 0;
  console.log(
    `[frozen] record OK — streams=${streams} collect=${collect.length} entrada(s)/${items} item(s)`
    + ` debrid=${calls} call(s) apply=${applies} entrada(s) live.all=${liveValues.join(',')}`
    + ` indexers=${indexers?.length ?? 0}`,
  );
  return 0;
}

async function runRecord(args) {
  const id = args.case;
  const type = args.type;
  const streamId = args.id;
  if (!id || !type || !streamId) fail('record exige --case, --type e --id');
  if (type !== 'movie' && type !== 'series') fail('--type deve ser movie|series');
  const root = rootOf(args);
  const dir = caseDir(root, id);
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'expected'), { recursive: true });
  const encoded = args.encoded || DEFAULT_ENCODED;
  const indexers = resolveIndexers({ indexers: args.indexers, dir, root });
  if (!indexers) fail('sem lista de indexers: passe --indexers ou capture o piloto primeiro');
  const responseFile = path.join(dir, 'expected', 'node-response.json');
  const manifestFile = path.join(dir, 'manifest.json');
  const configFile = path.join(dir, 'inputs', 'config.json');
  rmSync(responseFile, { force: true });
  rmSync(manifestFile, { force: true });
  const { tempDir, token } = prepareEnv({ mode: 'record', dir, id, indexers });
  const timeoutMs = Number(args['timeout-ms'] || 90000);
  const capture = captureFrozenStderr();
  let server;
  try {
    const app = await loadApp();
    const started = await startServer(app);
    server = started.server;
    const config = await postConfig({ base: started.base, token, encoded, timeoutMs });
    const indexerCount = config.parsed?.options?.jackettIndexers?.length ?? 0;
    if (indexerCount === 0) fail('config sem jackettIndexers: defina JACKETT_INDEXERS (--indexers)');
    writeFileSync(configFile, config.text.endsWith('\n') ? config.text : `${config.text}\n`);
    console.log(
      `[frozen] record ${id}: config com ${indexerCount} indexer(s),`
      + ` hasDebridKey=${Boolean(config.parsed?.options?.hasDebridKey)}`,
    );
    await getStream({ base: started.base, encoded, type, id: streamId, timeoutMs });
    await waitForFile(responseFile, timeoutMs);
    await waitForFile(manifestFile, timeoutMs);
    const code = verifyRecord({ dir, configFile, responseFile, manifestFile, indexers });
    reportFrozen(capture, false);
    return code;
  } finally {
    capture.restore();
    await stopServer(server);
    cleanupTemp(tempDir);
  }
}

async function runBatch(args) {
  const mode = args.mode;
  if (mode !== 'replay' && mode !== 'record') fail('batch exige --mode replay|record');
  const casesPath = path.resolve(REPO, args.cases || DEFAULT_CASES);
  if (!existsSync(casesPath)) fail(`arquivo de casos ausente: ${casesPath}`);
  const parsed = readJsonFile(casesPath, casesPath);
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) fail('arquivo de casos sem lista');
  const root = rootOf(args);
  const encoded = args.encoded || DEFAULT_ENCODED;
  const results = [];
  for (let i = 0; i < cases.length; i += 1) {
    const item = cases[i];
    const streamId = item?.streamId ?? item?.stream_id;
    if (!item?.id || !item?.type || !streamId) fail(`caso #${i} sem id/type/streamId`);
    const argv = [SCRIPT, mode, '--case', String(item.id), '--dir', root, '--encoded', encoded];
    if (mode === 'record') argv.push('--type', String(item.type), '--id', String(streamId));
    if (args['timeout-ms']) argv.push('--timeout-ms', args['timeout-ms']);
    if (args.indexers) argv.push('--indexers', args.indexers);
    const startedAt = Date.now();
    const proc = spawnSync(process.execPath, argv, { cwd: REPO, stdio: 'inherit' });
    const ok = proc.status === 0;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    results.push({ id: item.id, ok, seconds, status: proc.status });
    console.log(`[batch] (${i + 1}/${cases.length}) ${ok ? 'PASS' : 'FAIL'} ${item.id} (${seconds}s)`);
  }
  const passed = results.filter((item) => item.ok).length;
  console.log(`[batch] ${mode}: ${passed}/${results.length} PASS`);
  for (const item of results) {
    console.log(`  ${item.ok ? 'PASS' : 'FAIL'} ${item.id} (${item.seconds}s)`);
  }
  return passed === results.length ? 0 : 1;
}

function runManifest(id, args = {}) {
  if (!id) fail('manifest exige um caso');
  const root = rootOf(args);
  const dir = ensureCase(root, id);
  for (const transient of ['expected/node-replay.json', 'manifest.json']) {
    rmSync(path.join(dir, transient), { force: true });
  }
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        const text = readFileSync(full, 'utf8');
        if (/(jackett_apikey|apikey=|passkey|authorization:\s*bearer)/i.test(text)) {
          fail(`credencial em claro em ${rel}; remova antes de commitar`);
        }
        files[rel] = sha256(readFileSync(full));
      }
    }
  };
  walk(dir);
  const request = readRequest(dir);
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    format: 'adom-stream-frozen/1',
    case: request.case,
    mode: 'record',
    masked: true,
    files,
    notCaptured: [
      'índice e banco vivo: desligados neste piloto (RELEASE_INDEX=false, MAGNET_BANK=false)',
      'relógio, ordem da lista e ordem de chaves: fora do diff (§9.3)',
      'HMAC: sig mascarado; replay Rust usa segredo vazio',
      'segmento de config: não versionado; replay usa e30 ou --encoded do operador',
    ],
  }, null, 1)}\n`);
  console.log(`[frozen] ${Object.keys(files).length} arquivo(s) em ${dir}`);
  return 0;
}

function runCompare(id, args = {}) {
  if (!id) fail('compare exige um caso');
  const dir = ensureCase(rootOf(args), id);
  const want = readJsonFile(path.join(dir, 'expected', 'node-response.json'));
  const got = readJsonFile(path.join(dir, 'expected', 'node-replay.json'));
  const result = compareResponses(want, got);
  if (result.ok) {
    console.log(`[frozen] replay Node idêntico (${result.got.streams.length} streams)`);
    return 0;
  }
  console.error('[frozen] replay Node divergente:');
  for (const line of result.lines) console.error(`  ${line}`);
  return 1;
}

function runVerify() {
  const proc = spawnSync(
    'cargo',
    ['test', '-p', 'adom-search', '--test', 'stream_frozen_parity', '--', '--nocapture'],
    { cwd: path.join(REPO, 'rust'), stdio: 'inherit' },
  );
  return proc.status ?? 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    usage();
    return command ? 0 : 2;
  }
  if (command === 'replay') return runReplay(parseFlags(rest));
  if (command === 'record') return runRecord(parseFlags(rest));
  if (command === 'batch') return runBatch(parseFlags(rest));
  const flags = rest.length > 0 && !rest[0].startsWith('--') ? { case: rest[0] } : parseFlags(rest);
  if (command === 'manifest') return runManifest(flags.case, flags);
  if (command === 'compare') return runCompare(flags.case, flags);
  if (command === 'verify') return runVerify();
  usage();
  return 2;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof HarnessError) console.error(`[frozen] ${err.message}`);
  else console.error(`[frozen] ${err?.stack || err}`);
  process.exitCode = 1;
}
