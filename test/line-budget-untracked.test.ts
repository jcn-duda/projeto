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

describe('line-budget: ponto cego de arquivo untracked foi fechado', () => {
  test('arquivo novo >400 NÃO staged reprova via --check (regra A)', () => {
    // 405 linhas > teto 400; nunca é `git add`ado. Antes do fix o gate via
    // apenas `git ls-files` (índice) e saía 0 com o arquivo gigante no disco.
    fs.writeFileSync(PROBE, Array.from({ length: 405 }, (_, i) => `// probe ${i}`).join('\n') + '\n');
    try {
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
      assert.equal(falhou, true, 'o portão precisa reprovar o untracked acima do teto');
      assert.match(saida, /zz-line-budget-untracked-probe\.ts/, 'o probe precisa aparecer na listagem do gate');
    } finally {
      fs.rmSync(PROBE, { force: true });
    }
  });
});
