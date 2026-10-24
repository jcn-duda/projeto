#!/usr/bin/env node
/**
 * Golden das REGRAS PURAS + CODEC do estado da raspagem de
 * `src/utils/crawl-store-rules.ts`: `errorBackoffMs`, `parseProgress`,
 * `renderProgress`, `progressAdvanced`, `withDryFlag`, `decideUpsert`,
 * `applyResult`, `renderUrl`, `parseStatus`, `parseUrlRow` e `emptyCounters`.
 * É a fatia que as duas engines do `crawl.db` (SQLite e memória) compartilham e
 * que o porte Rust deve reexecutar idêntico.
 *
 * Geração (`node scripts/golden/dump-crawl-store-rules.mjs`): importa as
 * funções REAIS do dist, roda o corpus e grava
 * rust/golden/crawl-store-rules.jsonl + manifest. Determinístico: sem
 * timestamp; os hashes cobrem corpus e saída. `--check`: ESTRITAMENTE leitura —
 * não escreve nem atualiza expectativas; falha se golden/manifest faltar,
 * vazio ou divergir (hash, comportamento do dist vivo, fonte alterada,
 * contagem, constantes do corpus, identidade function.name/sourcePath/artifactPath).
 *
 * COBERTURA: cada `op` tem piso explícito de casos (helper exclusivo
 * `crawl-store-rules-validation.mjs`); corpus que perde uma das 11 funções
 * reprova ANTES de medir/escrever, em `--check` e em `--force`.
 *
 * ISOLAMENTO: o oráculo próprio (`crawl-store-rules-oracle.mjs`) roda em child
 * descartável contra um STAGING só com o grafo compilado (dist + package.json +
 * node_modules/dotenv quando existe), sem .env/data/volume, CWD em TEMP,
 * DOTENV_CONFIG_PATH vazio, CACHE_PERSIST=false, RUST_CORE=off e env mínima
 * (sem NODE_OPTIONS do host). O grafo é inspecionado estaticamente (nada de
 * node:http/net/tls/dns/child_process/worker — o módulo é puro, só importa
 * `crawl-url-key.js`) e o child arma `fetch` para explodir. Nunca importa
 * `addon.js` — o processo do addon nunca sobe.
 *
 * CONFIG: este módulo não lê config em runtime, então o `config` do corpus é
 * DOCUMENTAL: declara os literais exportados que o golden prende
 * (`ERROR_BACKOFF_CAP_MS`/`CRAWL_GIVE_UP_MS`/`DEFAULT_RETRY_BASE_MS`) e o
 * gerador os confere contra o `meta.constants` medido no dist vivo.
 *
 * A fonte é hasheada com a política compartilhada `shaSourceLf`
 * (`source-fingerprint.mjs`): CRLF → LF, portátil entre checkouts. Corpus,
 * artefato e saída continuam byte a byte; o manifest sempre declara
 * `sourceHashLineEndings`.
 *
 * Flags de teste (escopo restrito): --corpus/--out redirecionam entradas/saídas
 * para fixtures fora da árvore (negativos); --keep-tmp preserva o staging. Os
 * paths DENTRO do manifest são sempre os canônicos do repo. O oráculo
 * (source/artifact) nunca é redirecionável.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_HASH_LINE_ENDINGS, shaSourceLf } from './source-fingerprint.mjs';
import { OPS, opCoverageViolations } from './crawl-store-rules-validation.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const REGISTRY = 'crawl-store-rules/crawlStoreRules';
const NAME = 'crawlStoreRules';
const SOURCE = 'src/utils/crawl-store-rules.ts';
const ARTIFACT = 'dist/src/utils/crawl-store-rules.js';
const CORPUS = 'scripts/golden/corpus-crawl-store-rules.json';
const OUT_JSONL = 'rust/golden/crawl-store-rules.jsonl';
const OUT_MANIFEST = 'rust/golden/crawl-store-rules.manifest.json';
const OWN_ORACLE = 'scripts/golden/crawl-store-rules-oracle.mjs';
// OPS + piso por op (cobertura fail-closed das 11 funções) vivem no helper
// exclusivo `crawl-store-rules-validation.mjs`.
// Chaves documentais do `config` do corpus: o valor declarado tem de bater com
// o literal exportado pelo artefato medição no dist vivo.
const CONFIG_CONSTANTS = ['errorBackoffCapMs', 'crawlGiveUpMs', 'defaultRetryBaseMs'];
const TEMP_BASE = path.join(os.tmpdir(), 'kilo');
// Guarda estática do grafo: rede/exec proibidos; bare permitido só dotenv.
const BANNED_SPECIFIERS = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:child_process',
  'node:dgram', 'node:cluster', 'node:worker_threads', 'node:inspector', 'node:repl',
];
const ALLOWED_BARE = new Set(['dotenv']);
// Vars do host que atravessam (NODE_OPTIONS fica de fora); credenciais nunca.
const HOST_ALLOW = [
  'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'OS',
];

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
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(abs), spec));
      else bare.add(spec);
    }
  }
  for (const b of bare) {
    if (!ALLOWED_BARE.has(b.split('/')[0])) fail(`grafo: dependência bare não permitida '${b}'`);
  }
  return [...seen];
}
/** Copia SÓ o grafo compilado + package.json + dotenv (se houver) + o oráculo. */
function stageOracle(graphFiles, stagingDir) {
  for (const abs of graphFiles) {
    const dest = path.join(stagingDir, path.relative(REPO, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(stagingDir, 'package.json'));
  // O grafo deste módulo é puro (não importa dotenv); copiamos quando existe
  // para manter a mesma forma do template sem tornar a geração refém dele.
  const dotenvSrc = path.join(REPO, 'node_modules', 'dotenv');
  if (fs.existsSync(dotenvSrc)) {
    fs.cpSync(dotenvSrc, path.join(stagingDir, 'node_modules', 'dotenv'), { recursive: true });
  }
  // O oráculo entra no staging: a medição não lê nada do repo vivo.
  fs.copyFileSync(path.join(REPO, OWN_ORACLE), path.join(stagingDir, 'oracle.mjs'));
}
function oracleEnv(dotenvPath) {
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DOTENV_CONFIG_PATH = dotenvPath; // .env real nunca é lido
  env.CACHE_PERSIST = 'false';
  env.RUST_CORE = 'off';
  env.ADDON_LOG_LEVEL = 'silent';
  return env; // NODE_OPTIONS/DOTENV_*/credenciais: nunca herdados
}
/** Roda o oráculo isolado e devolve `{ meta, byId }` na ordem do corpus. */
function runOracle(corpus, stagingDir, dotenvPath) {
  const oraclePath = path.join(stagingDir, 'oracle.mjs');
  const jobPath = path.join(stagingDir, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify({
    artifact: path.join(stagingDir, ARTIFACT),
    cases: corpus.cases.map((c) => ({ id: c.id, input: c.input })),
  }));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [oraclePath, jobPath], {
      cwd: stagingDir, env: oracleEnv(dotenvPath), encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
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
  if (!parsed?.ok || !Array.isArray(parsed.cases)) fail('oráculo não reportou ok');
  const byId = new Map(parsed.cases.map((r) => [r.id, r.out]));
  if (byId.size !== corpus.cases.length) fail('oráculo devolveu contagem diferente do corpus');
  return { meta: parsed.meta ?? null, byId };
}
/** Corpus: ids únicos, `input` JSON com `op` válida e o bloco `config`. */
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
  const config = parsed?.config;
  const constants = config?.constants;
  if (!constants || typeof constants !== 'object') fail('corpus sem config.constants');
  for (const key of CONFIG_CONSTANTS) {
    if (typeof constants[key] !== 'number') fail(`corpus config.constants.${key} precisa ser número`);
  }
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (typeof c?.input !== 'string') fail(`caso ${c.id}: input precisa ser string JSON`);
    let op;
    try {
      op = JSON.parse(c.input)?.op;
    } catch {
      fail(`caso ${c.id}: input não é JSON`);
    }
    if (!OPS.includes(op)) fail(`caso ${c.id}: op inválida: ${op}`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
  }
  // Fail-closed: além da PERTINÊNCIA, exige PRESENÇA mínima por op (as 11
  // funções); corpus mutilado reprova aqui, antes de medir/escrever/--check.
  for (const v of opCoverageViolations(cases)) fail(`cobertura do corpus: ${v}`);
  return { bytes: raw, sha: sha256(raw), config, cases };
}
/** O `config` do corpus documenta os literais; o dist vivo precisa concordar. */
function checkConstants(config, meta) {
  const got = meta?.constants;
  if (!got || typeof got !== 'object') fail('oráculo não devolveu meta.constants');
  for (const key of CONFIG_CONSTANTS) {
    if (got[key] !== config.constants[key]) {
      fail(`constante ${key} diverge: corpus=${config.constants[key]} dist=${got[key]}`);
    }
  }
}
function renderJsonl(corpus, byId) {
  const lines = corpus.cases.map((c) => {
    const out = byId.get(c.id);
    if (typeof out !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
    return JSON.stringify({ id: c.id, input: c.input, expected: out });
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
function computeJsonl(corpus, stagingDir, dotenvPath) {
  const { meta, byId } = runOracle(corpus, stagingDir, dotenvPath);
  checkConstants(corpus.config, meta);
  return renderJsonl(corpus, byId);
}
const fileSha = (rel) => sha256(fs.readFileSync(path.join(REPO, rel)));
const sourceSha = () => shaSourceLf(fs.readFileSync(path.join(REPO, SOURCE)));
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
    // Política do hash da fonte: cobre o texto com CRLF → LF (portátil entre
    // checkouts); NÃO vale para corpus/artefato/saída.
    sourceHashLineEndings: SOURCE_HASH_LINE_ENDINGS,
    registry: [REGISTRY],
    function: {
      name: NAME,
      sourcePath: toPosix(SOURCE),
      sourceSha256: sourceSha(),
      // Provenance apenas: rebuild alheio muda o hash sem mudar comportamento.
      artifactPath: toPosix(ARTIFACT),
      artifactSha256: fileSha(ARTIFACT),
    },
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    node: { major: Number(process.versions.node.split('.')[0]) },
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
  if (existing && !force && existing.function?.sourceSha256 !== sourceSha()) {
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
  const outManifest = path.join(outDir, path.basename(OUT_MANIFEST));
  const manifest = readManifestIfExists(outManifest);
  if (!manifest) fail(`manifest ausente ou ilegível: ${outManifest}`);
  if (manifest.format !== MANIFEST_FORMAT) fail(`formato de manifest desconhecido: ${manifest.format}`);
  if (!Array.isArray(manifest.registry) || manifest.registry.join(',') !== REGISTRY) {
    fail(`registry do manifest diverge do esperado: ${JSON.stringify(manifest.registry)}`);
  }
  // Identidade canônica: nome/path adulterado não passa como golden válido.
  for (const [f, want] of [['name', NAME], ['sourcePath', toPosix(SOURCE)], ['artifactPath', toPosix(ARTIFACT)]]) {
    if (manifest.function?.[f] !== want) fail(`function.${f} do manifest diverge: ${JSON.stringify(manifest.function?.[f])}`);
  }
  if (manifest.sourceHashLineEndings !== SOURCE_HASH_LINE_ENDINGS) {
    fail(`política de fim de linha da fonte diverge: ${JSON.stringify(manifest.sourceHashLineEndings)}`);
  }
  let committed;
  try {
    committed = fs.readFileSync(outJsonl);
  } catch {
    fail(`golden ausente: ${outJsonl}`);
  }
  if (committed.length === 0 || !committed.toString('utf8').trim()) {
    fail('golden vazio: nunca aceitar saída zero-linhas');
  }
  if (manifest.output?.sha256 !== sha256(committed)) {
    fail('golden divergiu do manifest (arquivo alterado fora do gerador)');
  }
  if (!committed.equals(jsonl)) {
    fail('comportamento do dist divergiu do golden (comparação caso a caso falhou)');
  }
  if (manifest.corpus?.sha256 !== corpus.sha) fail('corpus mudou desde a geração (hash diverge do manifest)');
  if (manifest.function?.sourceSha256 !== sourceSha()) fail('fonte mudou desde a geração; regenere o golden');
  const lines = committed.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${manifest.output?.lines}`);
  }
  // node.major, artifactSha256 e git.revision são provenance: NÃO comparados
  // (artifactSha256 é de rebuild alheio; a identidade nome/path JÁ foi travada
  // acima por function.*).
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
  const stagingDir = fs.mkdtempSync(path.join(TEMP_BASE, 'crawl-store-rules-'));
  try {
    stageOracle(graph, stagingDir);
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
