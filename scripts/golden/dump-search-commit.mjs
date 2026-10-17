#!/usr/bin/env node
/**
 * Golden das decisões puras do fim da busca (`src/providers/search-commit.ts`).
 *
 * Geração (`node scripts/golden/dump-search-commit.mjs`): roda o corpus contra
 * o artefato compilado REAL (`dist/src/providers/search-commit.js`) e grava
 * `rust/golden/search-commit.jsonl` + manifest determinístico. `--check`: só
 * leitura; falha se o dist vivo divergir do golden, sem nunca escrever.
 *
 * ISOLAMENTO: aqui NÃO existe o staging em TEMP dos outros goldens, e o motivo
 * é o próprio módulo — ele é folha (zero `import`). Sem grafo não há `config`,
 * `data/cache.db`, rede nem `.env` para isolar, então o import roda no processo
 * do script. `assertLeafModule` prende essa promessa: se o módulo ganhar um
 * import, o dump reprova com a instrução de voltar ao staging (medir contra
 * `config` vivo mediria outra coisa).
 *
 * `--check` também prova a CONTAGEM de casos: corpus vazio ou jsonl de zero
 * linhas nunca passa (o bug clássico de golden que "some").
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const SOURCE = 'src/providers/search-commit.ts';
const ARTIFACT = 'dist/src/providers/search-commit.js';
const CORPUS = 'scripts/golden/corpus-search-commit.json';
const OUT_JSONL = 'rust/golden/search-commit.jsonl';
const OUT_MANIFEST = 'rust/golden/search-commit.manifest.json';
// Uma entrada por função portada — mesma ordem que o `registry` do manifest.
const FUNCTIONS = ['commitDecision', 'latePromotionDecision', 'debridRefreshSatisfied', 'staleRefreshEligible']
  .map((name) => ({ id: `search-commit/${name}`, name }));
const OPS = new Set(['commit', 'late', 'swr', 'refresh']);

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

/** O módulo é folha: qualquer `import`/`export ... from` reprova aqui. */
function assertLeafModule() {
  const src = fs.readFileSync(path.join(REPO, ARTIFACT), 'utf8');
  const hasImport = /\bimport\s+(?:[^'"]*?\bfrom\s+)?['"]/.test(src)
    || /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]/.test(src);
  if (hasImport) {
    fail(`${ARTIFACT} deixou de ser folha (tem import): o staging em TEMP voltou a ser obrigatório`);
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
    let req;
    try {
      req = JSON.parse(c.input);
    } catch (e) {
      fail(`caso ${c.id}: input não é JSON (${e.message})`);
    }
    if (!OPS.has(req?.op)) fail(`caso ${c.id}: op desconhecida ${JSON.stringify(req?.op)}`);
  }
  return { sha: sha256(raw), cases };
}

/**
 * `live` nasce como MÉTODOS porque o módulo só pode perguntar dentro do ramo
 * certo — o TS original tinha o mesmo curto-circuito, e um stub que não
 * implementa uma das perguntas continua válido. `null` = busca sem coleta viva.
 */
function liveView(spec, caseId) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== 'object') fail(`caso ${caseId}: live inválido ${JSON.stringify(spec)}`);
  return {
    needsFallback: () => Boolean(spec.needsFallback),
    hasAnyFailure: () => Boolean(spec.hasAnyFailure),
  };
}

/**
 * Saída do caso já canonizada (string JSON). As decisões são puras e síncronas:
 * um `await` aqui seria sinal de que o módulo ganhou efeito e o dump precisa
 * parar para revisão.
 */
function measure(mod, req, caseId) {
  if (req.op === 'commit') {
    return JSON.stringify(mod.commitDecision({
      playable: Boolean(req.playable),
      partial: Boolean(req.partial),
      // `undefined` é estado REAL (a checagem do debrid nunca respondeu): só o
      // `null` explícito do corpus vira `undefined`.
      debridKnown: req.debridKnown === null ? undefined : Boolean(req.debridKnown),
      needsDebridRefresh: Boolean(req.needsDebridRefresh),
      hasFallback: Boolean(req.hasFallback),
      cacheTtl: Number(req.cacheTtl),
      fallbackStreamsTtl: Number(req.fallbackStreamsTtl),
    }));
  }
  if (req.op === 'late') {
    return JSON.stringify(mod.latePromotionDecision({
      hitPartial: Boolean(req.hitPartial),
      hitFallback: Boolean(req.hitFallback),
      hitHasStreams: Boolean(req.hitHasStreams),
      hitDebridKnown: Boolean(req.hitDebridKnown),
      live: liveView(req.live, caseId),
      cacheTtl: Number(req.cacheTtl),
    }));
  }
  if (req.op === 'swr') return JSON.stringify(mod.staleRefreshEligible(req.entry ?? null, Boolean(req.playable)));
  if (req.op === 'refresh') return JSON.stringify(mod.debridRefreshSatisfied(req.entry ?? null));
  fail(`caso ${caseId}: op desconhecida ${JSON.stringify(req.op)}`);
}

function renderJsonl(corpus, mod) {
  const lines = corpus.cases.map((c) => {
    const req = JSON.parse(c.input);
    const expected = measure(mod, req, c.id);
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
