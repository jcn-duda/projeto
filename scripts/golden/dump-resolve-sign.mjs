#!/usr/bin/env node
/**
 * Golden HMAC da rota /resolve (signResolve/verifyResolve do dist REAL).
 *
 * Geração (`npm run golden:resolve-sign`): roda o corpus contra o oráculo do
 * dist e grava rust/golden/resolve-sign.jsonl + manifest (determinístico, sem
 * timestamp). `--check` (`...:check`): só leitura; falha se faltar/vazio/divergir.
 *
 * ISOLAMENTO: importar sign.js arrasta config (dotenv+seções) -> runtime ->
 * autofetch-live -> cache, e cache.ts abre/le data/cache.db no LOAD. Por isso o
 * oráculo roda em child descartável contra um STAGING só com o grafo compilado
 * (dist + package.json + node_modules/dotenv), sem .env/data/volume, CWD em
 * TEMP, DOTENV_CONFIG_PATH vazio, CACHE_PERSIST=false e env mínima (sem
 * NODE_OPTIONS do host, sem credencial). O grafo é inspecionado estaticamente:
 * nada de node:http/net/tls/dns/child_process e nenhum bare fora de dotenv.
 * Flags de teste: --corpus/--out redirecionam (negativos); --keep-tmp preserva o
 * staging. Os paths DENTRO do manifest são sempre os canônicos do repo.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const ORACLE = path.join(REPO, 'scripts', 'golden', 'resolve-sign-oracle.mjs');
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
// As DUAS funções vivem em src/utils/sign.ts; `registry` lista os ids nesta ordem.
const FUNCTIONS = [
  { id: 'resolve-sign/signResolve', name: 'signResolve' },
  { id: 'resolve-sign/verifyResolve', name: 'verifyResolve' },
];
const SOURCE = 'src/utils/sign.ts';
const ARTIFACT = 'dist/src/utils/sign.js';
const CORPUS = 'scripts/golden/corpus-resolve-sign.json';
const OUT_JSONL = 'rust/golden/resolve-sign.jsonl';
const OUT_MANIFEST = 'rust/golden/resolve-sign.manifest.json';
// Guarda estática do grafo: rede/exec proibidos; bare só dotenv.
const BANNED_SPECIFIERS = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns',
  'node:child_process', 'node:dgram', 'node:cluster', 'node:worker_threads', 'node:inspector', 'node:repl'];
const ALLOWED_BARE = new Set(['dotenv']);
// Vars do host que atravessam (NODE_OPTIONS fica de fora) e credenciais barradas.
const HOST_ALLOW = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS'];
const CLEAN_KEYS = ['PUBLIC_URL', 'JACKETT_URL', 'TMDB_API_KEY', 'DEBRID_SERVICE', 'DEBRID_RD_ORACLE_STREMTHRU_TOKEN', 'DEBRID_API_KEY', 'RESOLVE_SECRET'];

class GoldenError extends Error {}
// fail LANÇA (não exit): o finally do staging roda e nada fica órfão no TEMP.
const fail = (msg) => { throw new GoldenError(String(msg)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

function parseArgs(argv) {
  const args = { check: false, force: false, keepTmp: false, corpus: null, out: null };
  // Valor ausente (próximo token é flag/fim) é ERRO; o gerador de títulos engolia.
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
function baseEnv() {
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env; // NODE_OPTIONS/DOTENV_*/etc.: nunca herdados
}
function groupEnv(group, keys, dotenvPath) {
  const env = baseEnv();
  env.DOTENV_CONFIG_PATH = dotenvPath;
  env.CACHE_PERSIST = 'false';
  env.ADDON_LOG_LEVEL = 'silent';
  if (group === 'primary') env.RESOLVE_SECRET = keys.primary.value;
  else if (group === 'fallback') {
    env.DEBRID_API_KEY = keys.fallback.value;
    env.DEBRID_ALLOW_ENV_KEY = 'true'; // default de fábrica, explicitado p/ determinismo
  }
  return env;
}
function groupExpect(group, keys) {
  if (group === 'primary') return { resolveSecret: keys.primary.value, apiKey: '', effective: keys.primary.value };
  if (group === 'fallback') return { resolveSecret: '', apiKey: keys.fallback.value, effective: keys.fallback.value };
  return { resolveSecret: '', apiKey: '', effective: '' };
}
function groupForbidden(group) {
  const own = group === 'primary' ? 'RESOLVE_SECRET' : group === 'fallback' ? 'DEBRID_API_KEY' : null;
  return CLEAN_KEYS.filter((k) => k !== own);
}
/** Traduz o corpus para o modo de verificação (sig = expected por padrão). */
function sigModeOf(c) {
  if (Object.prototype.hasOwnProperty.call(c, 'sigFrom')) return { sigMode: 'from', sigFrom: c.sigFrom };
  if (Object.prototype.hasOwnProperty.call(c, 'sigMutate')) return { sigMode: 'mutate', sigMutate: c.sigMutate };
  if (Object.prototype.hasOwnProperty.call(c, 'sig')) return { sigMode: 'literal', sigValue: c.sig };
  return { sigMode: 'expected' };
}
/** Um child isolado por GRUPO de chave (config imutável por processo). */
function runGroup(group, keys, corpus, stagingDir, dotenvPath) {
  const cases = corpus.cases.filter((c) => c.key === group).map((c) => ({
    id: c.id, infoHash: c.infoHash, ep: c.ep, hint: c.hint, ...sigModeOf(c),
  }));
  const job = {
    cwd: stagingDir, dotenvPath,
    artifactPath: path.join(stagingDir, ARTIFACT),
    configPath: path.join(stagingDir, 'dist', 'src', 'config.js'),
    runtimePath: path.join(stagingDir, 'dist', 'src', 'runtime.js'),
    keySource: keys[group].keySource,
    expect: groupExpect(group, keys),
    forbiddenEnv: groupForbidden(group),
    cases,
  };
  const jobPath = path.join(stagingDir, `job-${group}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [ORACLE, jobPath], {
      cwd: stagingDir, env: groupEnv(group, keys, dotenvPath),
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
    });
  } catch (e) {
    fail(`oráculo do grupo '${group}' falhou: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  const lastLine = stdout.trimEnd().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (e) {
    fail(`saída do oráculo (${group}) não é JSON: ${e.message}`);
  }
  if (!parsed?.ok) fail(`oráculo (${group}) não reportou ok`);
  return parsed.cases;
}
/** Corpus: ids únicos, campos string obrigatórios e chave fictícia declarada. */
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
  const keys = parsed?.keys;
  if (!Array.isArray(cases) || cases.length === 0) fail('corpus vazio ou sem "cases"');
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) fail('corpus sem "keys"');
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
    if (typeof c.infoHash !== 'string') fail(`${c.id}: infoHash precisa ser string`);
    if (typeof c.ep !== 'string') fail(`${c.id}: ep precisa ser string`);
    if (typeof c.hint !== 'string') fail(`${c.id}: hint precisa ser string`);
    if (!keys[c.key]) fail(`${c.id}: key '${c.key}' não declarada em keys`);
  }
  for (const [id, k] of Object.entries(keys)) {
    if (typeof k?.value !== 'string') fail(`keys.${id}: value precisa ser string`);
    if (k.value && !k.value.startsWith('adom-golden-resolve-sign-FAKE-')) {
      fail(`keys.${id}: chave não é fictícia reconhecível (recusa em assinar)`);
    }
    if (typeof k?.keySource !== 'string' || !k.keySource) fail(`keys.${id}: keySource ausente`);
    if (!cases.some((c) => c.key === id)) fail(`keys.${id}: nenhum caso usa esta chave`);
  }
  return { sha: sha256(raw), cases, keys };
}
/** JSONL mínimo e versionado: entrada + assinatura usada + expected + veredito. */
function renderJsonl(corpus, byGroup) {
  const lines = corpus.cases.map((c) => {
    const row = byGroup[c.key].get(c.id);
    if (!row) fail(`caso ${c.id} sem resultado do oráculo (${c.key})`);
    return JSON.stringify({
      id: c.id, key: corpus.keys[c.key].value, keySource: corpus.keys[c.key].keySource,
      infoHash: c.infoHash, ep: c.ep, hint: c.hint,
      sig: row.sig === undefined ? null : row.sig, expected: row.expected, verified: row.verified,
    });
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
function computeJsonl(corpus, stagingDir, dotenvPath) {
  const byGroup = {};
  for (const group of Object.keys(corpus.keys)) {
    const rows = runGroup(group, corpus.keys, corpus, stagingDir, dotenvPath);
    byGroup[group] = new Map(rows.map((r) => [r.id, r]));
  }
  return renderJsonl(corpus, byGroup);
}
const fileSha = (rel) => sha256(fs.readFileSync(path.join(REPO, rel)));
function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null; // provenance: ausência de git não pode bloquear
  }
}
function buildManifest(corpus, jsonl) {
  const sourceSha256 = fileSha(SOURCE);
  const artifactSha256 = fileSha(ARTIFACT);
  return {
    format: MANIFEST_FORMAT,
    registry: FUNCTIONS.map((f) => f.id),
    functions: FUNCTIONS.map((f) => ({
      id: f.id, name: f.name, sourcePath: toPosix(SOURCE), sourceSha256,
      // Provenance apenas: rebuild alheio muda o hash sem mudar comportamento.
      artifactPath: toPosix(ARTIFACT), artifactSha256,
    })),
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    keys: Object.values(corpus.keys).map((k) => ({
      id: k.id, keySource: k.keySource, kind: k.kind, source: k.source, env: k.env,
      sha256: sha256(k.value), value: k.value,
    })),
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
  if (existing && !force && existing.functions?.[0]?.sourceSha256 !== fileSha(SOURCE)) {
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
  const wantRegistry = FUNCTIONS.map((f) => f.id).join(',');
  if (!Array.isArray(manifest.registry) || manifest.registry.join(',') !== wantRegistry) {
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
  if (manifest.functions?.[0]?.sourceSha256 !== fileSha(SOURCE)) fail('fonte mudou desde a geração; regenere o golden');
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
  const stagingDir = fs.mkdtempSync(path.join(TEMP_BASE, 'resolve-sign-'));
  try {
    stageOracle(graph.files, stagingDir);
    const dotenvPath = path.join(stagingDir, 'empty-dotenv');
    fs.writeFileSync(dotenvPath, '');
    const jsonl = computeJsonl(corpus, stagingDir, dotenvPath);
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
