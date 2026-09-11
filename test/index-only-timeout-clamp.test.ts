// Clamp defensivo de JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS: o orçamento
// dedicado do colhedor para index-only não pode nascer torto de um valor
// maluco no .env (0 desligaria o indexer, 10min penduraria a fila).
//
// Cada caso roda em processo filho: em ESM os import são içados, então uma
// atribuição de process.env no corpo do teste chega DEPOIS da avaliação da
// config (a mesma armadilha que motivou o setup-env.js da suíte).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const distPath = fileURLToPath(new URL('../../dist/src/config/jackett.js', import.meta.url));

function lerComEnv(valor: string): string {
  const script = `
    const { jackett } = await import(${JSON.stringify(pathToFileURL(distPath).href)});
    console.log(jackett().indexOnlyHarvestTimeout);
  `;
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      env: { ...process.env, DOTENV_CONFIG_PATH: 'test/fixtures/env-empty', JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS: valor },
      encoding: 'utf8',
    },
  ).trim();
}

test('JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS abaixo do piso satura em 5000ms', () => {
  assert.equal(lerComEnv('1'), '5000');
  assert.equal(lerComEnv('4999'), '5000');
});

test('JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS acima do teto satura em 120000ms', () => {
  assert.equal(lerComEnv('999999'), '120000');
});

test('JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS válido passa sem saturar; default é 35000', () => {
  assert.equal(lerComEnv('40000'), '40000');
  const script = `
    const { jackett } = await import(${JSON.stringify(pathToFileURL(distPath).href)});
    console.log(jackett().indexOnlyHarvestTimeout);
  `;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env: { ...process.env, DOTENV_CONFIG_PATH: 'test/fixtures/env-empty' }, encoding: 'utf8' },
  ).trim();
  assert.equal(out, '35000');
});
