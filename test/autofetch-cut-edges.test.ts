import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// De dist/test/ a raiz do repositório fica dois níveis acima.
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const TESTS = path.join(ROOT, 'test');

/** Este arquivo cita os 19 nomes de propósito, como STRING: a varredura o pula. */
const SELF = 'test/autofetch-cut-edges.test.ts';
/** Ponte congelada do oráculo: reproduz o contrato, não consome o que saiu. */
const ORACLE_BRIDGE = 'test/helpers/pipeline-oracle/autofetch-bridge.ts';

/**
 * Catraca de AUSÊNCIA do corte do Chupim (leva B4, 2026-10-28).
 *
 * O corpo TS do autofetch saiu de `src/`: quem executa o lote, a fila, o
 * recheck, a sonda e o dreno é o worker NATIVO do gateway. Os arquivos abaixo
 * foram apagados — e apagar é o contrato, não o subproduto. Se um deles voltar
 * ao disco, é REGRESSÃO DE ARQUITETURA e não conveniência local: o Node vira
 * dono duplicado do mesmo lote (o canal nativo não devolve trabalho: `Deferred`
 * só existe antes do `submit`), e o caminho morto passa a ter consumidor de
 * produção outra vez.
 *
 * Por isso a lista é literal e congelada: a catraca prova o que NÃO existe e o
 * que NÃO é importado, em vez de medir arestas de um grafo que já não deve ter
 * nós. A fronteira que continua do Node tem o próprio teste, logo abaixo.
 *
 * Fonte da verdade da lista: o checklist do corte (o nativo é quem manda). Um
 * nome a mais aqui reprova; um nome a menos é corte pela metade.
 */
const CUT_SOURCES = [
  'src/providers/autofetch-runner.ts',
  'src/providers/autofetch-candidates.ts',
  'src/providers/autofetch-batch.ts',
  'src/providers/autofetch-drain.ts',
  'src/providers/autofetch-recheck.ts',
  'src/providers/autofetch-settle.ts',
  'src/providers/autofetch-expired.ts',
  'src/providers/autofetch-terminal.ts',
  'src/providers/autofetch-index.ts',
  'src/providers/autofetch-lot-state.ts',
  'src/providers/autofetch-progress.ts',
  'src/providers/autofetch-season-index.ts',
  'src/providers/autofetch-seeds-pool.ts',
  'src/providers/autofetch-policy.ts',
  'src/providers/autofetch-gates.ts',
  'src/providers/autofetch-fallback.ts',
  'src/providers/br-probe.ts',
  'src/providers/autofetch-chupim-trace.ts',
  'src/debrid/alldebrid-fallback-evict.ts',
];

/**
 * Os GERADORES de golden que mediam esses módulos. Cada um pedia
 * `requireFreshDist(ARTIFACT, DIST_SOURCES)` sobre uma fonte que o corte apagou:
 * `golden-kit.mjs:98-110` reprova com `fonte ausente`, então o dump nem roda
 * "para conferir". O perigo não é o erro — é o dump ressuscitado passar verde
 * contra um `dist/src/providers/<nome>.js` velho que ninguém mais rebuilda:
 * falso-verde puro. Apagar o gerador NÃO apaga o contrato (ver FROZEN_GOLDENS).
 */
const CUT_SCRIPTS = [
  'scripts/golden/dump-autofetch-policy.mjs',
  'scripts/golden/dump-autofetch-progress.mjs',
  'scripts/golden/dump-autofetch-fallback.mjs',
  'scripts/golden/dump-autofetch-expired.mjs',
  'scripts/golden/dump-autofetch-gates.mjs',
  'scripts/golden/dump-autofetch-seeds-pick.mjs',
];

/**
 * O que esses dumps produziam e que continua VIVO: os testes de `adom-core`
 * leem os `.jsonl`/manifest por `include_bytes!`/`include_str!`, então o
 * artefato é CONTRATO congelado do port, não subproduto — o gerador morreu, o
 * golden ficou. Apagar junto quebra a compilação do `cargo test`; é por isso
 * que esta é a única lista do arquivo que exige PRESENÇA fora da fronteira viva.
 */
const FROZEN_GOLDENS = ['policy', 'progress', 'fallback', 'expired', 'gates', 'seeds-pick'];

