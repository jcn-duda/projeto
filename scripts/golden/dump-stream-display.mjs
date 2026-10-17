#!/usr/bin/env node
/**
 * Golden da coluna estreita do stream (`src/utils/stream-display.ts`).
 *
 * Geração (`node scripts/golden/dump-stream-display.mjs`): roda o corpus contra
 * o oráculo do `dist` REAL e grava `rust/golden/stream-display.jsonl` + manifest
 * (determinístico, sem timestamp). `--check`: só leitura; falha se
 * faltar/vazio/tamperado/divergir do dist vivo, sem nunca escrever.
 * ISOLAMENTO: importar `stream-display.js` arrasta config -> runtime ->
 * autofetch-live -> cache; cache.ts abre/le data/cache.db no LOAD. Por isso o
 * oráculo roda em child descartável contra um STAGING só com o grafo compilado
 * (dist + package.json + node_modules/dotenv), sem .env/data/volume, CWD em
 * TEMP, DOTENV_CONFIG_PATH vazio, CACHE_PERSIST=false, RUST_CORE=off e env
 * mínima (9 campos do host; sem NODE_OPTIONS, sem credencial REAL — só os fake
 * com prefixo). O grafo é inspecionado estaticamente: nada de
 * node:http/net/child_process e nenhum bare fora de dotenv.
 *
 * GRUPOS DE CONFIG: `streamNameStyle`/`streamNameShowSource` são lidos no IMPORT
 * (process.env congelado), então cada combinação de config vira um CHILD próprio
 * — `STREAM_NAME_STYLE`/`STREAM_NAME_SHOW_SOURCE` montam o env do grupo. O
 * grupo `default` NÃO define as variáveis: prova que o default (compact/true)
 * vem do código, não do .env (que está desligado).
 *
 * UTF-16: `compactTracker` fatia em unidades UTF-16 e pode partir um par
 * surrogate astral ao meio. Cada registro traz `expectedJson` =
 * `JSON.stringify(resultado)` — SEMPRE JSON válido — enquanto `expected` (string
 * crua) é OMITIDO quando o resultado tem surrogate órfão, para o leitor Rust
 * (serde_json estrito) nunca tropeçar. Os ids dos vetores órfãos ficam em
 * `manifest.traps`.
 *
 * Flags de teste: --corpus/--out redirecionam (negativos); --keep-tmp preserva
 * o staging. Os paths DENTRO do manifest são sempre os canônicos.
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
const ORACLE = path.join(REPO, 'scripts', 'golden', 'stream-display-oracle.mjs');
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
const SOURCE = 'src/utils/stream-display.ts';
const ARTIFACT = 'dist/src/utils/stream-display.js';
const RUNTIME_ARTIFACT = 'dist/src/runtime.js';
const CORPUS = 'scripts/golden/corpus-stream-display.json';
const OUT_JSONL = 'rust/golden/stream-display.jsonl';
const OUT_MANIFEST = 'rust/golden/stream-display.manifest.json';
const REGISTRY = ['stream-display/streamDisplayName'];
const FAKE_PREFIX = 'fakegolden-';
const FAKE_ENV = {
  RESOLVE_SECRET: `${FAKE_PREFIX}resolve-secret`,
  DEBRID_API_KEY: `${FAKE_PREFIX}debrid-api-key`,
};
const MUST_BE_ABSENT = ['DEBRID_SERVICE', 'DEBRID_OPERATOR_ENV_ACCOUNT', 'JACKETT_TEST_TOKEN',
  'PUBLIC_URL', 'JACKETT_URL', 'TMDB_API_KEY', 'DEBRID_RD_ORACLE_STREMTHRU_TOKEN'];
const BANNED_SPECIFIERS = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns',
  'node:child_process', 'node:dgram', 'node:cluster', 'node:worker_threads', 'node:inspector', 'node:repl'];
const ALLOWED_BARE = new Set(['dotenv']);
const HOST_ALLOW = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS'];
class GoldenError extends Error {}
const fail = (msg) => { throw new GoldenError(String(msg)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');
const configKey = (config) => `${config.style}|${config.showSource}`;
function assertSha(label, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`hash inválido em ${label}: ${value}`);
}
function parseArgs(argv) {
  const args = { check: false, force: false, keepTmp: false, corpus: null, out: null };
  const need = (flag, val) => {
    if (val === undefined || val.startsWith('-')) fail(`flag ${flag} exige um valor`);
    return val;
  };
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
const RE_IMPORT_FROM = /\bimport\s+(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const RE_EXPORT_FROM = /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
function importSpecifiers(src) {
  const out = [];
  for (const re of [RE_IMPORT_FROM, RE_EXPORT_FROM]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}
/** Fecha o grafo do oráculo e recusa rede/exec/bare inesperado. */
function collectGraph(entryAbs) {
  const files = [];
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
      fail(`grafo: arquivo ausente ${toPosix(path.relative(REPO, abs))}`);
    }
    for (const bad of BANNED_SPECIFIERS) {
      if (src.includes(`'${bad}'`) || src.includes(`"${bad}"`) || src.includes(`\`${bad}\``)) {
        fail(`grafo: referência proibida '${bad}' em ${toPosix(path.relative(REPO, abs))}`);
      }
    }
    if (path.basename(abs) === 'addon.js') fail('grafo: addon.js não pode entrar (nada de subir o servidor)');
    files.push(abs);
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(abs), spec));
      else bare.add(spec);
    }
  }
  for (const b of bare) {
    if (!ALLOWED_BARE.has(b.split('/')[0])) fail(`grafo: dependência bare não permitida '${b}'`);
  }
  return { files };
}
/** Copia SÓ o grafo compilado + package.json + dotenv para o staging em TEMP. */
function stageOracle(graphFiles, stagingDir) {
  for (const abs of graphFiles) {
    const dest = path.join(stagingDir, path.relative(REPO, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(stagingDir, 'package.json'));
  const dotenvSrc = path.join(REPO, 'node_modules', 'dotenv');
  if (!fs.existsSync(dotenvSrc)) fail('node_modules/dotenv ausente (o grafo importa dotenv/config)');
  fs.cpSync(dotenvSrc, path.join(stagingDir, 'node_modules', 'dotenv'), { recursive: true });
  // O grafo carrega o núcleo Rust em runtime (áudio/título agora decidem no
  // núcleo; o TS daqui é ponte): o binário entra no staging na MESMA posição
  // relativa do dist — o default de native-core.js resolve ao lado de si mesmo.
  // O caminho do binário não entra na saída medida.
  const coreSrc = path.join(REPO, 'dist', 'rust', 'adom_napi.node');
  if (fs.existsSync(coreSrc)) {
    fs.mkdirSync(path.join(stagingDir, 'dist', 'rust'), { recursive: true });
    fs.copyFileSync(coreSrc, path.join(stagingDir, 'dist', 'rust', 'adom_napi.node'));
  }
}
/** Env mínima: 9 campos do host; nunca NODE_OPTIONS nem credencial real. */
function cleanEnv(config, dotenvPath) {
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DOTENV_CONFIG_PATH = dotenvPath;
  env.CACHE_PERSIST = 'false';
  env.RUST_CORE = 'off';
  env.ADDON_LOG_LEVEL = 'silent';
  Object.assign(env, FAKE_ENV);
  if (config.style === 'full') env.STREAM_NAME_STYLE = 'full';
  else if (config.style === 'compact') env.STREAM_NAME_STYLE = 'compact';
  if (config.showSource === 'false') env.STREAM_NAME_SHOW_SOURCE = 'false';
  else if (config.showSource === 'true') env.STREAM_NAME_SHOW_SOURCE = 'true';
  return env;
}
/** Um child fresco por grupo de config (process.env congelado no import). */
function runGroup(config, groupCases, stagingDir, dotenvPath) {
  const key = configKey(config);
  const job = {
    cwd: stagingDir, dotenvPath,
    artifactPath: path.join(stagingDir, ARTIFACT),
    runtimePath: path.join(stagingDir, RUNTIME_ARTIFACT),
    config, fakeEnv: FAKE_ENV, mustBeAbsent: MUST_BE_ABSENT,
    cases: groupCases.map((c) => ({ id: c.id, input: c.input })),
  };
  const jobPath = path.join(stagingDir, `job-${config.style}-${config.showSource}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [ORACLE, jobPath], {
      cwd: stagingDir, env: cleanEnv(config, dotenvPath),
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
    });
  } catch (e) {
    fail(`oráculo falhou (grupo ${key}): ${(e.stderr || e.message || '').toString().trim()}`);
  }
  const lastLine = stdout.trimEnd().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (e) {
    fail(`saída do oráculo não é JSON (grupo ${key}): ${e.message}`);
  }
  if (!parsed?.ok) fail(`oráculo não reportou ok (grupo ${key})`);
  return parsed.cases;
}
function groupCases(cases) {
  const m = new Map();
  for (const c of cases) {
    const k = configKey(c.config);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}
function groupSummary(cases) {
  return groupCases(cases).map(([key, list]) => ({ key, cases: list.length }));
}
/** Corpus: ids únicos, `input` é JSON `{opts, userOpts?}` e `config` é válida. */
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
    if (typeof c?.input !== 'string') fail(`caso ${c.id}: input precisa ser string JSON`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
    const cfg = c.config;
    if (!cfg || !['default', 'compact', 'full'].includes(cfg.style) || !['default', 'true', 'false'].includes(cfg.showSource)) {
      fail(`caso ${c.id}: config inválida: ${JSON.stringify(cfg)}`);
    }
    let inner;
    try {
      inner = JSON.parse(c.input);
    } catch (e) {
      fail(`caso ${c.id}: input não é JSON: ${e.message}`);
    }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) fail(`caso ${c.id}: input precisa ser objeto`);
    if (!inner.opts || typeof inner.opts !== 'object' || Array.isArray(inner.opts)) fail(`caso ${c.id}: input precisa de { opts: {} }`);
    if (inner.userOpts !== undefined && (typeof inner.userOpts !== 'object' || inner.userOpts === null || Array.isArray(inner.userOpts))) {
      fail(`caso ${c.id}: userOpts precisa ser objeto`);
    }
  }
  return { sha: sha256(raw), cases };
}
/** JSONL: `expectedJson` sempre; `expected` cru só quando não há órfão. */
function renderJsonl(corpus, byId) {
  const lines = corpus.cases.map((c) => {
    const r = byId.get(c.id);
    if (!r) fail(`caso ${c.id} sem resultado do oráculo`);
    const rec = { id: c.id, config: c.config, input: c.input };
    if (!r.orphanSurrogate) rec.expected = r.expected;
    rec.expectedJson = r.expectedJson;
    rec.orphanSurrogate = r.orphanSurrogate;
    return JSON.stringify(rec);
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null; // provenance: ausência de git não pode bloquear
  }
}
function buildManifest(corpus, byId, jsonl) {
  const orphans = [...byId.entries()].filter(([, r]) => r.orphanSurrogate).map(([id]) => id).sort();
  return {
    format: MANIFEST_FORMAT,
    sourceHashLineEndings: SOURCE_HASH_LINE_ENDINGS,
    registry: REGISTRY,
    function: {
      id: REGISTRY[0],
      name: 'streamDisplayName',
      sourcePath: toPosix(SOURCE),
      sourceSha256: shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE))),
      artifactPath: toPosix(ARTIFACT),
      artifactSha256: sha256(fs.readFileSync(path.join(REPO, ARTIFACT))),
      configEnv: {
        STREAM_NAME_STYLE: "'full' liga o estilo full; ausente/compact = compact",
        STREAM_NAME_SHOW_SOURCE: "'false' esconde o tracker; ausente = true",
      },
      fieldContract: {
        expectedJson: 'JSON.stringify(resultado) do Node: SEMPRE JSON válido e ASCII-safe (escapa surrogate \\uD800-\\uDFFF órfão). Campo de comparação do leitor Rust.',
        expected: 'string JS crua; OMITIDA quando orphanSurrogate=true (serde_json estrito recusa surrogate órfão).',
        orphanSurrogate: 'true quando compactTracker corta um par surrogate UTF-16 ao meio.',
      },
    },
    configGroups: groupSummary(corpus.cases),
    traps: [{
      id: 'compactTracker/utf16-cut',
      where: 'src/utils/audio-quality.ts:compactTracker (slice em unidades UTF-16)',
      detail: 'Par surrogate astral na fronteira do corte vira surrogate órfão. O porte Rust NÃO pode dropar em silêncio: preserve o quirk via expectedJson ou reporte Fail.',
      vectorIds: orphans,
      count: orphans.length,
    }],
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    node: { major: Number(process.versions.node.split('.')[0]), version: process.version },
    git: { revision: gitRevision() },
  };
}
function readManifestIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function generate(corpus, byId, jsonl, outDir, force) {
  const outJsonl = path.join(outDir, path.basename(OUT_JSONL));
  const outManifest = path.join(outDir, path.basename(OUT_MANIFEST));
  const existing = readManifestIfExists(outManifest);
  if (existing && !force && existing.function?.sourceSha256 !== shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE)))) {
    fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outJsonl, jsonl);
  const manifest = buildManifest(corpus, byId, jsonl);
  fs.writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${toPosix(path.relative(REPO, outJsonl))} (${corpus.cases.length} linhas; ${manifest.traps[0].count} vetores UTF-16 órfãos)`);
  console.log(`[golden] manifest: ${toPosix(path.relative(REPO, outManifest))} output=${manifest.output.sha256.slice(0, 12)}…`);
}
/** Check: só leitura. Qualquer divergência encerra com exit 1 e motivo exato. */
function check(corpus, byId, jsonl, outDir) {
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
  assertSha('output.sha256', manifest.output?.sha256);
  if (manifest.output.sha256 !== sha256(committed)) fail('golden divergiu do manifest (arquivo alterado fora do gerador)');
  if (!committed.equals(jsonl)) fail('comportamento do dist divergiu do golden (comparação byte a byte falhou)');
  assertSha('corpus.sha256', manifest.corpus?.sha256);
  if (manifest.corpus.sha256 !== corpus.sha) fail('corpus mudou desde a geração (hash diverge do manifest)');
  assertSha('function.sourceSha256', manifest.function?.sourceSha256);
  if (manifest.function.sourceSha256 !== shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE)))) fail('fonte mudou desde a geração; regenere o golden');
  const lines = committed.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${manifest.output?.lines}`);
  }
  if (!(manifest.output.lines > 0)) fail('manifest com contagem zero (flag inválida)');
  const orphans = [...byId.entries()].filter(([, r]) => r.orphanSurrogate).map(([id]) => id).sort();
  const want = [...(manifest.traps?.[0]?.vectorIds ?? [])].sort();
  if (orphans.join(',') !== want.join(',')) fail(`vetores UTF-16 órfãos do manifest divergem: manifest=[${want}] dist=[${orphans}]`);
  if (manifest.traps?.[0]?.count !== orphans.length) fail('contagem de vetores UTF-16 órfãos diverge');
  // node.version e git.revision são provenance: deliberadamente NÃO comparados.
  console.log(`[golden] OK: ${toPosix(path.relative(REPO, outJsonl))} (${lines.length} casos; ${orphans.length} vetores UTF-16 órfãos)`);
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const rel of [ARTIFACT, RUNTIME_ARTIFACT, SOURCE]) {
    try {
      fs.statSync(path.join(REPO, rel));
    } catch {
      fail(`oráculo ausente: rode npm run build antes (${rel} não existe)`);
    }
  }
  const artStat = fs.statSync(path.join(REPO, ARTIFACT));
  const srcStat = fs.statSync(path.join(REPO, SOURCE));
  if (artStat.mtimeMs < srcStat.mtimeMs) {
    fail(`dist possivelmente defasado (${ARTIFACT} é mais antigo que ${SOURCE}); rode npm run build`);
  }
  const graph = collectGraph(path.join(REPO, ARTIFACT));
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(TEMP_BASE, 'stream-display-'));
  try {
    stageOracle(graph.files, stagingDir);
    const dotenvPath = path.join(stagingDir, 'empty-dotenv');
    fs.writeFileSync(dotenvPath, '');
    const byId = new Map();
    for (const [, list] of groupCases(corpus.cases)) {
      for (const r of runGroup(list[0].config, list, stagingDir, dotenvPath)) {
        if (byId.has(r.id)) fail(`id repetido na saída do oráculo: ${r.id}`);
        byId.set(r.id, r);
      }
    }
    const jsonl = renderJsonl(corpus, byId);
    const outDir = resolveCliPath(args.out, path.dirname(OUT_JSONL));
    if (args.check) check(corpus, byId, jsonl, outDir);
    else generate(corpus, byId, jsonl, outDir, args.force);
  } finally {
    if (!args.keepTmp) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
try { main(); } catch (e) {
  console.error(`[golden] FALHA: ${e instanceof GoldenError ? e.message : e?.stack || e?.message || String(e)}`);
  process.exit(1);
}
