// Catraca de ausência da família TS do banco VIVO (§5 do plano
// docs/superpowers/plans/2026-11-01-banco-vivo-corte.md): arquivo já cortado
// que voltar ao working tree quebra o CI — reintrodução silenciosa não passa.
// A lista cresce a cada fase do corte (uma fase = um commit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/** Cada fase do corte acrescenta aqui os arquivos que apagou. */
const CUT_FILES: readonly string[] = [
  // Fase 1 — busca do painel lendo pela admin do gateway:
  'src/utils/magnet-bank-search.ts',
  'test/magnet-bank-search.test.ts',
];

for (const rel of CUT_FILES) {
  test(`arquivo cortado permanece fora: ${rel}`, () => {
    assert.equal(fs.existsSync(path.join(repoRoot, rel)), false, `${rel} reintroduzido`);
  });
}
