/**
 * Teste de GRAFO do gancho shadow da pergunta 2 (`is_dub_lie`) no play:
 *   1. `enqueueDubLieJudgment` é chamado a partir de EXATAMENTE UM arquivo em
 *      `src/` fora de `src/ai/` — `src/debrid/audio-audit.ts` (o tail audit).
 *      Um segundo produtor mudaria a fronteira de custo/observabilidade sem
 *      revisão;
 *   2. os CINCO adapters e o `src/providers/dub-audit.ts` NÃO importam
 *      `src/ai/` de forma nenhuma — eles só repassam um CAMPO de PlayHint
 *      (`dubLieShadow`); nenhuma IA no caminho do debrid além do audit;
 *   3. `src/debrid/audio-audit.ts` importa SOMENTE a fachada `../ai/index.js`
 *      (a string exata que o teste de grafo geral permite).
 *
 * Varre a FONTE (não o dist): gates de arquitetura valem antes do build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('raiz do repo não encontrada a partir do teste');
}

const ROOT = repoRoot();

function walkTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walkTs(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

// Cobre import estático e dinâmico, com a mesma regex do grafo geral.
const AI_IMPORT = /(?:from\s*|import\s*\(\s*)['"][^'"]*\/ai\//;
const AI_IMPORT_ALL = /(?:from\s*|import\s*\(\s*)['"]([^'"]*\/ai\/[^'"]*)['"]/g;

// Consumidores do campo (repasse passivo de PlayHint) — zero import de IA.
const HINT_PASSTHROUGH = [
  'src/debrid/alldebrid-play.ts',
  'src/debrid/realdebrid-play.ts',
  'src/debrid/torbox.ts',
  'src/debrid/debridlink.ts',
  'src/debrid/premiumize.ts',
  'src/providers/dub-audit.ts',
];

test('grafo dub-lie: o enqueue é chamado de exatamente um arquivo fora de src/ai/', () => {
  const aiDir = join(ROOT, 'src', 'ai');
  const chamadores = walkTs(join(ROOT, 'src'))
    .filter((f) => !f.startsWith(aiDir))
    .filter((f) => readFileSync(f, 'utf8').includes('enqueueDubLieJudgment'))
    .map((f) => relative(ROOT, f).split('\\').join('/'));
  assert.deepEqual(
    chamadores,
    ['src/debrid/audio-audit.ts'],
    'enqueueDubLieJudgment deve ser chamado só pelo tail audit (audio-audit)',
  );
});

test('grafo dub-lie: adapters e dub-audit NÃO importam src/ai/ (só repassam o campo)', () => {
  const violacoes: string[] = [];
  for (const rel of HINT_PASSTHROUGH) {
    const full = join(ROOT, rel);
    assert.ok(existsSync(full), `arquivo de referência existe: ${rel}`);
    if (AI_IMPORT.test(readFileSync(full, 'utf8'))) violacoes.push(rel);
  }
  assert.deepEqual(
    violacoes,
    [],
    `consumidores do hint importando src/ai/: ${violacoes.join(', ')}`,
  );
});

test('grafo dub-lie: audio-audit importa SOMENTE a fachada ../ai/index.js', () => {
  const conteudo = readFileSync(join(ROOT, 'src', 'debrid', 'audio-audit.ts'), 'utf8');
  const imports = [...conteudo.matchAll(AI_IMPORT_ALL)].map((m) => m[1]);
  assert.deepEqual(imports, ['../ai/index.js']);
  // E o gancho é de verdade: a chamada existe no caminho do veredito.
  assert.ok(
    /enqueueDubLieJudgment\(/.test(conteudo),
    'audio-audit enfileira o julgamento shadow com o veredito real',
  );
});
