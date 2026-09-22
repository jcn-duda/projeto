/**
 * O gancho shadow da pergunta 2 (`is_dub_lie`) via `assertDubbedFiles` — SEM
 * rede: a medição com o veredito REAL de mentira de áudio não pode mudar NADA
 * no comportamento do play/tail.
 *   1. LADO "MENTIU": com runtime ON e shadow presente, o throw `DubLieError`
 *      e a evidência são EXATAMENTE os de hoje — e o caso é enfileirado
 *      (`typesafe.dublie.enqueue.ok` → `call.ok` após flush) com o lado
 *      determinístico `lie`;
 *   2. INÉRCIA: kill-switch OFF lança o mesmo erro e NÃO há fetch nem leitura
 *      de cache (fail-open por construção);
 *   3. LADO "HONESTO": sem veredito de lie, não lança e TAMBÉM enfileira —
 *      os dois lados da comparação shadow se medem;
 *   4. SEM SHADOW (play interativo, hint assinado): zero enfileiramento.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import { resetTypesafeForTests } from '../src/ai/index.js';
import { flushDubLieForTests } from '../src/ai/dub-lie-judgment-queue.js';
import { assertDubbedFiles } from '../src/debrid/audio-audit.js';
import { DubLieError, isDubLieError } from '../src/debrid/common.js';

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

// Responde AS DUAS perguntas no mesmo envelope: cada core lê o próprio
// `answers.<id>.noul`, e um corpo só com `is_dub_lie` faria a pergunta 1
// falhar `shape` caso algo a enfileire.
const okResBoth = (noul: number) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul }, is_dub_lie: { noul } } }),
});

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);

// Promessa de dublado + release EN provável (grupo de cena KILLERS): o
// veredito determinístico de hoje condena — é o lado "mentiu" da comparação.
const ARQUIVO_MENTIRA = { path: 'True.Detective.S02E01.HDTV.x264-KILLERS[ettv].mp4', size: 4000 };
// Marca PT no próprio arquivo (DUAL): veredito honesto — é o lado contrário.
const ARQUIVO_HONESTO = { path: 'Filme.2019.1080p.WEB-DL.DUAL.5.1.x264.mkv', size: 4000 };
const SHADOW = { title: 'True Detective 2ª Temporada DUBLADO 1080p', indexer: 'bludv' };

beforeEach(() => {
  resetTypesafeForTests();
  cache.clearNamespace('tsj');
  metrics.reset();
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('ON + mentira: mesmo throw, mesma evidência, e o caso é medido (lado lie)', async () => {
  cfgOn();
  const stub = stubFetch(() => okResBoth(0.9));
  try {
    assert.throws(
      () => assertDubbedFiles([ARQUIVO_MENTIRA], true, SHADOW),
      (err: unknown) => {
        assert.ok(isDubLieError(err), 'ainda é DubLieError');
        const lie = err as DubLieError;
        // MESMA evidência de hoje — o gancho shadow não a altera.
        assert.deepEqual(lie.evidence, {
          matchedGroup: 'killers',
          videoCount: 1,
          sample: ARQUIVO_MENTIRA.path,
        });
        return true;
      },
      'o throw continua acontecendo',
    );
    // Enfileiramento é SÍNCRONO e fire-and-forget: aceito na fila na hora.
    assert.equal(counter('typesafe.dublie.enqueue.ok'), 1);
    await flushDubLieForTests();
    assert.equal(stub.calls.length, 1, 'uma chamada ao modelo');
    assert.equal(counter('typesafe.dublie.call.ok'), 1);
    // det=true (mentiu) × noul 0.9 → concorda: comparação shadow de métrica.
    assert.equal(counter('typesafe.shadow.dublie.agree'), 1);
  } finally {
    stub.restore();
  }
});

test('INÉRCIA OFF: mesmo erro e zero fetch, zero cache', () => {
  cfgOn({ enabled: false });
  const stub = stubFetch(() => okResBoth(0.9));
  try {
    assert.throws(
      () => assertDubbedFiles([ARQUIVO_MENTIRA], true, SHADOW),
      (err: unknown) => {
        assert.ok(isDubLieError(err));
        assert.deepEqual((err as DubLieError).evidence, {
          matchedGroup: 'killers',
          videoCount: 1,
          sample: ARQUIVO_MENTIRA.path,
        });
        return true;
      },
    );
    assert.equal(stub.calls.length, 0, 'nenhum fetch');
    // Nem LEITURA de cache: o enqueue curto-circuita antes do fingerprint.
    assert.equal(counter('cache.miss.tsj'), 0);
    assert.equal(counter('typesafe.dublie.enqueue.disabled'), 1);
    assert.equal(counter('typesafe.dublie.enqueue.ok'), 0);
  } finally {
    stub.restore();
  }
});

test('ON + honesto: não lança e TAMBÉM enfileira (mede os dois lados)', async () => {
  cfgOn();
  const stub = stubFetch(() => okResBoth(0.9));
  try {
    // Sem throw: o veredito determinístico absolveu o arquivo com DUAL.
    assert.doesNotThrow(() => assertDubbedFiles([ARQUIVO_HONESTO], true, SHADOW));
    assert.equal(counter('typesafe.dublie.enqueue.ok'), 1);
    await flushDubLieForTests();
    assert.equal(counter('typesafe.dublie.call.ok'), 1);
    // det=false (honesto) × noul 0.9 → divergência com lado FIXO da IA: é a
    // medida do lado honesto que o play nunca provava antes.
    assert.equal(counter('typesafe.shadow.dublie.disagree'), 1);
    assert.equal(counter('typesafe.shadow.dublie.disagree.ai-lie'), 1);
    assert.equal(counter('typesafe.shadow.dublie.agree'), 0);
  } finally {
    stub.restore();
  }
});

test('SEM shadow (play interativo): zero enfileiramento, comportamento intacto', () => {
  cfgOn();
  const stub = stubFetch(() => okResBoth(0.9));
  try {
    // Hint do play não carrega dubLieShadow: o throw é idêntico e nada é
    // medido — nem fila, nem métrica, nem rede.
    assert.throws(() => assertDubbedFiles([ARQUIVO_MENTIRA], true), DubLieError);
    // Título vazio ⇒ zero enqueue (a guarda é sobre o título, não o objeto).
    assert.throws(() => assertDubbedFiles([ARQUIVO_MENTIRA], true, { title: '', indexer: 'bludv' }), DubLieError);
    assert.doesNotThrow(() => assertDubbedFiles([ARQUIVO_HONESTO], true, null));
    assert.equal(stub.calls.length, 0);
    assert.equal(counter('typesafe.dublie.enqueue.ok'), 0);
    assert.equal(counter('typesafe.dublie.cache.miss'), 0);
  } finally {
    stub.restore();
  }
});
