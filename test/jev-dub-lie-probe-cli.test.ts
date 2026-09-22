/**
 * Probe Jev dub-lie (ETAPA 2) — prova do CLI via spawn do script real,
 * SEM REDE e SEM chave: --dry-run ok, flags desconhecidas/valor ausente
 * ou inválido saem com código 3, forma --flag=value aceita.
 *
 * O parse é interno do CLI (importar o script executa main()), então os
 * contratos de argumentos são exercitados de fora, pelo processo — que
 * é o contrato que importa. O núcleo (corpus/allowlist/cliente) está em
 * jev-dub-lie-probe.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('raiz do repo não encontrada a partir do teste');
}

const ROOT = repoRoot();
const PROBE = join(ROOT, 'scripts', 'jev-dub-lie-probe.mjs');
const CASES_URL = pathToFileURL(join(ROOT, 'scripts', 'jev-dub-lie-cases.mjs')).href;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_API_KEY: '' };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [PROBE, ...args], {
      cwd: ROOT, env, timeout: 30000, windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: Number(e.code), stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}

test('CLI: --dry-run roda sem chave, sem rede e valida o payload', async () => {
  const r = await runCli(['--dry-run']);
  assert.equal(r.code, 0);
  // Alegação limitada à construção: o caminho não faz fetch — a saída
  // declara a garantia como estrutural, não como sandbox.
  assert.ok(r.stdout.includes('modo=dry-run'));
  assert.ok(r.stdout.includes('garantia por construção'));
  const CASES: any[] = (await import(CASES_URL)).CASES;
  assert.ok(r.stdout.includes(`corpus=${CASES.length} casos`), 'conta o corpus real');
  assert.ok(r.stdout.includes('allowlist=OK'));
  assert.ok(r.stdout.includes('prompt_version='));
  assert.ok(!/key_len/.test(r.stdout), 'nenhum eco de chave, nem o comprimento');
  assert.ok(!/Bearer\s+\S/.test(r.stdout), 'nenhuma credencial na saída');
});

test('CLI: --flag=value é aceito e reflete no plano', async () => {
  const r = await runCli(['--dry-run', '--model=meu-modelo', '--threshold=0.7', '--concurrency=2']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('modelo=meu-modelo'));
  assert.ok(r.stdout.includes('threshold=0.7'));
  assert.ok(r.stdout.includes('concorrência=2'));
});

test('CLI: flag desconhecida reprova com exit 3', async () => {
  const r = await runCli(['--dry-run', '--flagx']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /flag desconhecida/);
});

test('CLI: valor ausente reprova com exit 3', async () => {
  const fim = await runCli(['--threshold']);
  assert.equal(fim.code, 3);
  assert.match(fim.stderr, /sem valor/);
  const outraFlag = await runCli(['--model', '--dry-run']);
  assert.equal(outraFlag.code, 3, 'valor não pode ser outra flag');
  assert.match(outraFlag.stderr, /sem valor/);
});

test('CLI: valor inválido ou fora da faixa reprova com exit 3', async () => {
  for (const args of [
    ['--threshold=abc'],
    ['--threshold=1.5'],
    ['--concurrency=99'],
    ['--timeout-ms=10'],
    ['--max-attempts=x'],
    ['--dry-run=1'],
  ]) {
    const r = await runCli(args);
    assert.equal(r.code, 3, `${args.join(' ')} deveria sair 3, saiu ${r.code}`);
    assert.match(r.stderr, /argumento inválido/);
  }
});