/**
 * A outra metade da catraca: a fronteira VIVA. Depois do corte o Node ainda é
 * dono dos FATOS (marker com `obra`, registro F2 `obra:`, `adsub`/`adprot`,
 * `pf:`), das pontes e do painel — e o nativo só LÊ parte disso. Uma limpeza
 * futura que leve um destes junto deixa o nativo sem o registro que ele
 * consulta (apagar `autofetch-obra.ts`, por exemplo, degrada a evicção para
 * `evict-no-record`), então cada item é um `assert.ok` com o papel declarado.
 */
const LIVE_BOUNDARY: { file: string; role: string }[] = [
  { file: 'src/providers/autofetch.ts', role: 'reindexação no boot, markerActive do marker e isDeadQuiet do trace' },
  { file: 'src/providers/autofetch-obra.ts', role: 'prefixo `autofetch:v3:o:` do registro F2 (teto, reserva e registro são nativos desde a leva 6e)' },
  { file: 'src/providers/autofetch-obra-summary.ts', role: 'leitura quieta do registro por obra para o painel' },
  { file: 'src/providers/autofetch-marker.ts', role: 'chave e valor do marker no KV nativo' },
  { file: 'src/providers/autofetch-gate.ts', role: 'gate de ocupação da conta (memo + snapshot)' },
  { file: 'src/providers/autofetch-keys.ts', role: 'chaves folha (blacklist/marker) sem ciclo de debrid' },
  { file: 'src/providers/autofetch-suppressed.ts', role: 'fila `sup:` do que a remoção automática deixou de apagar' },
  { file: 'src/providers/autofetch-evict.ts', role: 'leitura da evidência `er:` de BR ready por obra para o painel (a política e o executor são nativos)' },
  { file: 'src/utils/rust-autofetch.ts', role: 'decisão do lote no núcleo (`decideAutofetch`)' },
  { file: 'src/utils/autofetch-native.ts', role: 'ponte da admin do gateway (estado/pausa/dreno do worker)' },
];

// Comentário fora: um `import` comentado não é caminho de produção e não pode
// virar reprovação. Bloco primeiro, senão o `//` de dentro dele sobra.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[;})\]])\s*\/\/[^\n]*/g, '$1');
}

