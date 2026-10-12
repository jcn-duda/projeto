#!/usr/bin/env node
/**
 * Golden do ledger observacional `src/utils/stream-trace.ts` (P5 Fase 0).
 *
 * Geração (`node scripts/golden/dump-stream-trace.mjs`): compila a fonte
 * CONGELADA (tsc do repo) para um STAGING em TEMP — nunca o `dist/` do
 * checkout —, encena os cenários contra as funções REAIS e grava
 * `rust/golden/stream-trace.jsonl` + manifest. Determinístico: relógio fake,
 * sem timestamp no artefato. `--check` é ESTRITAMENTE leitura: recompila,
 * re-executa e compara byte a byte o golden commitado, além de hash da
 * fonte/corpus, registry e contagem.
 *
 * ISOLAMENTO: compila SÓ o grafo de stream-trace (config + 15 seções + dotenv
 * = 17 módulos); grafo fechado estaticamente (nada de
 * node:http/net/tls/dns/child_process/worker; bare só `dotenv`) e cada child
 * com env mínima (allowlist de host, sem NODE_OPTIONS), CWD no staging,
 * DOTENV_CONFIG_PATH vazio, CACHE_PERSIST=false, RUST_CORE=off e STREAM_TRACE
 * exato por variante (armado ANTES do import). Nunca importa `addon.js`.
 *
 * PRIVACIDADE: nenhum fixture serializado carrega credencial; só hash dummy de
 * 40 zeros e magnet sintético, e o golden prova a redação `<hash>`/`<magnet>` e
 * o corte UTF-16 (surrogate órfão) nas bordas 59/159. Sem porte Rust e sem hook
 * NAPI. Flags: --corpus/--out redirecionam fixtures; --keep-tmp preserva o
 * staging. Os paths DENTRO do manifest são sempre os canônicos do repo.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_HASH_LINE_ENDINGS, shaSourceLf } from './source-fingerprint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const NAME = 'streamTraceStateful';
const SOURCE = 'src/utils/stream-trace.ts';
const COMPILED = 'src/utils/stream-trace.js'; // caminho DENTRO do staging
const CORPUS = 'scripts/golden/corpus-stream-trace.json';
const OUT_JSONL = 'rust/golden/stream-trace.jsonl';
const OUT_MANIFEST = 'rust/golden/stream-trace.manifest.json';
const ORACLE = 'scripts/golden/stream-trace-oracle.mjs';
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
// Métodos cobertos — um id por função observável do ledger.
const REGISTRY = [
  'stream-trace/create', 'stream-trace/clone', 'stream-trace/stage', 'stream-trace/setStage',
  'stream-trace/drop', 'stream-trace/finalize', 'stream-trace/setChupim',
  'stream-trace/sanitizeLabel', 'stream-trace/serialize',
];
// Guarda estática do grafo: rede/exec proibidos; bare só dotenv.
const BANNED_SPECIFIERS = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:child_process',
  'node:dgram', 'node:cluster', 'node:worker_threads', 'node:inspector', 'node:repl',
];
const ALLOWED_BARE = new Set(['dotenv']);
// Vars do host que atravessam (NODE_OPTIONS fica de fora); credenciais nunca.
const HOST_ALLOW = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS'];
// Kill-switch: as três variantes observáveis ('0' e 'false' desligam no config).
const ENV_VARIANTS = ['true', 'false', '0'];
const DISABLED = new Set(['false', '0']);
// `repeat` é mecânico e do driver; só nos cortes contáveis, com teto duro.
const REPEATABLE = new Set(['stage', 'setStage', 'drop']);
const MAX_REPEAT = 1000;
// Se qualquer uma destas existir no shell do operador, o child recusa.
const FORBIDDEN_ENV = [
  'RESOLVE_SECRET', 'DEBRID_API_KEY', 'DEBRID_SERVICE', 'DEBRID_ALLOW_ENV_KEY', 'TMDB_API_KEY',
  'PROWLARR_API_KEY', 'JACKETT_API_KEY', 'TORBOX_API_KEY', 'PREMIUMIZE_API_KEY',
  'REAL_DEBRID_API_KEY', 'ALLDEBRID_API_KEY', 'DEBRIDLINK_API_KEY', 'STREMTHRU_URL',
];
class GoldenError extends Error {}
// fail LANÇA (não exit): o finally do staging roda e nada fica órfão no TEMP.
const fail = (msg) => { throw new GoldenError(String(msg)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

function parseArgs(argv) {
  const args = { check: false, force: false, keepTmp: false, corpus: null, out: null };
  const need = (flag, val) => (val === undefined || val.startsWith('-') ? fail(`flag ${flag} exige um valor`) : val);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--force') args.force = true;
    else if (a === '--keep-tmp') args.keepTmp = true;
    else if (a === '--corpus') args.corpus = need(a, argv[++i]);
    else if (a === '--out') args.out = need(a, argv[++i]);
    else fail(`flag desconhecida: ${a}`);
  }
  return args;
}
/** Absoluto fica como está; relativo é ancorado no repo. */
function resolveCliPath(p, def) {
  return !p ? path.join(REPO, def) : path.isAbsolute(p) ? p : path.join(REPO, p);
}

