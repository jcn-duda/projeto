// Testes permanentes do checker golden da fatia F0 (commit bca9482).
//
// O alvo é o PROCESSO REAL `scripts/golden/dump-title-normalization.mjs --check`
// (Node ESM), não uma réplica. Toda rodada usa CLONES do golden/manifest/corpus
// em diretório temporário do SO, redirecionados por `--out`/`--corpus`: os
// artefatos commitados e o oracle (src/dist) são apenas LIDOS. Sem rede, sem
// .env, sem DB.
//
// Cada negativo exige a mensagem-ALVO no stderr além do exit 1: aceitar só
// "saiu diferente de zero" deixaria um build quebrado ("oracle ausente") passar
// como se o guard certo tivesse disparado.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = path.join(ROOT, 'scripts', 'golden', 'dump-title-normalization.mjs');

const GOLDEN = 'title-normalization.jsonl';
const MANIFEST = 'title-normalization.manifest.json';
const CORPUS = 'corpus-title-normalization.json';
const CASES = 173;

// Canônicos: fonte de clone e alvo do teste de leitura estrita (bytes + mtime).
const CANON = {
  jsonl: path.join(ROOT, 'rust', 'golden', GOLDEN),
  manifest: path.join(ROOT, 'rust', 'golden', MANIFEST),
  corpus: path.join(ROOT, 'scripts', 'golden', CORPUS),
  source: path.join(ROOT, 'src', 'utils', 'title-normalization.ts'),
  artifact: path.join(ROOT, 'dist', 'src', 'utils', 'title-normalization.js'),
};

interface Run { code: number; stdout: string; stderr: string; }

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const texto = (v: string | Buffer | null | undefined): string => (v == null ? '' : String(v));

/** Spawn do checker real. Só código de saída NUMÉRICO conta como desfecho;
 *  erro de spawn/timeout vira exceção em vez de "falhou como esperado". */
async function runCheck(outDir: string, corpusPath: string): Promise<Run> {
  const args = [CHECKER, '--check', '--out', outDir, '--corpus', corpusPath];
  try {
    const res = await execFileAsync(process.execPath, args, {
      cwd: ROOT, timeout: 60_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: texto(res.stdout), stderr: texto(res.stderr) };
  } catch (err) {
    const e = err as {
      code?: number | string; status?: number | null; killed?: boolean; signal?: string | null;
      stdout?: string | Buffer; stderr?: string | Buffer;
    };
    const code = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : null;
    if (code === null) throw new Error(`checker sem código de saída numérico (killed=${e.killed} signal=${e.signal})`);
    return { code, stdout: texto(e.stdout), stderr: texto(e.stderr) };
  }
}

/** Clona os três artefatos canônicos para fixtures isoladas em temp do SO. */
async function cloneFixture(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'golden-title-'));
  await fsp.copyFile(CANON.jsonl, path.join(dir, GOLDEN));
  await fsp.copyFile(CANON.manifest, path.join(dir, MANIFEST));
  await fsp.copyFile(CANON.corpus, path.join(dir, CORPUS));
  return dir;
}

