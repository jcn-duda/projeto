#!/usr/bin/env node
/**
 * F0 da migração TS→Rust: golden files de normalizeTitle.
 *
 * Modo geração (default; `npm run golden:titles`): importa a função REAL do
 * dist, roda o corpus e grava rust/golden/title-normalization.jsonl +
 * manifest. Determinístico: sem timestamps, hashes cobrem corpus e saída.
 * Se a fonte .ts mudou desde a última geração, exige --force para regenerar.
 *
 * Modo --check (`npm run golden:titles:check`): ESTRICTAMENTE leitura — não
 * escreve nem atualiza expectativas. Falha se golden/manifest faltar, vazio
 * ou divergir (hash, comportamento do dist, fonte alterada).
 *
 * Freshness honesto: o SHA da fonte prende a geração ao .ts; o mtime
 * (dist >= src) é heurística de "esqueceu o build", não prova de proveniência
 * — a prova real é a recomputação: check re-executa o dist vivo e compara
 * byte a byte com o golden commitado. Sem rede, sem .env, função pura.
 *
 * Flags de teste (escopo restrito): --corpus <caminho> e --out <dir>
 * redirecionam entradas/saídas para fixtures fora da árvore (usado nos
 * negativos); os paths DENTRO do manifest são sempre os canônicos do repo.
 * O oracle (source/artifact) nunca é redirecionável.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';

// Registro de funções cobertas. Cada entrada tem corpus e saída próprios e um
// manifest por função (o check exige um registry por arquivo). Sem `--fn`, o
// gerador usa `title-normalization`, o padrão de sempre.
//
// `toText` converte a saída do oracle em string para o JSONL, quando a função
// devolve outra coisa. Para listas, `join(' ')` é sem perda: os tokens saem de
// `split(' ')` e nunca são vazios nem contêm espaço.
const FUNCTIONS = {
  'title-normalization': {
    id: 'title-normalization/normalizeTitle',
    name: 'normalizeTitle',
    source: 'src/utils/title-normalization.ts',
    artifact: 'dist/src/utils/title-normalization.js',
    corpus: 'scripts/golden/corpus-title-normalization.json',
    outJsonl: 'rust/golden/title-normalization.jsonl',
    outManifest: 'rust/golden/title-normalization.manifest.json',
  },
  'matching-vocabulary': {
    id: 'matching-vocabulary/titleTokens',
    name: 'titleTokens',
    source: 'src/utils/matching-vocabulary.ts',
    artifact: 'dist/src/utils/matching-vocabulary.js',
    corpus: 'scripts/golden/corpus-matching-vocabulary.json',
    outJsonl: 'rust/golden/matching-vocabulary-title-tokens.jsonl',
    outManifest: 'rust/golden/matching-vocabulary-title-tokens.manifest.json',
    toText: (tokens) => tokens.join(' '),
  },
  // Conteúdo das constantes de vocabulário: entrada = nome da constante, saída =
  // itens únicos e ordenados (Set/Array), `chave=valor` (objeto) ou
  // `/fonte/flags` (regex), separados por espaço.
  'matching-vocabulary-sets': {
    id: 'matching-vocabulary/sets',
    name: 'vocabularySets',
    source: 'src/utils/matching-vocabulary.ts',
    artifact: 'dist/src/utils/matching-vocabulary.js',
    corpus: 'scripts/golden/corpus-matching-vocabulary-sets.json',
    outJsonl: 'rust/golden/matching-vocabulary-sets.jsonl',
    outManifest: 'rust/golden/matching-vocabulary-sets.manifest.json',
    resolve: (mod) => (name) => {
      const v = mod[name];
      if (v === undefined) throw new Error(`constante desconhecida: ${name}`);
      if (v instanceof Set || Array.isArray(v)) {
        return [...new Set(v)].sort().join(' ');
      }
      if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
      if (typeof v === 'object') {
        return Object.entries(v).map(([k, n]) => `${k}=${n}`).sort().join(' ');
      }
      throw new Error(`tipo não suportado em ${name}`);
    },
  },
};
const DEFAULT_FN = 'title-normalization';

const fail = (msg) => {
  console.error(`[golden] FALHA: ${msg}`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

function parseArgs(argv) {
  const args = { check: false, force: false, corpus: null, out: null, fn: DEFAULT_FN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--force') args.force = true;
    else if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--fn') args.fn = argv[++i];
    else fail(`flag desconhecida: ${a}`);
  }
  return args;
}

/** Resolve caminho de entrada/saída: absoluto fica como está; relativo é ancorado no repo. */
function resolveCliPath(p, def) {
  if (!p) return path.join(REPO, def);
  return path.isAbsolute(p) ? p : path.join(REPO, p);
}