/** Compila SÓ o grafo da fonte congelada para o staging (nunca o dist do repo). */
function compileStaging(stagingDir) {
  const entry = path.join(REPO, SOURCE);
  if (!fs.existsSync(entry)) fail(`fonte ausente: ${SOURCE}`);
  if (!fs.existsSync(TSC)) fail('node_modules/typescript ausente (npm install)');
  const cfg = {
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: stagingDir,
      rootDir: REPO, strictNullChecks: true, noImplicitAny: true, noEmitOnError: true,
      useUnknownInCatchVariables: false, skipLibCheck: true, esModuleInterop: true,
      declaration: false, sourceMap: false, types: ['node'],
      typeRoots: [path.join(REPO, 'node_modules', '@types')],
    },
    files: [entry],
  };
  const cfgPath = path.join(stagingDir, 'tsconfig.golden.json');
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  try {
    execFileSync(process.execPath, [TSC, '-p', cfgPath], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
    });
  } catch (e) {
    fail(`tsc falhou: ${`${e.stdout || ''}${e.stderr || ''}`.trim() || e.message}`);
  }
  if (!fs.existsSync(path.join(stagingDir, COMPILED))) fail(`tsc não emitiu ${COMPILED}`);
  fs.writeFileSync(path.join(stagingDir, 'package.json'), '{"type":"module"}\n');
  const dotenvSrc = path.join(REPO, 'node_modules', 'dotenv');
  if (!fs.existsSync(dotenvSrc)) fail('node_modules/dotenv ausente (o grafo importa dotenv/config)');
  fs.cpSync(dotenvSrc, path.join(stagingDir, 'node_modules', 'dotenv'), { recursive: true });
}

const RE_IMPORT_FROM = /\bimport\s+(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const RE_EXPORT_FROM = /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
function importSpecifiers(src) {
  const out = [];
  for (const re of [RE_IMPORT_FROM, RE_EXPORT_FROM]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(src));) out.push(m[1]);
  }
  return out;
}
/** Fecha o grafo do oráculo (em staging) e recusa rede/exec/bare inesperado. */
function collectGraph(entryAbs, stagingDir) {
  const seen = new Set();
  const bare = new Set();
  const stack = [entryAbs];
  while (stack.length) {
    const abs = stack.pop();
    if (seen.has(abs)) continue;
    seen.add(abs);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      fail(`grafo: arquivo ausente ${toPosix(path.relative(stagingDir, abs))}`);
    }
    for (const bad of BANNED_SPECIFIERS) {
      if (src.includes(`'${bad}'`) || src.includes(`"${bad}"`) || src.includes(`\`${bad}\``)) {
        fail(`grafo: referência proibida '${bad}' em ${toPosix(path.relative(stagingDir, abs))}`);
      }
    }
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(abs), spec));
      else bare.add(spec);
    }
  }
  for (const b of bare) {
    if (!ALLOWED_BARE.has(b.split('/')[0])) fail(`grafo: dependência bare não permitida '${b}'`);
  }
  return seen.size;
}

function oracleEnv(variant, dotenvPath) {
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DOTENV_CONFIG_PATH = dotenvPath; // .env real nunca é lido
  env.CACHE_PERSIST = 'false';
  env.RUST_CORE = 'off';
  env.ADDON_LOG_LEVEL = 'silent';
  env.STREAM_TRACE = variant; // armado ANTES do import do config
  return env; // NODE_OPTIONS/DOTENV_*/credenciais: nunca herdados
}

/** Expansão MECÂNICA de `repeat` (só driver); não replica nenhum predicado. */
function expandScenario(s) {
  const ops = [];
  for (const op of s.ops) {
    if (op.repeat === undefined) { ops.push(op); continue; }
    if (!REPEATABLE.has(op.op)) fail(`repeat só é permitido em stage/setStage/drop (veio ${op.op})`);
    if (!Number.isInteger(op.repeat) || op.repeat < 1 || op.repeat > MAX_REPEAT) {
      fail(`repeat inválido: ${JSON.stringify(op.repeat)} (1..${MAX_REPEAT})`);
    }
    const base = { ...op };
    delete base.repeat;
    for (let i = 0; i < op.repeat; i++) ops.push(base);
  }
  return { ...s, ops };
}

