#!/usr/bin/env node
/**
 * Golden `play-disposition` — decisão de saída de um stream depois do cache
 * (`src/providers/debrid-play-guard.ts`).
 *
 * Geração: `node scripts/golden/dump-play-disposition.mjs` importa o `dist`
 * REAL (`dist/src/providers/debrid-play-guard.js`) sobre o corpus e grava
 * `rust/golden/play-disposition.jsonl` + manifest. Determinístico: sem
 * timestamp. `--check`: só leitura — falha se faltar, vazio ou divergir.
 *
 * ISOLAMENTO: o módulo TS é FOLHA (só `import type`, que o tsc apaga), então o
 * import roda no processo do script, sem staging. `assertLeafModule` prende
 * isso: se o módulo ganhar import de runtime, o dump reprova e a medição precisa
 * voltar ao `golden-kit.mjs` (medir contra `config` vivo mediria outra coisa).
 *
 * MIGRAÇÃO: enquanto `debrid-play-guard.ts` for o dono da regra, este oráculo é
 * o próprio branch. Quando ele virar casca do napi, a geração passa a rodar no
 * worktree `../adom-esm` (mesmo contrato dos goldens cujo corpo saiu daqui).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const SOURCE = 'src/providers/debrid-play-guard.ts';
const ARTIFACT = 'dist/src/providers/debrid-play-guard.js';
const CORPUS = 'scripts/golden/corpus-play-disposition.json';
const OUT_JSONL = 'rust/golden/play-disposition.jsonl';
const OUT_MANIFEST = 'rust/golden/play-disposition.manifest.json';
const REGISTRY = 'play-disposition/playDisposition';
const NAME = 'playDisposition';

class GoldenError extends Error {}
const fail = (msg) => { throw new GoldenError(String(msg)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');
const fileSha = (rel) => sha256(fs.readFileSync(path.join(REPO, rel)));

function parseArgs(argv) {
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
const resolveCliPath = (p, def) => (!p ? path.join(REPO, def) : path.isAbsolute(p) ? p : path.join(REPO, p));

/** O módulo é folha: qualquer import de runtime reprova aqui. */
function assertLeafModule() {
  const src = fs.readFileSync(path.join(REPO, ARTIFACT), 'utf8');
  const hasImport = /\bimport\s+(?:[^'"]*?\bfrom\s+)?['"]/.test(src)
    || /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]/.test(src);
  if (hasImport) {
    fail(`${ARTIFACT} deixou de ser folha (tem import): volte a medir pelo golden-kit.mjs`);
  }
}

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
    try {
      JSON.parse(c.input);
    } catch (e) {
      fail(`caso ${c.id}: input não é JSON (${e.message})`);
    }
  }
  return { sha: sha256(raw), cases };
}

/**
 * O TS testa `_multiWorkAdmitted` por VERDADE do JS, e `infoHash` também entra
 * num `if` — `""` é falso. A conversão para `Boolean` aqui é o que o TS já faz
 * sozinho; o Rust recebe booleano e não pode divergir em string vazia/"0".
 */
function measure(mod, req) {
  return mod.playDisposition(
    {
      infoHash: req.infoHash ? String(req.infoHash) : undefined,
      _multiWorkAdmitted: Boolean(req.multiWorkAdmitted),
    },
    {
      cached: Boolean(req.cached),
      resolveUncached: Boolean(req.resolveUncached),
      degraded: Boolean(req.degraded),
    },
  );
}

function renderJsonl(corpus, mod) {
  const lines = corpus.cases.map((c) => {
    const req = JSON.parse(c.input);
    // O TS monta o objeto com `_multiWorkAdmitted` só quando é verdadeiro? Não:
    // a regra do guard testa o campo, então ele é sempre passado (truthy/falsy).
    const expected = measure(mod, req);
    if (typeof expected !== 'string') fail(`caso ${c.id}: saída não-string (${typeof expected})`);
    return JSON.stringify({ id: c.id, input: c.input, expected });
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

function buildManifest(corpus, jsonl) {
  return {
    format: MANIFEST_FORMAT,
    registry: [REGISTRY],
    function: {
      name: NAME,
      sourcePath: toPosix(SOURCE),
      sourceSha256: fileSha(SOURCE),
      artifactPath: toPosix(ARTIFACT),
      artifactSha256: fileSha(ARTIFACT),
    },
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    node: { major: Number(process.versions.node.split('.')[0]), version: process.version },
    git: { revision: gitRevision() },
  };
}

const readManifestIfExists = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function generate(corpus, jsonl, outDir, force) {
  const outJsonl = path.join(outDir, path.basename(OUT_JSONL));
  const outManifest = path.join(outDir, path.basename(OUT_MANIFEST));
  const existing = readManifestIfExists(outManifest);
  if (existing && !force && existing.function?.sourceSha256 !== fileSha(SOURCE)) {
    fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outJsonl, jsonl);
  const manifest = buildManifest(corpus, jsonl);
  fs.writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${toPosix(path.relative(REPO, outJsonl))} (${corpus.cases.length} linhas)`);
  console.log(`[golden] manifest: ${toPosix(path.relative(REPO, outManifest))} output=${manifest.output.sha256.slice(0, 12)}…`);
}

function check(corpus, jsonl, outDir) {
  const outJsonl = path.join(outDir, path.basename(OUT_JSONL));
  const manifest = readManifestIfExists(path.join(outDir, path.basename(OUT_MANIFEST)));
  if (!manifest) fail(`manifest ausente ou ilegível: ${path.join(outDir, path.basename(OUT_MANIFEST))}`);
  if (manifest.format !== MANIFEST_FORMAT) fail(`formato de manifest desconhecido: ${manifest.format}`);
  if (!Array.isArray(manifest.registry) || manifest.registry.join(',') !== REGISTRY) {
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
  if (manifest.function?.sourceSha256 !== fileSha(SOURCE)) fail('fonte mudou desde a geração; regenere o golden');
  const lines = committed.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${manifest.output?.lines}`);
  }
  console.log(`[golden] OK: ${toPosix(path.relative(REPO, outJsonl))} (${lines.length} casos batem com o dist vivo)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactAbs = path.join(REPO, ARTIFACT);
  const sourceAbs = path.join(REPO, SOURCE);
  let artStat;
  let srcStat;
  try {
    artStat = fs.statSync(artifactAbs);
    srcStat = fs.statSync(sourceAbs);
  } catch {
    fail(`oráculo ausente: rode npm run build antes (${ARTIFACT} ou ${SOURCE} não existe)`);
  }
  if (artStat.mtimeMs < srcStat.mtimeMs) {
    fail(`dist possivelmente defasado (${ARTIFACT} é mais antigo que ${SOURCE}); rode npm run build`);
  }
  assertLeafModule();
  const corpus = loadCorpus(resolveCliPath(args.corpus, CORPUS));
  const mod = await import(pathToFileURL(artifactAbs).href);
  if (typeof mod.playDisposition !== 'function') fail('o dist não exporta playDisposition');
  const jsonl = renderJsonl(corpus, mod);
  const outDir = resolveCliPath(args.out, path.dirname(OUT_JSONL));
  if (args.check) check(corpus, jsonl, outDir);
  else generate(corpus, jsonl, outDir, args.force);
}

try {
  await main();
} catch (e) {
  console.error(`[golden] FALHA: ${e instanceof GoldenError ? e.message : e?.stack || e?.message || String(e)}`);
  process.exit(1);
}
