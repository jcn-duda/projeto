#!/usr/bin/env node
/**
 * Kit compartilhado dos goldens de raspagem (`crawl-policy`, `crawl-parsers`).
 *
 * Reúne a maquinaria que o template `dump-crawl-store-rules.mjs` tinha embutida:
 * args, hash (incl. fingerprint de fonte portátil `shaSourceLf`), corpus,
 * manifest, geração e `--check` estritamente leitura, e a execução do ORÁCULO
 * em processo filho isolado.
 *
 * ISOLAMENTO DO ORÁCULO: o oráculo roda `node <oracle> <job> <out>` com CWD no
 * repo mas ambiente mínimo (`DOTENV_CONFIG_PATH` aponta para um dotenv VAZIO,
 * `CACHE_PERSIST=false`, `RUST_CORE=off`, `ADDON_LOG_LEVEL=silent`, sem
 * `NODE_OPTIONS`/credenciais do host). Os módulos importados podem puxar
 * `config.js` (que lê env no import); com o dotenv vazio os defaults de env
 * valem e NENHUM `.env`/`data/` real é lido. O job e a saída viajam por ARQUIVO
 * (nunca stdout), então avisos do Node não contaminam o resultado.
 *
 * Diferente do template de `crawl-store-rules` (grafo puro escaneado e copiado
 * para um staging), os módulos de política/parsers têm grafo LARGO (registry,
 * config, resolvers) que não é puro — por isso aqui a isolação é por AMBIENTE,
 * não por staging. O determinismo continua: os valores medidos são puros e o
 * corpus é a única entrada.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_HASH_LINE_ENDINGS, shaSourceLf } from './source-fingerprint.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_FORMAT = 'adom-golden-manifest/1';
export const TEMP_BASE = path.join(os.tmpdir(), 'kilo');

export class GoldenError extends Error {}

/** `fail` LANÇA (não exit): o chamador controla o exit code. */
export const fail = (msg) => { throw new GoldenError(String(msg)); };
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const toPosix = (p) => p.split(path.sep).join('/');
export const fileSha = (rel) => sha256(fs.readFileSync(path.join(REPO, rel)));

/** Vars do host que atravessam (NODE_OPTIONS e credenciais ficam de fora). */
const HOST_ALLOW = [
  'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'OS', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
];

export function parseArgs(argv) {
  const args = { check: false, force: false, corpus: null, out: null };
  const need = (flag, val) => {
    if (val === undefined || val.startsWith('-')) fail(`flag ${flag} exige um valor`);
    return val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--force') args.force = true;
    else if (a === '--corpus') args.corpus = need(a, argv[++i]);
    else if (a === '--out') args.out = need(a, argv[++i]);
    else fail(`flag desconhecida: ${a}`);
  }
  return args;
}

/** Absoluto fica como está; relativo é ancorado no repo. */
export function resolveCliPath(p, def) {
  return !p ? path.join(REPO, def) : path.isAbsolute(p) ? p : path.join(REPO, p);
}

/** Expande um spec de fonte: caminho direto ou glob `dir/*-sufixo.ts`. */
function expandSource(spec) {
  if (!spec.includes('*')) return [spec];
  const dir = path.dirname(spec);
  const base = path.basename(spec);
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  let entries;
  try {
    entries = fs.readdirSync(path.join(REPO, dir));
  } catch {
    fail(`diretório de fontes ausente: ${dir}`);
  }
  const matched = entries.filter((e) => re.test(e)).map((e) => path.join(dir, e));
  if (matched.length === 0) fail(`glob de fontes sem correspondência: ${spec}`);
  return matched;
}

/** Exige que `dist` exista e não seja mais antigo que a fonte (aceita globs). */
export function requireFreshDist(artifactRel, sourceSpecs) {
  const artAbs = path.join(REPO, artifactRel);
  let artStat;
  try {
    artStat = fs.statSync(artAbs);
  } catch {
    fail(`artefato ausente: rode npm run build antes (${artifactRel} não existe)`);
  }
  for (const spec of sourceSpecs) {
    for (const rel of expandSource(spec)) {
      let srcStat;
      try {
        srcStat = fs.statSync(path.join(REPO, rel));
      } catch {
        fail(`fonte ausente: ${rel}`);
      }
      if (artStat.mtimeMs < srcStat.mtimeMs) {
        fail(`dist possivelmente defasado (${artifactRel} é mais antigo que ${rel}); rode npm run build`);
      }
    }
  }
}

/** Corpus: ids únicos, `input` string JSON, bloco `config` presente e cobertura via `validate`. */
export function loadCorpus(corpusPath, validate) {
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
    try {
      JSON.parse(c.input);
    } catch {
      fail(`caso ${c.id}: input não é JSON`);
    }
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
  }
  if (typeof validate === 'function') {
    for (const v of validate(cases, parsed?.config)) fail(`corpus: ${v}`);
  }
  return { bytes: raw, sha: sha256(raw), config: parsed?.config ?? null, cases };
}