/** Oracle vivo: importa a função do dist compilado. Nunca réplica. */
async function loadOracle(fn) {
  const artifactPath = path.join(REPO, fn.artifact);
  const sourcePath = path.join(REPO, fn.source);
  let artStat, srcStat;
  try {
    artStat = statSync(artifactPath);
    srcStat = statSync(sourcePath);
  } catch {
    fail(`oracle ausente: rode npm run build antes (${fn.artifact} ou ${fn.source} não existe)`);
  }
  // Heurística de dist defasado (não é prova): build grava o JS DEPOIS de
  // editar o TS; JS mais velho que o TS indica build esquecido.
  if (artStat.mtimeMs < srcStat.mtimeMs) {
    fail(`dist possivelmente defasado (${fn.artifact} é mais antigo que ${fn.source}); rode npm run build`);
  }
  let mod;
  try {
    mod = await import(pathToFileURL(artifactPath).href);
  } catch (e) {
    fail(`não consegui importar o oracle do dist: ${e.message}`);
  }
  // `resolve(mod)` monta o oracle quando a entrada não é uma função exportada
  // direta (ex.: conteúdo de uma constante). Mesma regra: sem réplica no gerador.
  const raw = fn.resolve ? fn.resolve(mod) : mod[fn.exportName ?? fn.name];
  if (typeof raw !== 'function') fail(`dist não exporta ${fn.name}`);
  const f = fn.toText ? (input) => fn.toText(raw(input)) : raw;
  return { f, sourceSha: sha256(readFileSync(sourcePath)), artifactSha: sha256(readFileSync(artifactPath)) };
}

/** Corpus: só strings, ids únicos e não vazio — contrato desta fatia. */
function loadCorpus(corpusPath) {
  let raw;
  try {
    raw = readFileSync(corpusPath);
  } catch {
    fail(`corpus ausente: ${corpusPath}`);
  }
  let parsed;
  try {
    // BOM tolerado no parse (editores Windows o inserem); o hash continua
    // sobre os bytes crus — corpus com BOM novo diverge do manifest.
    const text = raw.toString('utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`corpus inválido (JSON): ${e.message}`);
  }
  const cases = parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) fail('corpus vazio ou sem "cases"');
  const seen = new Set();
  for (const c of cases) {
    if (typeof c?.id !== 'string' || !c.id) fail(`caso sem id estável: ${JSON.stringify(c)}`);
    if (typeof c?.input !== 'string') fail(`caso ${c.id}: input precisa ser string (fatia de strings)`);
    if (seen.has(c.id)) fail(`id duplicado no corpus: ${c.id}`);
    seen.add(c.id);
  }
  return { bytes: raw, sha: sha256(raw), cases };
}

