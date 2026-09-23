/**
 * Fila assíncrona do julgamento TypeSafe — contratos do slice SEM rede:
 *   1. kill-switch OFF (sem flag ou sem chave): zero fetch, zero leitura e
 *      zero escrita de cache — inércia por construção;
 *   2. dedupe por fingerprint, cache-hit evita re-chamada;
 *   3. teto duro de fila (queue-full), orçamento hora (cap) e dia (day-cap);
 *   4. cooldown/breaker após falha, auth-stop em 401/403, rate com Retry-After;
 *   5. comparação shadow produz SÓ métrica (agree/disagree);
 *   6. drain com kill-switch ligado no meio descarta a fila SEM rede.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import {
  resetTypesafeForTests,
  flushTypesafeForTests,
} from '../src/ai/index.js';
import {
  enqueueAudioJudgment,
  statusSnapshot,
} from '../src/ai/audio-judgment-queue.js';
import {
  enqueueDubLieJudgment,
  dubLieStatusSnapshot,
  flushDubLieForTests,
} from '../src/ai/dub-lie-judgment-queue.js';
import { judgmentKey } from '../src/ai/audio-judgment-cache.js';

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
  text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul } } }),
});

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);

beforeEach(() => {
  resetTypesafeForTests();
  cache.clearNamespace('tsj');
  metrics.reset();
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('kill-switch OFF: zero fetch, zero cache — inércia por construção', () => {
  cfgOn({ enabled: false });
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true, 'origin-global'), 'disabled');
    assert.equal(stub.calls.length, 0, 'nenhum fetch');
    // Nem LEITURA de cache: o contador do namespace nem aparece.
    assert.equal(counter('cache.miss.tsj'), 0);
    assert.equal(cache.has(judgmentKey('Filme Dublado 1080p', 'jev-test')), false);
    // Sem chave também é disabled (chave vazia ≠ enabled).
    cfgOn({ enabled: true, apiKey: '' });
    assert.equal(enqueueAudioJudgment('Outro Dublado', true, 'origin-global'), 'disabled');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('ok: chama, grava cache e concorda no shadow', async () => {
  cfgOn();
  // 'Dublado' → looksPtBr true; noul 0.9 concorda.
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(stub.calls.length, 1);
    assert.equal(counter('typesafe.call.ok'), 1);
    assert.equal(counter('typesafe.shadow.agree'), 1);
    assert.equal(counter('typesafe.shadow.disagree'), 0);
    const cached = cache.get(judgmentKey('Filme Dublado 1080p', 'jev-test')) as any;
    assert.equal(cached?.n, 0.9, 'julgamento cru no cache');
    assert.equal(cached?.m, 'jev-test');
    assert.ok(cached?.at > 0);
    assert.ok(counter('typesafe.tokens.in') >= 0);
  } finally {
    stub.restore();
  }
});

test('disagree: divergência vira métrica com lado fixo, nunca decisão', async () => {
  cfgOn();
  // Título sem marca PT (det=false) e modelo dizendo pt-BR (0.9): divergência.
  // Origem `origin-br` (item de vaga BR): a divergência tem que aparecer TAMBÉM
  // por dimensão, além das métricas antigas por lado.
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Movie.English.2014.1080p.x264', false, 'origin-br'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.shadow.disagree'), 1);
    assert.equal(counter('typesafe.shadow.disagree.ai-pt'), 1);
    assert.equal(counter('typesafe.shadow.disagree.rule-pt'), 0);
    // Dimensão FECHADA: o lado que divergiu + a origem da release.
    assert.equal(counter('typesafe.shadow.disagree.ai-pt.origin-br'), 1);
    assert.equal(counter('typesafe.shadow.disagree.rule-pt.origin-br'), 0);
    assert.equal(counter('typesafe.shadow.disagree.ai-pt.origin-global'), 0);
  } finally {
    stub.restore();
  }
});

test('disagree por dimensão: origem global usa o outro lado fechado', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Another.English.2020.1080p', false, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.shadow.disagree.ai-pt.origin-global'), 1);
    assert.equal(counter('typesafe.shadow.disagree.ai-pt.origin-br'), 0);
    // Métrica antiga por lado segue intocada e independente da dimensão.
    assert.equal(counter('typesafe.shadow.disagree.ai-pt'), 1);
    assert.equal(counter('typesafe.shadow.disagree'), 1);
  } finally {
    stub.restore();
  }
});

test('dedupe: mesmo título em voo não re-enfileira', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true, 'origin-global'), 'ok');
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true, 'origin-global'), 'dedup');
    assert.equal(counter('typesafe.enqueue.dedup'), 1);
    // Esvazia a fila COM o stub vivo: garante que o drain armado não sobrevive
    // ao teste e não cai no fetch global depois do restore.
    await flushTypesafeForTests();
  } finally {
    stub.restore();
  }
});

test('cache-hit: julgamento existente não re-chama', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    const callsAfterFirst = stub.calls.length;
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true, 'origin-global'), 'cache-hit');
    assert.equal(stub.calls.length, callsAfterFirst, 'sem nova chamada');
    assert.equal(counter('typesafe.cache.hit'), 1);
  } finally {
    stub.restore();
  }
});

test('queue-full: teto duro da fila descarta, sem fila infinita', async () => {
  cfgOn({ queueMax: 1 });
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    assert.equal(enqueueAudioJudgment('Filme B Dublado', true, 'origin-global'), 'queue-full');
    assert.equal(counter('typesafe.enqueue.queue-full'), 1);
    assert.equal(statusSnapshot().queueDepth, 1);
    // Esvazia com o stub vivo (mesma razão do teste de dedupe).
    await flushTypesafeForTests();
  } finally {
    stub.restore();
  }
});

test('cap hora: orçamento horário corta', async () => {
  cfgOn({ hourlyCap: 1 });
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(stub.calls.length, 1);
    assert.equal(enqueueAudioJudgment('Filme B Dublado', true, 'origin-global'), 'cap');
    assert.equal(counter('typesafe.enqueue.cap'), 1);
  } finally {
    stub.restore();
  }
});

test('day-cap: orçamento diário corta', async () => {
  cfgOn({ dailyCap: 1, hourlyCap: 100 });
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(enqueueAudioJudgment('Filme B Dublado', true, 'origin-global'), 'day-cap');
    assert.equal(counter('typesafe.enqueue.day-cap'), 1);
  } finally {
    stub.restore();
  }
});

test('falha http arma cooldown (breaker) e enqueue recusa', async () => {
  cfgOn();
  const stub = stubFetch(() => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'x' }));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.call.error.http'), 1);
    assert.ok(counter('typesafe.breaker.open') >= 1);
    // Falha NÃO propaga e NÃO re-enfileira: 1 tentativa por item.
    assert.equal(stub.calls.length, 1);
    // Próximo título cai no cooldown.
    assert.equal(enqueueAudioJudgment('Filme B Dublado', true, 'origin-global'), 'cooldown');
    assert.ok(statusSnapshot().cooldownRemainingMs > 0);
  } finally {
    stub.restore();
  }
});

test('auth 401/403: para 30min, um warn, e a busca segue (fail-open)', async () => {
  cfgOn();
  const stub = stubFetch(() => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'x' }));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.call.error.auth'), 1);
    assert.equal(counter('typesafe.auth.stop'), 1);
    assert.ok(statusSnapshot().cooldownRemainingMs > 25 * 60 * 1000, 'cooldown de auth é longo');
  } finally {
    stub.restore();
  }
});

test('rate 429 honra Retry-After no cooldown', async () => {
  cfgOn();
  const stub = stubFetch(() => ({
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) },
    text: async () => 'x',
  }));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.call.error.rate'), 1);
    const remaining = statusSnapshot().cooldownRemainingMs;
    assert.ok(remaining > 1000 && remaining <= 2000 + 200, `Retry-After ~2s, veio ${remaining}ms`);
  } finally {
    stub.restore();
  }
});

test('orçamento/breaker COMPARTILHADOS: rate na pergunta 1 bloqueia a pergunta 2', async () => {
  cfgOn();
  const stub = stubFetch(() => ({
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '30' : null) },
    text: async () => 'x',
  }));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.call.error.rate'), 1);
    assert.ok(statusSnapshot().cooldownRemainingMs > 0, 'o breaker arma cooldown');
    // Orçamento é UMA instância: os dois snapshots leem os mesmos contadores.
    assert.equal(
      dubLieStatusSnapshot().hourlyUsed,
      statusSnapshot().hourlyUsed,
      'orçamento é o mesmo nas duas perguntas',
    );
    // A pergunta 2 é recusada pelo MESMO breaker (não pela fila dela): nenhuma
    // segunda chamada sai.
    assert.equal(enqueueDubLieJudgment('Filme B DUBLADO', 'bludv', ['b.mkv'], true), 'cooldown');
    assert.equal(counter('typesafe.dublie.enqueue.cooldown'), 1);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('orçamento/breaker COMPARTILHADOS: rate na pergunta 2 bloqueia a pergunta 1', async () => {
  cfgOn();
  const stub = stubFetch(() => ({
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '30' : null) },
    text: async () => 'x',
  }));
  try {
    assert.equal(enqueueDubLieJudgment('Filme A DUBLADO', 'bludv', ['a.mkv'], true), 'ok');
    await flushDubLieForTests();
    assert.equal(counter('typesafe.dublie.call.error.rate'), 1);
    // Caminho inverso: o cooldown armado pela pergunta 2 recusa a pergunta 1.
    assert.equal(enqueueAudioJudgment('Filme B Dublado', true, 'origin-global'), 'cooldown');
    assert.equal(counter('typesafe.enqueue.cooldown'), 1);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('kill-switch no meio: drain descarta a fila SEM rede', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    assert.equal(enqueueAudioJudgment('Filme B Dublado', true, 'origin-global'), 'ok');
    cfgOn({ enabled: false });
    await flushTypesafeForTests();
    assert.equal(stub.calls.length, 0, 'nenhuma chamada após OFF');
    assert.equal(statusSnapshot().queueDepth, 0, 'fila descartada');
  } finally {
    stub.restore();
  }
});

test('aiStatus: resumo compacto coerente com a fila', async () => {
  cfgOn();
  const stub = stubFetch(() => okRes(0.9));
  try {
    const before = statusSnapshot();
    assert.equal(before.enabled, true);
    assert.equal(before.model, 'jev-test');
    assert.equal(before.promptVersion, 'audio-classify-q1');
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true, 'origin-global'), 'ok');
    await flushTypesafeForTests();
    const after = statusSnapshot();
    assert.equal(after.hourlyUsed, 1);
    assert.equal(after.dailyUsed, 1);
    assert.equal(after.inFlight, 0);
  } finally {
    stub.restore();
  }
});
