/**
 * PERGUNTA 2 shadow do TypeSafe (`is_dub_lie`) — SEM rede:
 *   1. PARIDADE com o probe validado online (scripts/jev-dub-lie-payload.mjs,
 *      38/38): PROMPT_VERSION, QUESTIONS, STATE_FIELDS e buildState idênticos
 *      — a pergunta de runtime nunca diverge da validada no corpus online sem
 *      o teste reclamar;
 *   2. FILA: enqueue 'ok', chamada ao modelo, julgamento CRU {n,m,at} no cache
 *      `tsj` e comparação shadow sob `typesafe.dublie.*`;
 *   3. ISOLAMENTO: as métricas históricas de FILA/CHAMADA/SHADOW da pergunta 1
 *      (`typesafe.*`) não sobem com a pergunta 2 — instâncias separadas (o
 *      ORÇAMENTO e o BREAKER são compartilhados de propósito: mesma chave e
 *      mesmo limite do provedor);
 *   4. INÉRCIA: kill-switch OFF → 'disabled', zero fetch, zero cache;
 *   5. FACHADA: `aiStatus` agrega as duas perguntas e `aiControl` opera nas
 *      duas cores (pausa de operador é global);
 *   6. DIMENSÃO: a divergência também grava `disagree.<lado>.origin-global`
 *      (dim FIXA da Q2 — o tail audit não carrega `isBr`); `origin-br` nunca
 *      aparece e a soma das dimensões bate com a métrica antiga por lado.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import {
  aiStatus,
  aiControl,
  resetTypesafeForTests,
  flushTypesafeForTests,
} from '../src/ai/index.js';
import { enqueueAudioJudgment, statusSnapshot } from '../src/ai/audio-judgment-queue.js';
import {
  enqueueDubLieJudgment,
  resetDubLieForTests,
  flushDubLieForTests,
} from '../src/ai/dub-lie-judgment-queue.js';
import {
  PROMPT_VERSION,
  QUESTION_ID,
  QUESTIONS,
  STATE_FIELDS,
  buildState,
} from '../src/ai/questions-dub-lie.js';
import { fingerprintMaterial, keyFor } from '../src/ai/audio-judgment-cache.js';
import { normalizeTitle } from '../src/utils/title-normalization.js';

const SAVED = { ...config.typesafe };

function cfgOn(over: Record<string, unknown> = {}) {
  Object.assign(config.typesafe, {
    enabled: true,
    apiKey: 'k-test',
    endpoint: 'https://ts.test/v1/systemone',
    model: 'jev-test',
    threshold: 0.55,
    timeoutMs: 3000,
    queueMax: 64,
    concurrency: 2,
    hourlyCap: 120,
    dailyCap: 600,
    cooldownMs: 60000,
    judgmentTtlS: 1209600,
    ...over,
  });
}

const okRes = (noul: number) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ answers: { is_dub_lie: { noul } } }),
});

// Responde AS DUAS perguntas no mesmo envelope: quando um teste enfileira nas
// duas filas, cada core lê o próprio `answers.<id>.noul` — um corpo só com
// `is_dub_lie` faria a pergunta 1 falhar `shape` (e armar o breaker dela).
const okResBoth = (noul: number) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul }, is_dub_lie: { noul } } }),
});

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);

// Chave do cache `tsj` EXATAMENTE como o motor monta: material da pergunta
// (título normalizado | indexer | arquivos) + model + promptVersion.
function dubLieKey(title: string, indexer: string, files: string[]): string {
  const material = [normalizeTitle(String(title || '')), String(indexer || ''), ...files.map(String)].join('|');
  return keyFor(fingerprintMaterial(`${material}|jev-test|${PROMPT_VERSION}`));
}

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

beforeEach(() => {
  resetTypesafeForTests();
  cache.clearNamespace('tsj');
  metrics.reset();
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('paridade com o probe online: pergunta idêntica ao corpus validado', async () => {
  const probe = await load('jev-dub-lie-payload.mjs');
  assert.equal(PROMPT_VERSION, probe.PROMPT_VERSION);
  assert.equal(QUESTION_ID, 'is_dub_lie');
  assert.deepEqual(QUESTIONS, probe.QUESTIONS);
  assert.deepEqual(STATE_FIELDS, probe.STATE_FIELDS);
  // buildState: mesmo resultado com a mesma entrada, e o estado carrega SÓ os
  // três campos da fronteira (a ordem do array de arquivos se preserva).
  const caso = { post: 'Filme DUBLADO 1080p', indexer: 'bludv', files: ['Filme.2014.1080p.x264-RARBG.mkv', 'b.srt'] };
  assert.deepEqual(buildState(caso), probe.buildState(caso));
  assert.deepEqual(buildState(caso), {
    post_title: 'Filme DUBLADO 1080p',
    indexer: 'bludv',
    video_files: ['Filme.2014.1080p.x264-RARBG.mkv', 'b.srt'],
  });
});

test('fila ok: chama, grava julgamento cru e concorda no shadow', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    // det=true (post prometeu dub) e noul 0.9 ≥ 0.55: pred=true concorda.
    assert.equal(
      enqueueDubLieJudgment('Filme DUBLADO 1080p', 'bludv', ['Filme.2014.1080p.x264-RARBG.mkv'], true),
      'ok',
    );
    await flushDubLieForTests();
    assert.equal(stub.calls.length, 1);
    assert.equal(counter('typesafe.dublie.call.ok'), 1);
    assert.equal(counter('typesafe.shadow.dublie.agree'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree'), 0);
    // Julgamento CRU no cache `tsj`: { n, m, at } — threshold aplicado só na
    // comparação shadow de chamada NOVA.
    const raw = cache.get(dubLieKey('Filme DUBLADO 1080p', 'bludv', ['Filme.2014.1080p.x264-RARBG.mkv'])) as any;
    assert.deepEqual(Object.keys(raw).sort(), ['at', 'm', 'n']);
    assert.equal(raw.n, 0.9);
    assert.equal(raw.m, 'jev-test');
    assert.ok(raw.at > 0);
  } finally {
    stub.restore();
  }
});

test('disagree: divergência vira métrica com lado fixo', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    // det=false (a regra NÃO condenou) e modelo diz lie (0.9): o lado da IA.
    assert.equal(enqueueDubLieJudgment('Movie.English.2014.1080p.x264', 'tracker-y', ['a.mkv'], false), 'ok');
    await flushDubLieForTests();
    assert.equal(counter('typesafe.shadow.dublie.disagree'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree.ai-lie'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree.rule-lie'), 0);
  } finally {
    stub.restore();
  }
});

test('disagree por dimensão: Q2 grava `<lado>.origin-global` nos DOIS lados', async () => {
  cfgOn();
  // A dimensão da Q2 é FIXA em origin-global (o tail audit chama só com
  // título/indexer/arquivos — sem o flag `isBr` da listagem): a divergência
  // aparece por lado E por origem, e `origin-br` nunca é escrito aqui.
  let noul = 0.9;
  const stub = stubFetch(() => okRes(noul));
  try {
    // Lado da IA: det=false, modelo diz lie (0.9 >= 0.55) → ai-lie.origin-global.
    assert.equal(enqueueDubLieJudgment('Movie.English.2014.1080p.x264', 'tracker-y', ['a.mkv'], false), 'ok');
    await flushDubLieForTests();
    assert.equal(counter('typesafe.shadow.dublie.disagree'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree.ai-lie.origin-global'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree.rule-lie.origin-global'), 0);
    assert.equal(counter('typesafe.shadow.dublie.disagree.ai-lie.origin-br'), 0, 'Q2 nunca declara origin-br');
    // Lado da regra: det=true, modelo diz não-lie (0.1 < 0.55) → rule-lie.origin-global.
    noul = 0.1;
    assert.equal(enqueueDubLieJudgment('Filme DUBLADO 1080p', 'bludv', ['b.mkv'], true), 'ok');
    await flushDubLieForTests();
    assert.equal(counter('typesafe.shadow.dublie.disagree'), 2);
    assert.equal(counter('typesafe.shadow.dublie.disagree.rule-lie'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree.rule-lie.origin-global'), 1);
    // Soma das dimensões = métrica antiga por lado (nada some, nada duplica).
    assert.equal(
      counter('typesafe.shadow.dublie.disagree.ai-lie.origin-global') +
        counter('typesafe.shadow.dublie.disagree.rule-lie.origin-global'),
      counter('typesafe.shadow.dublie.disagree'),
    );
  } finally {
    stub.restore();
  }
});

test('isolamento: métricas da pergunta 1 não sobem com a pergunta 2', async () => {
  cfgOn();
  const stub = stubFetch(() => okResBoth(0.9));
  try {
    assert.equal(enqueueDubLieJudgment('Filme DUBLADO', 'bludv', ['a.mkv'], true), 'ok');
    await flushDubLieForTests();
    assert.equal(counter('typesafe.dublie.call.ok'), 1);
    assert.equal(counter('typesafe.shadow.dublie.agree'), 1);
    // Instâncias separadas: a pergunta 1 não viu chamada, shadow nem fila.
    assert.equal(counter('typesafe.call.ok'), 0);
    assert.equal(counter('typesafe.shadow.agree'), 0);
    assert.equal(counter('typesafe.shadow.disagree'), 0);
    assert.equal(statusSnapshot().queueDepth, 0);
    // E o caminho inverso também: enqueue da pergunta 1 não suja a pergunta 2.
    assert.equal(enqueueAudioJudgment('Filme DUBLADO', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.call.ok'), 1);
    assert.equal(counter('typesafe.dublie.call.ok'), 1, 'pergunta 2 não acumulou chamada da 1');
  } finally {
    stub.restore();
  }
});

test('kill-switch OFF: disabled, zero fetch, zero cache', () => {
  cfgOn({ enabled: false });
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueDubLieJudgment('Filme DUBLADO', 'bludv', ['a.mkv'], true), 'disabled');
    assert.equal(stub.calls.length, 0, 'nenhum fetch');
    // Nem LEITURA de cache: o contador do namespace nem aparece.
    assert.equal(counter('cache.miss.tsj'), 0);
    assert.equal(cache.has(dubLieKey('Filme DUBLADO', 'bludv', ['a.mkv'])), false);
    assert.equal(counter('typesafe.dublie.enqueue.disabled'), 1);
    // Sem chave também é disabled (chave vazia ≠ enabled).
    cfgOn({ enabled: true, apiKey: '' });
    assert.equal(enqueueDubLieJudgment('Outro DUBLADO', 'bludv', ['b.mkv'], true), 'disabled');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('aiStatus agrega as duas perguntas; aiControl opera nas duas cores', async () => {
  cfgOn();
  const stub = stubFetch(() => okResBoth(0.9));
  try {
    const st = aiStatus();
    assert.equal(st.enabled, true);
    assert.equal(st.model, 'jev-test');
    assert.equal(st.audioClassify.promptVersion, 'audio-classify-q1');
    assert.equal(st.dubLie.promptVersion, PROMPT_VERSION);
    assert.equal(st.dubLie.questionId, 'is_dub_lie');
    assert.deepEqual(aiControl.status(), { audioClassify: false, dubLie: false });

    // Pausa GLOBAL sincronamente após o enqueue: o item já enfileirado nas
    // duas cores NÃO pode se perder (pause é efêmero, não descarta).
    assert.equal(enqueueDubLieJudgment('Filme DUBLADO', 'bludv', ['a.mkv'], true), 'ok');
    assert.equal(enqueueAudioJudgment('Filme DUBLADO', true, 'origin-global'), 'ok');
    aiControl.pause();
    assert.deepEqual(aiControl.status(), { audioClassify: true, dubLie: true });
    assert.equal(aiControl.isPaused(), true);
    assert.equal(enqueueDubLieJudgment('Outro DUBLADO', 'bludv', ['b.mkv'], true), 'paused');
    assert.equal(enqueueAudioJudgment('Outro DUBLADO', true, 'origin-global'), 'paused');

    // Resume reagenda o drain nas duas; drainNow/resetCooldown não lançam.
    aiControl.resume();
    assert.equal(aiControl.isPaused(), false);
    aiControl.drainNow();
    aiControl.resetCooldown();
    await flushTypesafeForTests();
    // Os itens enfileirados ANTES da pausa foram processados nas duas cores.
    assert.equal(counter('typesafe.call.ok'), 1);
    assert.equal(counter('typesafe.dublie.call.ok'), 1);
    assert.equal(counter('typesafe.shadow.dublie.agree'), 1);
  } finally {
    stub.restore();
  }
});

test('higiene: resetDubLieForTests zera a fila sem despachar', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueDubLieJudgment('A DUBLADO', 'bludv', ['a.mkv'], true), 'ok');
    resetDubLieForTests();
    await flushDubLieForTests();
    assert.equal(stub.calls.length, 0, 'fila zerada não despacha');
  } finally {
    stub.restore();
  }
});
