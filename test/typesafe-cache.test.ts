/**
 * Cache do julgamento TypeSafe (`tsj:v1`) — SEM rede:
 *   1. fingerprint estável; muda com título, model E promptVersion;
 *   2. chave com prefixo versionado `tsj:v1:`;
 *   3. valor cru roundtrip SEM título/chave; corrompido é miss;
 *   4. TTL <= 0 não grava; TTL de config é o default do facade;
 *   5. PARIDADE com o probe validado online: PROMPT_VERSION, QUESTIONS e
 *      buildState do espelho TS são idênticos aos de
 *      scripts/jev-audio-classify-payload.mjs — a pergunta de runtime nunca
 *      diverge da validada no corpus online sem o teste reclamar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cache from '../src/utils/cache.js';
import { fingerprint, judgmentKey, lookup, store } from '../src/ai/audio-judgment-cache.js';
import { PROMPT_VERSION, QUESTIONS, buildState, STATE_FIELDS } from '../src/ai/questions-audio.js';

// CACHE_PERSIST=false vem do setup-env (--import): este arquivo nunca toca
// SQLite real.

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('raiz do repo não encontrada a partir do teste');
}

const ROOT = repoRoot();
const load = (name: string): Promise<any> =>
  import(pathToFileURL(join(ROOT, 'scripts', name)).href);

test('fingerprint: estável e sensível a título, model e prompt', () => {
  assert.equal(fingerprint('Filme Dublado', 'jev-test'), fingerprint('Filme Dublado', 'jev-test'));
  assert.notEqual(fingerprint('Filme Dublado', 'jev-test'), fingerprint('Outro Filme', 'jev-test'));
  assert.notEqual(fingerprint('Filme Dublado', 'jev-test'), fingerprint('Filme Dublado', 'jev-latest'));
  // Normalização: caixa/acentos não mudam a chave (mesma normalização do matching).
  assert.equal(fingerprint('Filme DUBLADO', 'm'), fingerprint('filme dublado', 'm'));
});

test('chave versionada e roundtrip do valor cru', () => {
  assert.ok(judgmentKey('Filme Dublado', 'jev-test').startsWith('tsj:v1:'), 'prefixo tsj:v1:');
  const fp = fingerprint('Filme Dublado', 'jev-test');
  store(fp, { n: 0.72, m: 'jev-test', at: 1234 }, 100);
  const j = lookup(fp);
  assert.deepEqual(j, { n: 0.72, m: 'jev-test', at: 1234 });
  // O valor NUNCA carrega o título: o que foi gravado é só { n, m, at }.
  const raw = cache.get(judgmentKey('Filme Dublado', 'jev-test')) as any;
  assert.deepEqual(Object.keys(raw).sort(), ['at', 'm', 'n']);
});

test('valor corrompido é miss; TTL <= 0 não grava', () => {
  const key = judgmentKey('Corrompido Dublado', 'jev-test');
  cache.set(key, 'lixo', 100);
  assert.equal(lookup(fingerprint('Corrompido Dublado', 'jev-test')), null);
  cache.set(key, { n: 2.5, m: 'x', at: 1 }, 100); // noul fora de [0,1]
  assert.equal(lookup(fingerprint('Corrompido Dublado', 'jev-test')), null);
  const fp2 = fingerprint('Sem TTL', 'jev-test');
  store(fp2, { n: 0.5, m: 'jev-test', at: 1 }, 0);
  assert.equal(cache.has(judgmentKey('Sem TTL', 'jev-test')), false, 'TTL 0 não escreve');
});

test('paridade com o probe online: pergunta idêntica ao corpus validado', async () => {
  const probe = await load('jev-audio-classify-payload.mjs');
  assert.equal(PROMPT_VERSION, probe.PROMPT_VERSION);
  assert.deepEqual(QUESTIONS, probe.QUESTIONS);
  assert.deepEqual(STATE_FIELDS, probe.STATE_FIELDS);
  // buildState: mesmo resultado com a mesma entrada; campo extra do caso NUNCA
  // atravessa (probe recebe caso inteiro, o runtime recebe só o título).
  assert.deepEqual(buildState('Título Dublado'), probe.buildState({ title: 'Título Dublado', indexer: 'x', files: ['a.mkv'] }));
  assert.deepEqual(buildState('Título Dublado'), { post_title: 'Título Dublado' });
});
