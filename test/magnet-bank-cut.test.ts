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
  // Fase 4 — corte da raiz: captura/escrita e réguas do acervo são do gateway
  // (ponte read-only + oráculo); o Node só lê e exporta/importa via admin:
  'src/utils/magnet-bank.ts',
  'src/utils/magnet-bank-read.ts',
  'src/utils/magnet-bank-merge.ts',
  'src/utils/magnet-bank-rows.ts',
  'src/utils/magnet-bank-memory.ts',
  'src/utils/magnet-bank-schema.ts',
  'src/utils/magnet-bank-lie.ts',
  'test/magnet-bank.test.ts',
  'test/magnet-bank-status.test.ts',
  'test/magnet-bank-lifecycle.test.ts',
  'test/magnet-bank-memory-lru.test.ts',
  'test/helpers/magnet-bank-fixture.ts',
];

for (const rel of CUT_FILES) {
  test(`arquivo cortado permanece fora: ${rel}`, () => {
    assert.equal(fs.existsSync(path.join(repoRoot, rel)), false, `${rel} reintroduzido`);
  });
}
