import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// De dist/test/ a raiz do repositório fica dois níveis acima.
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/**
 * Catraca do corte do Chupim: os fontes TS abaixo já estão cobertos pelo
 * autofetch nativo (Rust) e vão ser REMOVIDOS do lado TS. Enquanto a remoção
 * não acontece, cada um deles continua importável — e um importador novo é a
 * forma silenciosa de o corte falhar: o arquivo ganha um consumidor de
 * produção, a wave de remoção o apaga e o import quebra o boot, ou pior, ele
 * sobrevive como fantasma de um caminho que o nativo já faz.
 *
 * Por isso o conjunto de arestas (quem importa quem) é CONGELADO aqui. O teste
 * não proíbe que arestas desapareçam — é exatamente o que o corte faz —, mas
 * reprova QUALQUER aresta que apareça e não esteja nesta tabela, listando na
 * mensagem tudo o que a varredura encontrou para o conserto ser direto.
 *
 * Só entram arquivos que a varredura de hoje realmente vê em disco; a fonte da
 * verdade da lista medida é o checklist do corte (o nativo é quem manda).
 */
const NATIVE_COVERED = [
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
  'src/debrid/alldebrid-fallback-evict.ts',
];

/**
 * Baseline medido antes do corte: alvo -> importadores autorizados hoje.
 *
 * As arestas dentro da família autofetch-* morrem junto com os arquivos. As
 * arestas de fora são as únicas que o corte precisa reescrever à mão:
 *  - `src/routes/internal-search-effects.ts` é o fallback de produção
 *    (enqueue, batch, sonda BR, season key) e fica até o flip;
 *  - `src/routes/services.ts` + `src/routes/types.ts` são o registro de
 *    serviços (status do runner no painel);
 *  - `src/providers/index.ts` publica o status do runner pelo providers/;
 *  - `src/providers/autofetch-chupim-trace.ts` lê o estado da sonda BR;
 *  - `src/debrid/alldebrid.ts` reexporta o evict de fallback do AL.
 */
const ALLOWED_IMPORTERS: Record<string, string[]> = {
  'src/providers/autofetch-runner.ts': [
    'src/providers/autofetch-batch.ts',
    'src/providers/index.ts',
    'src/routes/internal-search-effects.ts',
    'src/routes/services.ts',
    'src/routes/types.ts',
  ],
  'src/providers/autofetch-candidates.ts': [
    'src/providers/autofetch-drain.ts',
    'src/providers/autofetch-runner.ts',
  ],
  'src/providers/autofetch-batch.ts': ['src/routes/internal-search-effects.ts'],
  'src/providers/autofetch-drain.ts': ['src/providers/autofetch-recheck.ts'],
  'src/providers/autofetch-recheck.ts': ['src/providers/autofetch-runner.ts'],
  'src/providers/autofetch-settle.ts': ['src/providers/autofetch-recheck.ts'],
  'src/providers/autofetch-expired.ts': ['src/providers/autofetch-recheck.ts'],
  'src/providers/autofetch-terminal.ts': ['src/providers/autofetch-recheck.ts'],
  'src/providers/autofetch-index.ts': [
    'src/providers/autofetch-recheck.ts',
    'src/providers/autofetch-runner.ts',
  ],
  'src/providers/autofetch-lot-state.ts': ['src/providers/autofetch-recheck.ts'],
  'src/providers/autofetch-progress.ts': [
    'src/providers/autofetch-recheck.ts',
    'src/providers/autofetch-settle.ts',
    'src/providers/autofetch-terminal.ts',
  ],
  'src/providers/autofetch-season-index.ts': [
    'src/providers/autofetch-recheck.ts',
    'src/routes/internal-search-effects.ts',
  ],
  'src/providers/autofetch-seeds-pool.ts': [
    'src/providers/autofetch-candidates.ts',
    'src/providers/autofetch-runner.ts',
  ],
  'src/providers/autofetch-policy.ts': [
    'src/providers/autofetch-candidates.ts',
    'src/providers/autofetch-drain.ts',
    'src/providers/autofetch-fallback.ts',
    'src/providers/autofetch-seeds-pool.ts',
  ],
  'src/providers/autofetch-gates.ts': [
    'src/providers/autofetch-candidates.ts',
    'src/providers/autofetch-drain.ts',
    'src/providers/autofetch-runner.ts',
  ],
  'src/providers/autofetch-fallback.ts': ['src/providers/autofetch-candidates.ts'],
  'src/providers/br-probe.ts': [
    'src/providers/autofetch-candidates.ts',
    'src/providers/autofetch-chupim-trace.ts',
    'src/providers/autofetch-drain.ts',
    'src/providers/autofetch-runner.ts',
    'src/routes/internal-search-effects.ts',
  ],
  'src/debrid/alldebrid-fallback-evict.ts': ['src/debrid/alldebrid.ts'],
};

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

describe('corte do Chupim: ninguém novo importa os fontes que o nativo já cobre', () => {
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

  test('as arestas de hoje estão no baseline; a varredura enxerga src/ de verdade', () => {
    const files = walkTs(SRC);
    assert.ok(files.length > 100, `varredura de src/ acha pouco: ${files.length} arquivo(s)`);

    const found: { target: string; importer: string; line: number }[] = [];
    for (const file of files) {
      const importer = toRepoPath(file);
      for (const { spec, line } of parseSpecifiers(fs.readFileSync(file, 'utf8'))) {
        const target = resolveToSource(spec, file);
        if (target === null || !NATIVE_COVERED.includes(target)) continue;
        found.push({ target, importer, line });
      }
    }

    const unexpected = found.filter(
      (edge) => !(ALLOWED_IMPORTERS[edge.target] ?? []).includes(edge.importer),
    );

    // A mensagem carrega a varredura inteira: sem isso, a reprovação vira
    // adivinhação sobre qual importador apareceu.
    const relatorio = found
      .map((edge) => {
        const ok = (ALLOWED_IMPORTERS[edge.target] ?? []).includes(edge.importer);
        return `  ${ok ? 'ok  ' : 'NOVO'} ${edge.importer}:${edge.line} -> ${edge.target}`;
      })
      .join('\n');

    assert.deepEqual(
      unexpected.map((edge) => `${edge.importer}:${edge.line} -> ${edge.target}`),
      [],
      `importador novo de fonte que o nativo já cobre (o corte vai apagar o alvo).\n`
        + `Arestas medidas hoje:\n${relatorio}`,
    );
  });

  test('a tabela de baseline cobre exatamente a lista do corte', () => {
    assert.equal(new Set(NATIVE_COVERED).size, NATIVE_COVERED.length, 'lista do corte com repetição');
    assert.deepEqual(Object.keys(ALLOWED_IMPORTERS).sort(), [...NATIVE_COVERED].sort());
    for (const [target, importers] of Object.entries(ALLOWED_IMPORTERS)) {
      assert.equal(new Set(importers).size, importers.length, `${target}: importador repetido`);
    }
  });
});