/** Roda o oráculo isolado para UMA variante de STREAM_TRACE; devolve id -> out. */
function runVariant(variant, cases, stagingDir, dotenvPath) {
  const oraclePath = path.join(stagingDir, 'stream-trace-oracle.mjs');
  fs.copyFileSync(path.join(REPO, ORACLE), oraclePath);
  const jobPath = path.join(stagingDir, `job-${variant}.json`);
  fs.writeFileSync(jobPath, JSON.stringify({
    artifactPath: path.join(stagingDir, COMPILED),
    configPath: path.join(stagingDir, 'src', 'config.js'),
    dotenvPath,
    cwd: stagingDir,
    streamTrace: variant,
    expectedEnabled: !DISABLED.has(variant),
    forbiddenEnv: FORBIDDEN_ENV,
    cases: cases.map((c) => ({ id: c.id, scenario: expandScenario(c) })),
  }));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [oraclePath, jobPath], {
      cwd: stagingDir, env: oracleEnv(variant, dotenvPath), encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
    });
  } catch (e) {
    fail(`oráculo falhou (STREAM_TRACE=${variant}): ${`${e.stdout || ''}${e.stderr || ''}`.trim() || e.message}`);
  }
  const lastLine = stdout.trimEnd().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (e) {
    fail(`saída do oráculo não é JSON: ${e.message}`);
  }
  if (!parsed?.ok || !Array.isArray(parsed.cases)) fail('oráculo não reportou ok');
  return new Map(parsed.cases.map((r) => [r.id, r.out]));
}

