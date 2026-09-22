import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
// Nome fora do padrão *.test.ts de propósito: o probe é transitório e não pode
// virar item da lista do npm test enquanto está no disco.
const PROBE = path.join(ROOT, 'test', 'zz-line-budget-untracked-probe.ts');
// Probe .mjs: entrou na varredura com o probe Jev (ETAPA 2) — experimento
// sob scripts/ é código vivo e o gate precisa vê-lo também sem build.
const PROBE_MJS = path.join(ROOT, 'test', 'zz-line-budget-untracked-probe.mjs');

function rodarGate(): { falhou: boolean; saida: string } {
  let falhou = false;
  let saida = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'dist', 'scripts', 'check-line-budget.js'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    falhou = true;
    const e = err as { stderr?: string; stdout?: string; message?: string };
    saida = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
  }
  return { falhou, saida };
}

describe('line-budget: ponto cego de arquivo untracked foi fechado', () => {
  test('arquivo novo >400 NÃO staged reprova via --check (regra A)', () => {
    // 405 linhas > teto 400; nunca é `git add`ado. Antes do fix o gate via
    // apenas `git ls-files` (índice) e saía 0 com o arquivo gigante no disco.
    fs.writeFileSync(PROBE, Array.from({ length: 405 }, (_, i) => `// probe ${i}`).join('\n') + '\n');
    try {
      const { falhou, saida } = rodarGate();
      assert.equal(falhou, true, 'o portão precisa reprovar o untracked acima do teto');
      assert.match(saida, /zz-line-budget-untracked-probe\.ts/, 'o probe precisa aparecer na listagem do gate');
    } finally {
      fs.rmSync(PROBE, { force: true });
    }
  });

  test('.mjs untracked >400 também reprova (extensão na varredura)', () => {
    fs.writeFileSync(PROBE_MJS, Array.from({ length: 402 }, (_, i) => `// probe ${i}`).join('\n') + '\n');
    try {
      const { falhou, saida } = rodarGate();
      assert.equal(falhou, true, 'o gate precisa varrer .mjs');
      assert.match(saida, /zz-line-budget-untracked-probe\.mjs/, 'o probe .mjs precisa aparecer na listagem');
    } finally {
      fs.rmSync(PROBE_MJS, { force: true });
    }
  });
});
