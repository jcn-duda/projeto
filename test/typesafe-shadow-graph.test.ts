/**
 * Teste de GRAFO do runtime TypeSafe shadow:
 *   1. módulos de DECISÃO (matching, limpeza, índice, banco, autofetch, debrid)
 *      NÃO importam `src/ai/` de forma nenhuma — a IA é proibida, por
 *      construção, de alcançar veredito determinístico, lie/bad, idx,
 *      magnet-bank, Chupim ou limpeza;
 *   2. no RESTO de `src/`, o único import de `src/ai/` permitido é a FACHADA
 *      (`ai/index.js`) — o cliente de fetch (`typesafe-client`), a fila e o
 *      cache não podem ser importados direto por quem monta a resposta;
 *   3. o PRODUTOR é o pipeline (pós-filtro) — se alguém mudar o ponto de
 *      acionamento para dentro de um módulo de decisão, o teste quebra.
 *
 * Varre a FONTE (não o dist): gates de arquitetura valem antes do build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// Módulos de decisão/efeito: NENHUM pode importar src/ai/. A lista cobre os
// invariantes do AGENTS.md (audio/lie/idx/banco/limpeza/autofetch/debrid) e os
// classificadores determinísticos que o shadow compara.
const DECISION_MODULES = [
  'src/utils/audio-cleanup.ts',
  'src/utils/release-index.ts',
  'src/utils/release-work.ts',
  'src/utils/magnetdb.ts',
  'src/utils/magnet-bank.ts',
  'src/utils/magnet-bank-merge.ts',
  'src/utils/stream-ranking.ts',
  'src/utils/stream-quotas.ts',
  'src/utils/search-names.ts',
  'src/utils/release-matching.ts',
  'src/utils/format.ts',
  'src/providers/debrid-pipeline.ts',
  'src/providers/debrid-pipeline-steps.ts',
  'src/providers/jackett.ts',
  'src/providers/account.ts',
  'src/utils/autofetch-pools.ts',
  'src/providers/autofetch-runner.ts',
  'src/providers/autofetch-candidates.ts',
  'src/providers/magnet-bank-fallback.ts',
  'src/providers/harvester.ts',
  'src/debrid/alldebrid-cleanup.ts',
  'src/debrid/file-selector.ts',
  'src/debrid/protected.ts',
];

// ETAPA C — ÚNICA isenção: audio-quality.ts importa a FACHADA (`ai/index.js`)
// para o overlay Jev no termo fraco de `explicitPtAudio`. A isenção é para a
// fachada APENAS — cliente de fetch, fila e cache continuam proibidos em todo
// o resto de src/ (cobrado pelo teste de grafo seguinte).
const FACADE_EXEMPT_DECISION_MODULES = ['src/utils/audio-quality.ts'];

// Sem a flag `g`: `.test()` com regex global é STATEFUL (`lastIndex` persiste) e
// podia pular uma detecção depois de um match anterior. Cobre import estático
// (`from '…'`/`from'…'`) e import DINÂMICO (`import('…')`).
const AI_IMPORT = /(?:from\s*|import\s*\(\s*)['"][^'"]*\/ai\//;
const AI_IMPORT_ALL = /(?:from\s*|import\s*\(\s*)['"]([^'"]*\/ai\/[^'"]*)['"]/g;

function walkTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walkTs(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

test('grafo: nenhum módulo de decisão importa src/ai/', () => {
  const violacoes: string[] = [];
  for (const rel of DECISION_MODULES) {
    const full = join(ROOT, rel);
    assert.ok(existsSync(full), `arquivo de referência existe: ${rel}`);
    if (AI_IMPORT.test(readFileSync(full, 'utf8'))) violacoes.push(rel);
  }
  assert.deepEqual(violacoes, [], `módulos de decisão importando src/ai/: ${violacoes.join(', ')}`);
});

test('grafo: fora de src/ai, o único import permitido é a fachada ai/index.js', () => {
  const aiDir = join(ROOT, 'src', 'ai');
  const todos = walkTs(join(ROOT, 'src')).filter((f) => !f.startsWith(aiDir));
  const violacoes: string[] = [];
  for (const full of todos) {
    const conteudo = readFileSync(full, 'utf8');
    const imports = [...conteudo.matchAll(AI_IMPORT_ALL)].map((m) => m[1]);
    const estranhos = imports.filter((m) => m !== '../ai/index.js');
    if (estranhos.length) violacoes.push(`${full}: ${estranhos.join(', ')}`);
  }
  assert.deepEqual(
    violacoes,
    [],
    `imports de src/ai/ fora da fachada permitida: ${violacoes.join(' | ')}`,
  );
});

test('grafo: o pipeline importa a fachada UMA vez (produtor único)', () => {
  const pipeline = readFileSync(join(ROOT, 'src', 'providers', 'stream-builder-pipeline.ts'), 'utf8');
  const imports = [...pipeline.matchAll(AI_IMPORT_ALL)].map((m) => m[1]);
  assert.deepEqual(imports, ['../ai/index.js']);
  assert.ok(
    /shadowAudioJudgments/.test(pipeline),
    'o pipeline chama o produtor shadow após o filtro determinístico',
  );
});

test('grafo: audio-quality é o ÚNICO módulo de decisão liberado — e só à fachada', () => {
  // A isenção é mínima e nomeada: exatamente um arquivo, e o import dele é
  // EXATAMENTE a fachada (`../ai/index.js`). Nada mais em src/utils nem nos
  // demais módulos de decisão ganhou liberação (coberto pelo primeiro teste).
  assert.deepEqual(FACADE_EXEMPT_DECISION_MODULES, ['src/utils/audio-quality.ts']);
  const conteudo = readFileSync(join(ROOT, 'src', 'utils', 'audio-quality.ts'), 'utf8');
  const imports = [...conteudo.matchAll(AI_IMPORT_ALL)].map((m) => m[1]);
  assert.deepEqual(imports, ['../ai/index.js'], 'audio-quality só pode importar a fachada ai/index.js');
  // O uso é em RUNTIME (função chamada dentro de explicitPtAudio), não em
  // avaliação de módulo — é o que torna o ciclo ESM seguro.
  assert.ok(
    /overlayDropsDub/.test(conteudo),
    'audio-quality consome overlayDropsDub da fachada',
  );
});