/** Corpus: id/env/clock/ops/capture validados; nada de rede nem coerção solta. */
function loadCorpus(corpusPath) {
  let raw;
  try {
    raw = fs.readFileSync(corpusPath);
  } catch {
    fail(`corpus ausente: ${corpusPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    fail(`corpus inválido (JSON): ${e.message}`);
  }
  const cases = parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) fail('corpus vazio ou sem "cases"');
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
    if (!Array.isArray(c?.ops) || c.ops.length === 0) fail(`caso ${c.id}: sem "ops"`);
    if (typeof c?.capture !== 'string' || !c.capture) fail(`caso ${c.id}: sem "capture"`);
    const env = c.env ?? 'true';
    if (!ENV_VARIANTS.includes(env)) fail(`caso ${c.id}: env inválido "${env}"`);
  }
  return { bytes: raw, sha: sha256(raw), cases };
}

/** Normaliza o cenário como ele entra no JSONL (defaults explícitos p/ o Rust). */
function scenarioOf(c) {
  return { env: c.env ?? 'true', clock: c.clock ?? { base: 1000, step: 1 }, ops: c.ops, capture: c.capture };
}

/** Roda todas as variantes e devolve o JSONL na ORDEM do corpus. */
function computeJsonl(corpus, stagingDir, dotenvPath) {
  const variants = [...new Set(corpus.cases.map((c) => c.env ?? 'true'))].sort();
  const merged = new Map();
  for (const variant of variants) {
    const subset = corpus.cases.filter((c) => (c.env ?? 'true') === variant);
    for (const [id, out] of runVariant(variant, subset, stagingDir, dotenvPath)) {
      if (merged.has(id)) fail(`id repetido entre variantes: ${id}`);
      merged.set(id, out);
    }
  }
  const lines = corpus.cases.map((c) => {
    const expected = merged.get(c.id);
    if (typeof expected !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
    return JSON.stringify({ id: c.id, input: scenarioOf(c), expected });
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function gitRevision() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null; }
  catch { return null; } // provenance: ausência de git não pode bloquear
}

function buildManifest(corpus, jsonl, stagingDir) {
  return {
    format: MANIFEST_FORMAT,
    // Política do hash da fonte: cobre o texto com CRLF → LF (portátil).
    sourceHashLineEndings: SOURCE_HASH_LINE_ENDINGS,
    registry: REGISTRY,
    function: {
      name: NAME,
      sourcePath: toPosix(SOURCE),
      sourceSha256: shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE))),
      // Artefato é o emit do tsc da fonte congelada, no staging de TEMP: vale
      // como provenance do grafo, nunca como caminho do checkout.
      artifactPath: 'staging:src/utils/stream-trace.js',
      artifactSha256: sha256(fs.readFileSync(path.join(stagingDir, COMPILED))),
    },
    isolation: {
      dotenv: 'empty (DOTENV_CONFIG_PATH)',
      cachePersist: 'false',
      rustCore: 'off',
      cwd: 'temp staging',
      hostEnvAllow: HOST_ALLOW,
      envVariants: ENV_VARIANTS,
      graphBareAllow: [...ALLOWED_BARE],
      network: 'fetch armado para explodir no child',
    },
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    notes:
      'Relógio fake (Date.now) por caso; kill-switch observável em create/drop (ignoram) vs '
      + 'setChupim/serialize (gated). Redação <hash>/<magnet> e corte UTF-16 nas bordas 59/159. '
      + 'repeat é expandido só pelo driver.',
    node: { major: Number(process.versions.node.split('.')[0]) },
    git: { revision: gitRevision() },
  };
}

function readManifestIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function generate(corpus, jsonl, outDir, force, stagingDir) {
  const outJsonl = path.join(outDir, path.basename(OUT_JSONL));
  const outManifest = path.join(outDir, path.basename(OUT_MANIFEST));
  const existing = readManifestIfExists(outManifest);
  const sourceSha = shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE)));
  if (existing && !force && existing.function?.sourceSha256 !== sourceSha) {
    fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outJsonl, jsonl);
  const manifest = buildManifest(corpus, jsonl, stagingDir);
  fs.writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${toPosix(path.relative(REPO, outJsonl))} (${corpus.cases.length} linhas)`);
  console.log(`[golden] manifest: ${toPosix(path.relative(REPO, outManifest))} output=${manifest.output.sha256.slice(0, 12)}…`);
}

/** Check: só leitura. Qualquer divergência encerra com exit 1 e motivo exato. */
function check(corpus, jsonl, outDir) {
  const outJsonl = path.join(outDir, path.basename(OUT_JSONL));
  const manifest = readManifestIfExists(path.join(outDir, path.basename(OUT_MANIFEST)));
  if (!manifest) fail(`manifest ausente ou ilegível: ${path.join(outDir, path.basename(OUT_MANIFEST))}`);
  if (manifest.format !== MANIFEST_FORMAT) fail(`formato de manifest desconhecido: ${manifest.format}`);
  if (!Array.isArray(manifest.registry) || manifest.registry.join(',') !== REGISTRY.join(',')) {
    fail(`registry do manifest diverge do esperado: ${JSON.stringify(manifest.registry)}`);
  }
  let committed;
  try {
    committed = fs.readFileSync(outJsonl);
  } catch {
    fail(`golden ausente: ${outJsonl}`);
  }
  if (committed.length === 0 || !committed.toString('utf8').trim()) fail('golden vazio: nunca aceitar saída zero-linhas');
  if (manifest.output?.sha256 !== sha256(committed)) fail('golden divergiu do manifest (arquivo alterado fora do gerador)');
  if (manifest.corpus?.sha256 !== corpus.sha) fail('corpus mudou desde a geração (hash diverge do manifest)');
  if (manifest.function?.sourceSha256 !== shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE)))) {
    fail('fonte mudou desde a geração; regenere o golden');
  }
  if (!committed.equals(jsonl)) fail('comportamento do dist vivo divergiu do golden (gene 2 não bateu byte a byte)');
  const lines = committed.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${manifest.output?.lines}`);
  }
  // node.major, artifactSha256 e git.revision são provenance: NÃO comparados.
  console.log(`[golden] OK: ${toPosix(path.relative(REPO, outJsonl))} (${lines.length} casos batem com o dist vivo)`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(TEMP_BASE, 'stream-trace-'));
  try {
    compileStaging(stagingDir);
    const nodes = collectGraph(path.join(stagingDir, COMPILED), stagingDir);
    if (nodes < 2) fail(`grafo suspeito: só ${nodes} arquivo(s)`);
    const dotenvPath = path.join(stagingDir, 'empty-dotenv');
    fs.writeFileSync(dotenvPath, '');
    const jsonl = computeJsonl(corpus, stagingDir, dotenvPath);
    const outDir = resolveCliPath(args.out, path.dirname(OUT_JSONL));
    if (args.check) check(corpus, jsonl, outDir);
    else generate(corpus, jsonl, outDir, args.force, stagingDir);
  } finally {
    if (!args.keepTmp) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
try {
  main();
} catch (e) {
  console.error(`[golden] FALHA: ${e instanceof GoldenError ? e.message : e?.stack || e?.message || String(e)}`);
  process.exit(1);
}