export function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Roda o oráculo isolado e devolve `{ meta, byId }` na ordem do corpus. */
export function runOracle(oracleRel, corpus) {
  const oracleAbs = path.join(REPO, oracleRel);
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const work = fs.mkdtempSync(path.join(TEMP_BASE, 'golden-'));
  const jobPath = path.join(work, 'job.json');
  const outPath = path.join(work, 'out.json');
  const dotenvPath = path.join(work, 'empty-dotenv');
  fs.writeFileSync(dotenvPath, '');
  fs.writeFileSync(jobPath, JSON.stringify({
    repo: REPO,
    cases: corpus.cases.map((c) => ({ id: c.id, input: c.input })),
  }));
  const env = {};
  for (const k of HOST_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DOTENV_CONFIG_PATH = dotenvPath;
  env.CACHE_PERSIST = 'false';
  env.RUST_CORE = 'off';
  env.ADDON_LOG_LEVEL = 'silent';
  try {
    execFileSync(process.execPath, [oracleAbs, jobPath, outPath], {
      cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    });
  } catch (e) {
    fail(`oráculo falhou: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (e) {
    fail(`saída do oráculo ilegível: ${e.message}`);
  }
  if (!parsed?.ok || !Array.isArray(parsed.cases)) fail('oráculo não reportou ok');
  const byId = new Map(parsed.cases.map((r) => [r.id, r.out]));
  if (byId.size !== corpus.cases.length) fail('oráculo devolveu contagem diferente do corpus');
  return { meta: parsed.meta ?? null, byId };
}

export function renderJsonl(corpus, byId) {
  const lines = corpus.cases.map((c) => {
    const out = byId.get(c.id);
    if (typeof out !== 'string') fail(`oráculo não devolveu string no caso ${c.id}`);
    return JSON.stringify({ id: c.id, input: c.input, expected: out });
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function buildManifest({ registry, name, source, artifact, corpus, outPath, jsonl, config }) {
  const manifest = {
    format: MANIFEST_FORMAT,
    sourceHashLineEndings: SOURCE_HASH_LINE_ENDINGS,
    registry: [registry],
    function: {
      name,
      sourcePath: toPosix(source),
      sourceSha256: shaSourceLf(fs.readFileSync(path.join(REPO, source))),
      artifactPath: toPosix(artifact),
      artifactSha256: fileSha(artifact),
    },
    corpus: { path: toPosix(config.corpusPath), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(outPath), sha256: sha256(jsonl), lines: corpus.cases.length },
    node: { major: Number(process.versions.node.split('.')[0]) },
    git: { revision: gitRevision() },
  };
  return manifest;
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function generate({ outJsonlAbs, outManifestAbs, jsonl, manifest, corpus, source, force }) {
  const existing = readJson(outManifestAbs);
  if (existing && !force) {
    const srcSha = shaSourceLf(fs.readFileSync(path.join(REPO, source)));
    if (existing.function?.sourceSha256 !== srcSha) {
      fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
    }
  }
  fs.mkdirSync(path.dirname(outJsonlAbs), { recursive: true });
  fs.writeFileSync(outJsonlAbs, jsonl);
  fs.writeFileSync(outManifestAbs, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${toPosix(path.relative(REPO, outJsonlAbs))} (${corpus.cases.length} linhas)`);
  console.log(`[golden] manifest: ${toPosix(path.relative(REPO, outManifestAbs))} output=${manifest.output.sha256.slice(0, 12)}…`);
}

/** `--check`: só leitura. Divergência encerra com exit 1 e o motivo exato. */
export function check({ outJsonlAbs, outManifestAbs, jsonl, manifest, corpus, source, registry, name, artifact }) {
  const committed = readJson(outManifestAbs);
  if (!committed) fail(`manifest ausente ou ilegível: ${outManifestAbs}`);
  if (committed.format !== MANIFEST_FORMAT) fail(`formato de manifest desconhecido: ${committed.format}`);
  if (!Array.isArray(committed.registry) || committed.registry.join(',') !== registry) {
    fail(`registry do manifest diverge: ${JSON.stringify(committed.registry)}`);
  }
  for (const [f, want] of [['name', name], ['sourcePath', toPosix(source)], ['artifactPath', toPosix(artifact)]]) {
    if (committed.function?.[f] !== want) fail(`function.${f} do manifest diverge: ${JSON.stringify(committed.function?.[f])}`);
  }
  if (committed.sourceHashLineEndings !== SOURCE_HASH_LINE_ENDINGS) {
    fail(`política de fim de linha da fonte diverge: ${JSON.stringify(committed.sourceHashLineEndings)}`);
  }
  let file;
  try {
    file = fs.readFileSync(outJsonlAbs);
  } catch {
    fail(`golden ausente: ${outJsonlAbs}`);
  }
  if (file.length === 0 || !file.toString('utf8').trim()) fail('golden vazio: nunca aceitar saída zero-linhas');
  if (committed.output?.sha256 !== sha256(file)) fail('golden divergiu do manifest (arquivo alterado fora do gerador)');
  if (!file.equals(jsonl)) fail('comportamento do dist divergiu do golden (comparação caso a caso falhou)');
  if (committed.corpus?.sha256 !== corpus.sha) fail('corpus mudou desde a geração (hash diverge do manifest)');
  if (committed.function?.sourceSha256 !== shaSourceLf(fs.readFileSync(path.join(REPO, source)))) {
    fail('fonte mudou desde a geração; regenere o golden');
  }
  const lines = file.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || committed.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${committed.output?.lines}`);
  }
  console.log(`[golden] OK: ${toPosix(path.relative(REPO, outJsonlAbs))} (${lines.length} casos batem com o dist vivo)`);
}
