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
  // Comportamento das regex de vocabulário: `yr=` é YEAR_RANGE.test(entrada) e
  // `ep=` é EPISODE_TOKEN.test(entrada), 1 ou 0. O porte Rust precisa reproduzir
  // esses dois bits para cada entrada do corpus.
  'matching-vocabulary-regex': {
    id: 'matching-vocabulary/regex',
    name: 'vocabularyRegex',
    source: 'src/utils/matching-vocabulary.ts',
    artifact: 'dist/src/utils/matching-vocabulary.js',
    corpus: 'scripts/golden/corpus-matching-vocabulary-regex.json',
    outJsonl: 'rust/golden/matching-vocabulary-regex.jsonl',
    outManifest: 'rust/golden/matching-vocabulary-regex.manifest.json',
    resolve: (mod) => (input) => {
      const yr = mod.YEAR_RANGE.test(input) ? 1 : 0;
      const ep = mod.EPISODE_TOKEN.test(input) ? 1 : 0;
      return `yr=${yr} ep=${ep}`;
    },
  },
  // Funções de tokens que dependem só de texto/tokens. Saída por entrada, em
  // campos fixos: seq (marcadores de sequência, ordenados), epi (trecho da obra
  // numa release por episódio; `-` para null, vazio para lista vazia), first
  // (primeiro token que nomeia a obra; `-` para undefined), nn e nl (por token:
  // 1 se isNonNamingToken / isNonLatinToken). O oracle chama titleTokens para
  // gerar a entrada de episodeWorkTokens, como o código de produção.
  'matching-tokens-text': {
    id: 'matching-tokens/text',
    name: 'matchingTokensText',
    source: 'src/utils/matching-tokens.ts',
    artifact: 'dist/src/utils/matching-tokens.js',
    corpus: 'scripts/golden/corpus-matching-tokens-text.json',
    outJsonl: 'rust/golden/matching-tokens-text.jsonl',
    outManifest: 'rust/golden/matching-tokens-text.manifest.json',
    resolve: async (mod) => {
      const vocab = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/matching-vocabulary.js')).href);
      return (input) => {
        const tokens = vocab.titleTokens(input);
        const seq = [...mod.extractSequenceMarkers(input)].map(String).sort().join(',');
        const epiRaw = mod.episodeWorkTokens(tokens);
        const epi = epiRaw === null ? '-' : epiRaw.join(' ');
        const first = mod.firstWorkToken(tokens) ?? '-';
        const unm = mod.firstUnmarkedToken(tokens) ?? '-';
        const nn = tokens.map((t) => (mod.isNonNamingToken(t) ? 1 : 0)).join('');
        const nl = tokens.map((t) => (mod.isNonLatinToken(t) ? 1 : 0)).join('');
        return `seq=${seq} epi=${epi} first=${first} unm=${unm} nn=${nn} nl=${nl}`;
      };
    },
  },
  // Varredura exaustiva da classe de LATIN_LETTER_RE (`[\p{Script=Latin}\p{M}]`):
  // um único caso cuja saída lista, em hexadecimal, os intervalos de code points
  // que casam. Cobre todo o Unicode, então o porte Rust é provado código a código
  // (e não só por exemplos), o que importa porque as tabelas Unicode diferem
  // entre Node (17) e o crate regex.
  'matching-latin-ranges': {
    id: 'matching-latin-ranges/codepoints',
    name: 'matchingLatinRanges',
    source: 'src/utils/matching-tokens.ts',
    artifact: 'dist/src/utils/matching-tokens.js',
    corpus: 'scripts/golden/corpus-matching-latin-ranges.json',
    outJsonl: 'rust/golden/matching-latin-ranges.jsonl',
    outManifest: 'rust/golden/matching-latin-ranges.manifest.json',
    resolve: (mod) => () => {
      const ranges = [];
      let start = -1;
      for (let cp = 0; cp <= 0x10ffff; cp += 1) {
        // Surrogates não formam string UTF-8 válida: não entram na varredura.
        const inRange = cp >= 0xd800 && cp <= 0xdfff ? false : !mod.isNonLatinToken(String.fromCodePoint(cp));
        if (inRange && start < 0) start = cp;
        if (!inRange && start >= 0) {
          ranges.push(start === cp - 1 ? start.toString(16) : `${start.toString(16)}-${(cp - 1).toString(16)}`);
          start = -1;
        }
      }
      if (start >= 0) ranges.push(`${start.toString(16)}-10ffff`);
      return ranges.join(' ');
    },
  },
  // Decisões de matching-tokens que pedem mais que texto: cada entrada é um JSON
  // com `op` (qual função) e os argumentos. A saída é um valor só: número
  // (precisão), `1`/`0` (booleano) ou o token (`-` para undefined).
  'matching-tokens-decisions': {
    id: 'matching-tokens/decisions',
    name: 'matchingTokensDecisions',
    source: 'src/utils/matching-tokens.ts',
    artifact: 'dist/src/utils/matching-tokens.js',
    corpus: 'scripts/golden/corpus-matching-tokens-decisions.json',
    outJsonl: 'rust/golden/matching-tokens-decisions.jsonl',
    outManifest: 'rust/golden/matching-tokens-decisions.manifest.json',
    resolve: (mod) => (input) => {
      const c = JSON.parse(input);
      const bit = (v) => (v ? '1' : '0');
      switch (c.op) {
        case 'precision':
          return String(mod.titlePrecision(c.tokens, c.wanted, { cutTail: c.cutTail !== false }));
        case 'year':
          return bit(mod.yearContradicts(c.tokens, c.year, c.series));
        case 'sequel':
          return bit(mod.namedSequelContradicts(c.tokens, c.universe, c.catalogYear));
        case 'liveAction':
          return bit(mod.liveActionYearContradicts(c.text, c.premiereYear));
        case 'adaptation':
          return bit(mod.adaptationIdentityContradicts(c.request, c.text, c.year));
        case 'first':
          return mod.firstSignificantToken(c.tokens) ?? '-';
        default:
          throw new Error(`op desconhecida: ${c.op}`);
      }
    },
  },
  // short-name-tail.ts: `1`/`0` para shortNameTailContradicts.
  'short-name-tail': {
    id: 'short-name-tail/shortNameTailContradicts',
    name: 'shortNameTailContradicts',
    source: 'src/utils/short-name-tail.ts',
    artifact: 'dist/src/utils/short-name-tail.js',
    corpus: 'scripts/golden/corpus-short-name-tail.json',
    outJsonl: 'rust/golden/short-name-tail.jsonl',
    outManifest: 'rust/golden/short-name-tail.manifest.json',
    resolve: (mod) => (input) => {
      const c = JSON.parse(input);
      return mod.shortNameTailContradicts(c.tokens, c.check, new Set(c.universe)) ? '1' : '0';
    },
  },
  // catalog-year.ts: ano em texto (ou `null`) para catalogYearOf (op catalog) e
  // ano alternativo (ou `null`) para catalogAltYearOf (op alt).
  'catalog-year': {
    id: 'catalog-year/catalogYear',
    name: 'catalogYear',
    source: 'src/utils/catalog-year.ts',
    artifact: 'dist/src/utils/catalog-year.js',
    corpus: 'scripts/golden/corpus-catalog-year.json',
    outJsonl: 'rust/golden/catalog-year.jsonl',
    outManifest: 'rust/golden/catalog-year.manifest.json',
    resolve: (mod) => (input) => {
      const c = JSON.parse(input);
      const out = c.op === 'alt'
        ? mod.catalogAltYearOf(c.meta, c.tmdb)
        : mod.catalogYearOf(c.meta, c.tmdb);
      return out === null || out === undefined ? 'null' : String(out);
    },
  },
  // br-origin.ts: `pt=` é hasPtSigns(título) e `origin=` é brOriginMark(título).
  // Predicados do caminho destrutivo da limpeza; o porte precisa ser exato.
  'br-origin': {
    id: 'br-origin/predicates',
    name: 'brOrigin',
    source: 'src/utils/br-origin.ts',
    artifact: 'dist/src/utils/br-origin.js',
    corpus: 'scripts/golden/corpus-br-origin.json',
    outJsonl: 'rust/golden/br-origin.jsonl',
    outManifest: 'rust/golden/br-origin.manifest.json',
    resolve: (mod) => (input) => {
      const pt = mod.hasPtSigns(input) ? 1 : 0;
      const origin = mod.brOriginMark(input) ? 1 : 0;
      return `pt=${pt} origin=${origin}`;
    },
  },
  // magnet-uri.ts: sanitize (uri, hash), default (hash) e info (text, via
  // extractInfoHash de title-normalization.ts). `null` vira a palavra null.
  'magnet-uri': {
    id: 'magnet-uri/sanitize',
    name: 'magnetUri',
    source: 'src/utils/magnet-uri.ts',
    artifact: 'dist/src/utils/magnet-uri.js',
    corpus: 'scripts/golden/corpus-magnet-uri.json',
    outJsonl: 'rust/golden/magnet-uri.jsonl',
    outManifest: 'rust/golden/magnet-uri.manifest.json',
    resolve: async (mod) => {
      const tn = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/title-normalization.js')).href);
      return (input) => {
        const c = JSON.parse(input);
        switch (c.op) {
          case 'info':
            return tn.extractInfoHash(c.text) ?? 'null';
          case 'default':
            return mod.defaultMagnet(c.hash);
          case 'sanitize':
            return mod.sanitizeMagnet(c.uri, c.hash) ?? 'null';
          default:
            throw new Error(`op desconhecida: ${c.op}`);
        }
      };
    },
  },
  // franchise-base.ts (guardas) e os helpers de release-name-matching.ts que
  // elas usam. Entrada JSON com `op`: base, extension, coverage (lista de tokens)
  // ou multiWork (1/0).
  'franchise': {
    id: 'franchise/guards',
    name: 'franchiseGuards',
    source: 'src/utils/franchise-base.ts',
    artifact: 'dist/src/utils/franchise-base.js',
    corpus: 'scripts/golden/corpus-franchise.json',
    outJsonl: 'rust/golden/franchise.jsonl',
    outManifest: 'rust/golden/franchise.manifest.json',
    resolve: async () => {
      const fb = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/franchise-base.js')).href);
      const rnm = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/release-name-matching.js')).href);
      return (input) => {
        const c = JSON.parse(input);
        const bit = (v) => (v ? '1' : '0');
        switch (c.op) {
          case 'base':
            return bit(fb.franchiseBaseContradicts(c.title, c.own ?? null, c.name, c.year));
          case 'extension':
            return bit(fb.franchiseExtensionContradicts(c.title, c.own ?? null, c.name, c.allNames, c.year));
          case 'coverage':
            return rnm.nameCoverageTokens(c.name).join(' ');
          case 'multiWork':
            return bit(rnm.isMultiWorkCollection(c.title));
          default:
            throw new Error(`op desconhecida: ${c.op}`);
        }
      };
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
  const raw = fn.resolve ? await fn.resolve(mod) : mod[fn.exportName ?? fn.name];
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
