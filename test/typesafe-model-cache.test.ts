/**
 * Eco do model versionado no cache `tsj` + Retry-After do 529 no breaker —
 * SEM rede (§5/§8.1/§11 da referência Jev):
 *   1. resposta com `model: 'jev-1.13.0'` grava o ID versionado no `m` do
 *      cache: o alias de config (`jev-latest`) é móvel, então a auditoria
 *      precisa de quem de fato julgou — o alias só entra como fallback;
 *   2. a CHAVE do cache continua derivada do model PEDIDO (alias), que é o
 *      material da chamada — o eco muda o valor, não o endereço;
 *   3. 529 Overloaded (kind 'http') com `retry-after` arma cooldown pelo
 *      header, em vez do backoff exponencial longo de http.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch } from './helpers/stub.js';
import { resetTypesafeForTests, flushTypesafeForTests } from '../src/ai/index.js';
import { enqueueAudioJudgment, statusSnapshot } from '../src/ai/audio-judgment-queue.js';
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

test('cache grava o ID versionado ecoado, não o alias de config', async () => {
  cfgOn({ model: 'jev-latest' });
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ model: 'jev-1.13.0', answers: { is_ptbr_dub: { noul: 0.9 } } }),
  }));
  try {
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true), 'ok');
    await flushTypesafeForTests();
    // A chave continua derivada do model PEDIDO (alias): o eco muda o valor.
    const cached = cache.get(judgmentKey('Filme Dublado 1080p', 'jev-latest')) as any;
    assert.equal(cached?.n, 0.9);
    assert.equal(cached?.m, 'jev-1.13.0', 'o `m` é o eco versionado, não o alias');
  } finally {
    stub.restore();
  }
});

test('corpo sem eco do model: fallback preserva o alias de config', async () => {
  cfgOn({ model: 'jev-latest' });
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul: 0.8 } } }),
  }));
  try {
    assert.equal(enqueueAudioJudgment('Filme Dublado 1080p', true), 'ok');
    await flushTypesafeForTests();
    const cached = cache.get(judgmentKey('Filme Dublado 1080p', 'jev-latest')) as any;
    assert.equal(cached?.m, 'jev-latest', 'sem eco, o alias é o melhor registro disponível');
  } finally {
    stub.restore();
  }
});

test('529 com Retry-After arma cooldown pelo header, não pelo backoff', async () => {
  cfgOn();
  const stub = stubFetch(() => ({
    ok: false,
    status: 529,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) },
    text: async () => 'x',
  }));
  try {
    assert.equal(enqueueAudioJudgment('Filme A Dublado', true), 'ok');
    await flushTypesafeForTests();
    assert.equal(counter('typesafe.call.error.http'), 1);
    // Backoff exponencial de http com cooldownMs=60000 daria ~120s; o header
    // manda ~2s (teto de 5min do RATE_COOLDOWN_MAX_MS não é alcançado).
    const remaining = statusSnapshot().cooldownRemainingMs;
    assert.ok(remaining > 1000 && remaining <= 2200, `Retry-After ~2s, veio ${remaining}ms`);
  } finally {
    stub.restore();
  }
});