/** Cleanup garantido (try/finally): nenhum `golden-title-*` sobra no temp. */
async function withFixture<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await cloneFixture();
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Negativo: exit 1 + a mensagem-ALVO (senão um guard errado passaria). */
async function expectFail(dir: string, corpus: string, alvo: RegExp): Promise<void> {
  const r = await runCheck(dir, corpus);
  assert.equal(r.code, 1, `esperava exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, alvo, `mensagem-alvo ${alvo} ausente em: ${r.stderr}`);
}

describe('golden checker: baseline', () => {
  test('clone íntegro passa com os 173 casos e sem FALHA no stderr', async () => {
    await withFixture(async (dir) => {
      const r = await runCheck(dir, path.join(dir, CORPUS));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /\[golden\] OK/);
      assert.match(r.stdout, new RegExp(`${CASES} casos batem com o dist vivo`));
      assert.doesNotMatch(r.stderr, /FALHA/);
    });
  });
});

describe('golden checker: guardas de integridade', () => {
  test('manifest ausente', async () => {
    await withFixture(async (dir) => {
      await fsp.rm(path.join(dir, MANIFEST));
      await expectFail(dir, path.join(dir, CORPUS), /manifest ausente ou ilegível/);
    });
  });

  test('golden ausente', async () => {
    await withFixture(async (dir) => {
      await fsp.rm(path.join(dir, GOLDEN));
      await expectFail(dir, path.join(dir, CORPUS), /golden ausente/);
    });
  });

  test('golden vazio', async () => {
    await withFixture(async (dir) => {
      await fsp.writeFile(path.join(dir, GOLDEN), '');
      await expectFail(dir, path.join(dir, CORPUS), /golden vazio/);
    });
  });

  test('saída alterada com o hash antigo no manifest', async () => {
    await withFixture(async (dir) => {
      await fsp.appendFile(path.join(dir, GOLDEN), '{"id":"tn-extra","input":"x","expected":"x"}\n');
      await expectFail(dir, path.join(dir, CORPUS), /golden divergiu do manifest/);
    });
  });

  test('saída alterada E hash do manifest atualizado: falha ao recomputar o oracle', async () => {
    await withFixture(async (dir) => {
      const golden = path.join(dir, GOLDEN);
      const manifest = path.join(dir, MANIFEST);
      await fsp.appendFile(golden, '{"id":"tn-extra","input":"x","expected":"x"}\n');
      // Atualiza o hash para o do arquivo adulterado: passa da checagem de
      // hash e só a RECOMPUTAÇÃO contra o dist vivo pode pegar.
      const m = JSON.parse(await fsp.readFile(manifest, 'utf8'));
      m.output.sha256 = sha256(await fsp.readFile(golden));
      await fsp.writeFile(manifest, `${JSON.stringify(m, null, 2)}\n`);
      await expectFail(dir, path.join(dir, CORPUS), /comportamento do dist divergiu do golden/);
    });
  });

  test('corpus alterado: hash diverge do manifest', async () => {
    await withFixture(async (dir) => {
      const corpus = path.join(dir, CORPUS);
      // Muda só metadado do corpus (os `cases` seguem iguais), então a
      // recomputação bate e o guard que dispara é o do hash do corpus.
      const txt = await fsp.readFile(corpus, 'utf8');
      await fsp.writeFile(corpus, txt.replace('"corpus-title-normalization/1"', '"corpus-title-normalization/1-alt"'));
      await expectFail(dir, corpus, /corpus mudou desde a geração/);
    });
  });

  test('registry inválido no manifest', async () => {
    await withFixture(async (dir) => {
      const manifest = path.join(dir, MANIFEST);
      const m = JSON.parse(await fsp.readFile(manifest, 'utf8'));
      m.registry = ['outra-funcao/nao-coberta'];
      await fsp.writeFile(manifest, `${JSON.stringify(m, null, 2)}\n`);
      await expectFail(dir, path.join(dir, CORPUS), /registry do manifest diverge do esperado/);
    });
  });
});

describe('golden checker: --check é somente leitura', () => {
  function snapshot(paths: string[]): Record<string, { sha: string; mtimeMs: number }> {
    const out: Record<string, { sha: string; mtimeMs: number }> = {};
    for (const p of paths) out[p] = { sha: sha256(fs.readFileSync(p)), mtimeMs: fs.statSync(p).mtimeMs };
    return out;
  }

  test('não altera bytes nem mtimes do clone, do golden canônico nem do oracle', async () => {
    await withFixture(async (dir) => {
      const verificados = [
        path.join(dir, GOLDEN), path.join(dir, MANIFEST), path.join(dir, CORPUS),
        CANON.jsonl, CANON.manifest, CANON.corpus, CANON.source, CANON.artifact,
      ];
      const antes = snapshot(verificados);
      const r = await runCheck(dir, path.join(dir, CORPUS));
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(snapshot(verificados), antes, 'o check não pode tocar bytes/mtime dos arquivos verificados');
    });
  });
});