function renderJsonl(cases, f) {
  const lines = cases.map((c) => {
    let out;
    try {
      out = f(c.input);
    } catch (e) {
      fail(`oracle lançou no caso ${c.id}: ${e.message}`);
    }
    if (typeof out !== 'string') fail(`oracle não devolveu string no caso ${c.id}`);
    return JSON.stringify({ id: c.id, input: c.input, expected: out });
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

function buildManifest(fn, oracle, corpusSha, casesCount, outputSha, linesCount) {
  return {
    format: MANIFEST_FORMAT,
    registry: [fn.id],
    function: {
      name: fn.name,
      sourcePath: toPosix(fn.source),
      sourceSha256: oracle.sourceSha,
      artifactPath: toPosix(fn.artifact),
      // Provenance apenas: rebuilds de código alheio mudam o hash sem mudar
      // comportamento — o check valida comportamento, não este hash.
      artifactSha256: oracle.artifactSha,
    },
    corpus: { path: toPosix(fn.corpus), sha256: corpusSha, cases: casesCount },
    output: { path: toPosix(fn.outJsonl), sha256: outputSha, lines: casesCount },
    // Só o major: Node 20 e 22 devem trocar golden sem divergência gratuita.
    node: { major: Number(process.versions.node.split('.')[0]) },
    // Provenance apenas: commits futuros alheios não rejeitam o check.
    git: { revision: gitRevision() },
  };
}

function generate(fn, oracle, corpus, outDir, force) {
  const outJsonl = path.join(outDir, path.basename(fn.outJsonl));
  const outManifest = path.join(outDir, path.basename(fn.outManifest));
  const jsonl = renderJsonl(corpus.cases, oracle.f);
  const existingManifest = readManifestIfExists(outManifest);
  if (existingManifest && !force && existingManifest.function?.sourceSha256 !== oracle.sourceSha) {
    fail('fonte mudou desde a última geração; regenere com --force (ou revise o corpus primeiro)');
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outJsonl, jsonl);
  const manifest = buildManifest(fn, oracle, corpus.sha, corpus.cases.length, sha256(jsonl), corpus.cases.length);
  writeFileSync(outManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  console.log(`[golden] gerado: ${toPosix(path.relative(REPO, outJsonl))} (${corpus.cases.length} linhas)`);
  console.log(`[golden] manifest: ${toPosix(path.relative(REPO, outManifest))} output=${manifest.output.sha256.slice(0, 12)}…`);
}

function readManifestIfExists(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Check: só leitura. Qualquer divergência encerra com exit 1 e motivo exato. */
function check(fn, oracle, corpus, outDir) {
  const outJsonl = path.join(outDir, path.basename(fn.outJsonl));
  const outManifest = path.join(outDir, path.basename(fn.outManifest));
  const manifest = readManifestIfExists(outManifest);
  if (!manifest) fail(`manifest ausente ou ilegível: ${outManifest}`);
  if (manifest.format !== MANIFEST_FORMAT) fail(`formato de manifest desconhecido: ${manifest.format}`);
  if (!Array.isArray(manifest.registry) || manifest.registry.join(',') !== fn.id) {
    fail(`registry do manifest diverge do esperado: ${JSON.stringify(manifest.registry)}`);
  }
  let committed;
  try {
    committed = readFileSync(outJsonl);
  } catch {
    fail(`golden ausente: ${outJsonl}`);
  }
  if (committed.length === 0 || !committed.toString('utf8').trim()) {
    fail('golden vazio: nunca aceitar saída zero-linhas');
  }
  if (manifest.output?.sha256 !== sha256(committed)) {
    fail('golden divergiu do manifest (arquivo alterado fora do gerador)');
  }
  const recomputed = renderJsonl(corpus.cases, oracle.f);
  if (!committed.equals(recomputed)) {
    fail('comportamento do dist divergiu do golden (comparação caso a caso falhou)');
  }
  if (manifest.corpus?.sha256 !== corpus.sha) {
    fail('corpus mudou desde a geração (hash diverge do manifest)');
  }
  if (manifest.function?.sourceSha256 !== oracle.sourceSha) {
    fail('fonte mudou desde a geração; regenere o golden');
  }
  const lines = committed.toString('utf8').trimEnd().split('\n');
  if (lines.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${lines.length} corpus=${corpus.cases.length} manifest=${manifest.output?.lines}`);
  }
  // node.major e git.revision são provenance: deliberadamente NÃO comparados.
  console.log(`[golden] OK: ${toPosix(path.relative(REPO, outJsonl))} (${lines.length} casos batem com o dist vivo)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fn = FUNCTIONS[args.fn];
  if (!fn) fail(`--fn desconhecido: ${args.fn} (válidos: ${Object.keys(FUNCTIONS).join(', ')})`);
  const oracle = await loadOracle(fn);
  const corpus = loadCorpus(resolveCliPath(args.corpus, fn.corpus));
  const outDir = resolveCliPath(args.out, path.dirname(fn.outJsonl));
  if (args.check) {
    check(fn, oracle, corpus, outDir);
  } else {
    generate(fn, oracle, corpus, outDir, args.force);
  }
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