/** Specifiers de import/export/re-export/import dinâmico/require, com a linha. */
export function parseSpecifiers(text: string): { spec: string; line: number }[] {
  const clean = stripComments(text);
  const out: { spec: string; line: number }[] = [];
  const patterns = [
    /(?:^|[^.\w$])(?:import|export)\s+(?:type\s+)?[^'";]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /(?:^|[^.\w$])import\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of clean.matchAll(re)) {
      const spec = match[1];
      const at = (match.index ?? 0) + match[0].lastIndexOf(spec);
      out.push({ spec, line: clean.slice(0, at).split('\n').length });
    }
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function toRepoPath(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** Resolve um specifier relativo para o .ts real em `src/` (ou null). */
function resolveToSource(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return toRepoPath(candidate);
  }
  return null;
}

/** Identidade do módulo sem extensão — é o que a catraca compara. */
function moduleId(repoPath: string): string {
  return repoPath.replace(/\.ts$/, '');
}

const CUT_IDS = new Set(CUT_SOURCES.map(moduleId));

/**
 * Alvo de um specifier relativo, MESMO que o arquivo não exista mais: é
 * exatamente o caso que a catraca precisa ver. `resolveToSource` continua tendo
 * a palavra final quando o alvo está em disco; sem ele, aplica a mesma regra de
 * candidatos (`.js` -> `.ts`) sobre o caminho conceitual.
 */
function resolveToModuleId(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const real = resolveToSource(spec, fromFile);
  if (real) return moduleId(real);
  const base = path.resolve(path.dirname(fromFile), spec);
  return moduleId(toRepoPath(base.replace(/\.js$/, '')));
}

/** Varre uma árvore e devolve cada import com o alvo resolvido. */
function scanImports(dir: string): {
  files: number;
  resolved: number;
  hits: { importer: string; line: number; target: string }[];
} {
  const files = walkTs(dir);
  let resolved = 0;
  const hits: { importer: string; line: number; target: string }[] = [];
  for (const file of files) {
    const importer = toRepoPath(file);
    for (const { spec, line } of parseSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const target = resolveToModuleId(spec, file);
      if (target === null) continue;
      resolved += 1;
      if (CUT_IDS.has(target)) hits.push({ importer, line, target: `${target}.ts` });
    }
  }
  return { files: files.length, resolved, hits };
}

function report(hits: { importer: string; line: number; target: string }[]): string {
  return hits.map((hit) => `  ${hit.importer}:${hit.line} -> ${hit.target}`).join('\n');
}

describe('corte do Chupim: o corpo TS saiu e não volta por conveniência', () => {
  test('o parser enxerga static, type, side-effect, dynamic e require', () => {
    const fonte = [
      "import { a } from './a.js';",
      "import type { B } from './b.js';",
      "import './efeito.js';",
      "export { c } from './c.js';",
      "const d = await import('./d.js');",
      "const e = require('./e.js');",
      "// import { f } from './f.js';",
      "/* import { g } from './g.js'; */",
    ].join('\n');
    const specs = parseSpecifiers(fonte).map((hit: { spec: string }) => hit.spec);
    assert.deepEqual(specs.sort(), ['./a.js', './b.js', './c.js', './d.js', './e.js', './efeito.js']);
  });

  test('nenhum dos 19 caminhos do corte existe em disco', () => {
    assert.equal(CUT_SOURCES.length, 19, 'a lista do corte não encolhe: nome a menos é corte pela metade');
    assert.equal(new Set(CUT_SOURCES).size, CUT_SOURCES.length, 'lista do corte com repetição');

    const alive = CUT_SOURCES.filter((file) => fs.existsSync(path.join(ROOT, file)));
    assert.equal(
      alive.length,
      0,
      `fonte do corte de volta ao disco:\n${alive.map((f) => `  ${f}`).join('\n')}\n`
        + 'Isto é REGRESSÃO DE ARQUITETURA, não conveniência local: o trabalho do '
        + 'Chupim é do worker nativo do gateway e um segundo dono do mesmo lote '
        + 'não tem rollback por env — só por commit/imagem anterior.',
    );
  });

  test('nenhum .ts de src/ importa um dos 19 (nem por re-export ou import dinâmico)', () => {
    const { files, resolved, hits } = scanImports(SRC);
    // Guardas de varredura: sem elas a catraca fica verde por não ter olhado nada.
    assert.ok(files > 100, `varredura de src/ acha pouco: ${files} arquivo(s)`);
    assert.ok(resolved > 100, `a varredura não resolveu specifier relativo algum: ${resolved}`);

    assert.equal(
      hits.length,
      0,
      `importador de fonte que o corte apagou:\n${report(hits)}\n`
        + 'O import não quebra hoje só porque o alvo saiu do disco depois; ele '
        + 'quebraria o boot no primeiro `tsc`. Troque pelo equivalente vivo '
        + '(`src/utils/rust-autofetch.ts`, `src/providers/autofetch.ts`) ou '
        + 'remova o caminho.',
    );
  });

  test('a fronteira viva continua viva e exportando (o Node ainda é dono dela)', () => {
    assert.equal(
      new Set(LIVE_BOUNDARY.map((item) => item.file)).size,
      LIVE_BOUNDARY.length,
      'fronteira viva com repetição',
    );
    const live = new Set(LIVE_BOUNDARY.map((item) => item.file));
    assert.equal(CUT_SOURCES.filter((file) => live.has(file)).length, 0, 'arquivo nos dois lados da catraca');

    for (const { file, role } of LIVE_BOUNDARY) {
      const full = path.join(ROOT, file);
      assert.ok(fs.existsSync(full), `${file} sumiu — é ${role}; o corte levou junto o que ainda é do Node`);
      assert.ok(/export\s/.test(fs.readFileSync(full, 'utf8')), `${file} existe mas não exporta nada — é ${role}`);
    }
    // A ponte do oráculo não pode virar consumidora: ela REPRODUZ o contrato.
    assert.ok(fs.existsSync(path.join(ROOT, ORACLE_BRIDGE)), `ponte do oráculo sumiu: ${ORACLE_BRIDGE}`);
  });

  test('a rota de efeitos não executa mais os kinds nativos (texto, não comportamento)', () => {
    const file = path.join(ROOT, 'src/routes/internal-search-effects.ts');
    const text = fs.readFileSync(file, 'utf8');
    // Texto SEM comentário: a prosa da rota ainda cita os módulos apagados ao
    // explicar o que saiu, e prosa não é caminho de execução. `parseSpecifiers`
    // usa a mesma poda — o import de um deles continua reprovando.
    const code = stripComments(text);

    for (const dead of ['autofetch-runner', 'autofetch-batch', 'br-probe', 'autofetch-season-index']) {
      assert.equal(
        code.includes(dead),
        false,
        `a rota de efeitos voltou a referenciar ${dead} em código — a leva B4 tirou o executor daqui`,
      );
    }

    const setLiteral = code.match(/const NATIVE_ONLY_KINDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(setLiteral, 'NATIVE_ONLY_KINDS sumiu: o lote do gateway deixa de ser contado em nativeOnly');
    const nativeKinds = [...setLiteral[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      nativeKinds,
      ['autofetch', 'autofetch_batch', 'br_probe', 'rd_warmer', 'season_key'],
      'NATIVE_ONLY_KINDS tem que conter os quatro kinds do worker nativo do Chupim e o warmer RD',
    );

    const runEffect = code.match(/function runEffect\(([\s\S]*?)\n\}/);
    assert.ok(runEffect, 'runEffect sumiu: a rota não enfileira mais nada');
    const runnable = [...runEffect[1].matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      runnable,
      ['harvester_enqueue'],
      'a rota executa só harvester_enqueue; rd_warmer e kind de trabalho aceito aqui é dono duplicado',
    );
  });

  test('nenhum teste importa os 19 (a ponte do oráculo inclusive)', () => {
    const { files, resolved, hits } = scanImports(TESTS);
    assert.ok(files > 50, `varredura de test/ acha pouco: ${files} arquivo(s)`);
    assert.ok(resolved > 50, `a varredura de test/ não resolveu specifier relativo algum: ${resolved}`);

    // O próprio arquivo cita os nomes como STRING (a lista do corte); string não
    // é import, mas tirá-lo da varredura evita depender de sorte do parser.
    const offenders = hits.filter((hit) => hit.importer !== SELF);
    assert.equal(
      offenders.length,
      0,
      `teste (ou helper) importa fonte apagada pelo corte:\n${report(offenders)}\n`
        + 'A ponte do oráculo é a única do diretório que fala de Chupim, e ela '
        + 'não importa nenhum dos 19 — importar é consumir o que saiu.',
    );
  });

  test('nenhum dump de golden dos módulos apagados voltou ao disco', () => {
    assert.equal(CUT_SCRIPTS.length, 6, 'a lista é literal: foram 6 dumps medindo os módulos do corte');

    const alive = CUT_SCRIPTS.filter((file) => fs.existsSync(path.join(ROOT, file)));
    assert.equal(
      alive.length,
      0,
      `dump de golden de volta ao disco:\n${alive.map((f) => `  ${f}`).join('\n')}\n`
        + 'A fonte que ele mede não existe mais: o `--check` reprova em `fonte ausente` e um '
        + '`--force` mediria um `dist/` que ninguém rebuilda. Gerador morto que “passa” é '
        + 'falso-verde contra lixo.',
    );
  });

  test('nenhum registro vivo (npm ou CI) chama um dump apagado', () => {
    const registry = [path.join(ROOT, 'package.json')];
    const wf = path.join(ROOT, '.github', 'workflows');
    if (fs.existsSync(wf)) {
      for (const entry of fs.readdirSync(wf)) {
        if (/\.ya?ml$/.test(entry)) registry.push(path.join(wf, entry));
      }
    }
    // Guarda de varredura: sem o CI na lista o teste ficaria verde por não olhar nada.
    assert.ok(registry.length > 1, `registro lido de menos: ${registry.length} arquivo(s)`);

    const offenders: string[] = [];
    for (const file of registry) {
      const text = fs.readFileSync(file, 'utf8');
      for (const script of CUT_SCRIPTS) {
        const name = path.basename(script);
        if (text.includes(name)) offenders.push(`${toRepoPath(file)} -> ${name}`);
      }
    }
    assert.equal(
      offenders.length,
      0,
      `registro vivo aponta para dump apagado:\n  ${offenders.join('\n  ')}\n`
        + 'Script de npm ou passo de CI que não roda mais é a mesma categoria do import morto.',
    );
  });

  test('os 6 goldens congelados continuam no disco (o Rust os inclui em compilação)', () => {
    assert.equal(FROZEN_GOLDENS.length, CUT_SCRIPTS.length, 'um golden congelado por gerador apagado');

    for (const name of FROZEN_GOLDENS) {
      for (const ext of ['.jsonl', '.manifest.json']) {
        const rel = `rust/golden/autofetch-${name}${ext}`;
        const full = path.join(ROOT, rel);
        assert.ok(
          fs.existsSync(full),
          `${rel} sumiu: \`rust/crates/adom-core/tests/autofetch_*_golden.rs\` o inclui por `
            + '`include_bytes!`/`include_str!` e o crate deixa de compilar. O gerador morreu, o '
            + 'contrato ficou.',
        );
        assert.ok(fs.statSync(full).size > 0, `${rel} está vazio`);
      }
    }
  });
});
