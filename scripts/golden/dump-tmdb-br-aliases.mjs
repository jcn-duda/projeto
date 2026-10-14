#!/usr/bin/env node
/**
 * Golden de `filterBrAliases` + `MAX_BR_ALIASES` (src/utils/tmdb-br-aliases.ts),
 * medidos no dist REAL.
 *
 * Geração (default): roda o corpus contra o oráculo do dist e grava
 * rust/golden/tmdb-br-aliases.jsonl + manifest (determinístico, sem timestamp).
 * `--check`: ESTRITAMENTE leitura; não escreve nem atualiza expectativas. Falha
 * se golden/manifest faltar, vazio ou divergir (hash, comportamento do dist,
 * fonte alterada). Flags de teste: --corpus/--out redirecionam (negativos);
 * --keep-tmp preserva o staging. Os paths DENTRO do manifest são sempre os
 * canônicos do repo.
 *
 * ISOLAMENTO: importar tmdb-br-aliases.js arrasta config/logger/deadline
 * (dotenv + seções). Por isso o oráculo roda em child descartável contra um
 * STAGING só com o grafo compilado (dist + package.json + node_modules/dotenv),
 * sem .env/data/volume, CWD em TEMP, DOTENV_CONFIG_PATH vazio, CACHE_PERSIST=
 * false, RUST_CORE=off e env mínima (sem NODE_OPTIONS do host, sem credencial).
 * O grafo é inspecionado estaticamente: nada de node:http/net/tls/dns/
 * child_process e nenhum bare fora de dotenv.
 *
 * HASH DA FONTE: `shaSourceLf` (helper compartilhado) normaliza só CRLF→LF antes
 * de hashear o `.ts`, para o MESMO conteúdo valer em checkout CRLF ou LF; o
 * rótulo vai em `sourceHashLineEndings`. Corpus e saída são hasheados RAW.
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
const ORACLE = path.join(REPO, 'scripts', 'golden', 'tmdb-br-aliases-oracle.mjs');
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
const REGISTRY_ID = 'tmdb-br-aliases/filterBrAliases';
const FUNCTION_NAME = 'filterBrAliases';
const SOURCE = 'src/utils/tmdb-br-aliases.ts';
const ARTIFACT = 'dist/src/utils/tmdb-br-aliases.js';
const CORPUS = 'scripts/golden/corpus-tmdb-br-aliases.json';
const OUT_JSONL = 'rust/golden/tmdb-br-aliases.jsonl';
const OUT_MANIFEST = 'rust/golden/tmdb-br-aliases.manifest.json';
// Guarda estática do grafo: rede/exec proibidos; bare só dotenv.
const BANNED_SPECIFIERS = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns',
  'node:child_process', 'node:dgram', 'node:cluster', 'node:worker_threads', 'node:inspector', 'node:repl'];
const ALLOWED_BARE = new Set(['dotenv']);
// Vars do host que atravessam (NODE_OPTIONS fica de fora) e credenciais barradas.
const HOST_ALLOW = ['PATH', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS'];
const CLEAN_KEYS = ['PUBLIC_URL', 'JACKETT_URL', 'TMDB_API_KEY', 'DEBRID_SERVICE', 'DEBRID_RD_ORACLE_STREMTHRU_TOKEN', 'DEBRID_API_KEY', 'DEBRID_ALLOW_ENV_KEY', 'RESOLVE_SECRET'];

class GoldenError extends Error {}
// fail LANÇA (não exit): o finally do staging roda e nada fica órfão no TEMP.
const fail = (msg) => { throw new GoldenError(String(msg)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

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
}
function oracleEnv(dotenvPath) {
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DOTENV_CONFIG_PATH = dotenvPath;
  env.CACHE_PERSIST = 'false';
  env.RUST_CORE = 'off';
  env.ADDON_LOG_LEVEL = 'silent';
  return env; // NODE_OPTIONS/credenciais/etc.: nunca herdados
}
/** Um child isolado: devolve as saídas do oráculo por id, na ordem do corpus. */
function runOracle(corpus, stagingDir, dotenvPath) {
  const job = {
    cwd: stagingDir,
    dotenvPath,
    artifactPath: path.join(stagingDir, ARTIFACT),
    forbiddenEnv: CLEAN_KEYS,
    cases: corpus.cases.map((c) => ({ id: c.id, input: c.input })),
  };
  const jobPath = path.join(stagingDir, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify(job));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [ORACLE, jobPath], {
      cwd: stagingDir, env: oracleEnv(dotenvPath),
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
    });
  } catch (e) {
    fail(`oráculo falhou: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  const lastLine = stdout.trimEnd().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (e) {
    fail(`saída do oráculo não é JSON: ${e.message}`);
  }
  if (!parsed?.ok) fail('oráculo não reportou ok');
  return new Map(parsed.cases.map((r) => [r.id, r.expected]));
}
/** Corpus: ids únicos, `input` string e JSON `{op,candidates,canonical}` válido. */
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
  const checkList = (list, id, field) => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) fail(`caso ${id}: ${field} precisa ser lista`);
    for (const v of list) {
      if (v === null) continue;
      if (typeof v !== 'string') fail(`caso ${id}: ${field} aceita só string ou null (sem coerção)`);
    }
  };
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (typeof c.input !== 'string') fail(`caso ${c.id}: input precisa ser string`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
    let inner;
    try {
      inner = JSON.parse(c.input);
    } catch (e) {
      fail(`caso ${c.id}: input não é JSON: ${e.message}`);
    }
    if (inner?.op !== 'filter') fail(`caso ${c.id}: op inválida`);
    checkList(inner.candidates, c.id, 'candidates');
    checkList(inner.canonical, c.id, 'canonical');
  }
  return { sha: sha256(raw), cases };
}
/** JSONL mínimo e versionado: entrada + expected do dist vivo. */
function renderJsonl(corpus, byId) {
  const lines = corpus.cases.map((c) => {
    const expected = byId.get(c.id);
    if (typeof expected !== 'string') fail(`caso ${c.id} sem saída do oráculo`);
    return JSON.stringify({ id: c.id, input: c.input, expected });
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
/** Fonte com hash LF (portátil); corpus/saída/artefato são RAW. */
const fileRaw = (rel) => fs.readFileSync(path.join(REPO, rel));
const sourceShaLf = (rel) => shaSourceLf(fileRaw(rel));
function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null; // provenance: ausência de git não pode bloquear
  }
}
function buildManifest(corpus, jsonl) {
  return {
    format: MANIFEST_FORMAT,
    // Política do hash da fonte: CRLF → LF (portátil entre checkouts).
    sourceHashLineEndings: SOURCE_HASH_LINE_ENDINGS,
    registry: [REGISTRY_ID],
    function: {
      name: FUNCTION_NAME,
      sourcePath: toPosix(SOURCE),
      sourceSha256: sourceShaLf(SOURCE),
      // Provenance apenas: rebuild alheio muda o hash sem mudar comportamento.
      artifactPath: toPosix(ARTIFACT),
      artifactSha256: sha256(fileRaw(ARTIFACT)),
    },
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    // Só o major é contrato; o version completo é provenance.
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
function generate(corpus, jsonl, outDir, force) {
  const outJsonl = path.join(outDir, path.basename(OUT_JSONL));
  const outManifest = path.join(outDir, path.basename(OUT_MANIFEST));
  const existing = readManifestIfExists(outManifest);
  if (existing && !force && existing.function?.sourceSha256 !== sourceShaLf(SOURCE)) {
    fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outJsonl, jsonl);
  const manifest = buildManifest(corpus, jsonl);
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
  if (manifest.sourceHashLineEndings !== SOURCE_HASH_LINE_ENDINGS) fail('política de fim de linha da fonte diverge');
  if (!Array.isArray(manifest.registry) || manifest.registry.join(',') !== REGISTRY_ID) {
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
  if (!committed.equals(jsonl)) fail('comportamento do dist divergiu do golden (comparação caso a caso falhou)');
  if (manifest.corpus?.sha256 !== corpus.sha) fail('corpus mudou desde a geração (hash diverge do manifest)');
  if (manifest.function?.sourceSha256 !== sourceShaLf(SOURCE)) fail('fonte mudou desde a geração; regenere o golden');
  const lines = committed.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${manifest.output?.lines}`);
  }
  // node.version e git.revision são provenance: deliberadamente NÃO comparados.
  console.log(`[golden] OK: ${toPosix(path.relative(REPO, outJsonl))} (${lines.length} casos batem com o dist vivo)`);
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  const entryAbs = path.join(REPO, ARTIFACT);
  const sourceAbs = path.join(REPO, SOURCE);
  let artStat, srcStat;
  try {
    artStat = fs.statSync(entryAbs);
    srcStat = fs.statSync(sourceAbs);
  } catch {
    fail(`oráculo ausente: rode npm run build antes (${ARTIFACT} ou ${SOURCE} não existe)`);
  }
  if (artStat.mtimeMs < srcStat.mtimeMs) {
    fail(`dist possivelmente defasado (${ARTIFACT} é mais antigo que ${SOURCE}); rode npm run build`);
  }
  const graph = collectGraph(entryAbs);
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(TEMP_BASE, 'tmdb-br-aliases-'));
  try {
    stageOracle(graph.files, stagingDir);
    const dotenvPath = path.join(stagingDir, 'empty-dotenv');
    fs.writeFileSync(dotenvPath, '');
    const jsonl = renderJsonl(corpus, runOracle(corpus, stagingDir, dotenvPath));
    const outDir = resolveCliPath(args.out, path.dirname(OUT_JSONL));
    if (args.check) check(corpus, jsonl, outDir);
    else generate(corpus, jsonl, outDir, args.force);
  } finally {
    if (!args.keepTmp) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
try { main(); } catch (e) {
  console.error(`[golden] FALHA: ${e instanceof GoldenError ? e.message : e?.stack || e?.message || String(e)}`);
  process.exit(1);
}
