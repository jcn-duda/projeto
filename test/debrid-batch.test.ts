// Rodada 2: checagem ligada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batched } from '../src/debrid/common.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import * as premiumize from '../src/debrid/premiumize.js';
import * as torbox from '../src/debrid/torbox.js';
import type { DebridAdapter } from '../types/domain.js';

// O lote de checagem de cache é o ponto onde "não perguntei" virava "não tem":
// com `cachedOnly`, um lote perdido no timeout apagava 100 streams da lista,
// inclusive fontes BR que ESTAVAM em cache no serviço.

const hashes = (n: any, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// runtime.run devolve unknown (o callback do AsyncLocalStorage não infere o
// retorno); o helper fixa o tipo do resultado sem inventar valor nenhum.
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

// Objeto anotado para o literal viajar com o formato documentado das opções do
// registry (`{ timeoutMs?, forceFresh? }`) sem depender de inferência na
// assinatura importada.
const forceFreshOpts: { timeoutMs?: number; forceFresh?: boolean } = { forceFresh: true };

test('todos os lotes respondem: completo, com o Set inteiro', async () => {
  const { cached, complete } = await batched(hashes(5), 2, async (batch) => batch);
  assert.equal(complete, true);
  assert.deepEqual([...cached].sort(), hashes(5).sort());
});

test('um lote que falha marca a resposta como incompleta', async () => {
  const { cached, complete } = await batched(hashes(4), 2, async (batch) => {
    if (batch.includes('h0')) throw new Error('timeout');
    return batch;
  });
  // O que respondeu continua valendo — dá pra marcar o ⚡ de quem foi confirmado.
  assert.deepEqual([...cached].sort(), ['h2', 'h3']);
  // Mas quem não foi perguntado NÃO pode ser tratado como fora do cache.
  assert.equal(complete, false);
});

test('todos os lotes falhando sobe erro em vez de dizer "nada em cache"', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new Error('token inválido'); }),
    /nenhum lote/,
  );
});

test('lista vazia não vira falha', async () => {
  const { cached, complete } = await batched([], 100, async (batch) => batch);
  assert.equal(cached.size, 0);
  assert.equal(complete, true);
});

test('os lotes vão em paralelo, não em série', async () => {
  // Em série, dois lotes somavam dois timeouts inteiros (6s + 6s) contra um
  // REPLY_DEADLINE de 8,5s e a busca voltava vazia mesmo com tudo coletado.
  let running = 0;
  let peak = 0;
  await batched(hashes(6), 2, async (batch) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return batch;
  });
  assert.equal(peak, 3);
});

test('batched repassa o mesmo teto dinâmico para todos os lotes', async () => {
  const seen: { batch: string[]; options: { timeoutMs?: number } }[] = [];
  await batched(hashes(5), 2, async (batch, options) => {
    seen.push({ batch, options });
    return batch;
  }, { timeoutMs: 1234 });

  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((entry) => entry.options), [
    { timeoutMs: 1234 },
    { timeoutMs: 1234 },
    { timeoutMs: 1234 },
  ]);
});

test('batched sem teto preserva o timeout próprio do adaptador', async () => {
  const seen: { timeoutMs?: number }[] = [];
  await batched(hashes(2), 1, async (batch, options) => {
    seen.push(options);
    return batch;
  });
  assert.deepEqual(seen, [{ timeoutMs: undefined }, { timeoutMs: undefined }]);
});

test('checkCached degrada sem rede quando o prazo acabou e propaga teto positivo', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const calls: { apiKey: string; infoHashes: string[]; options: { timeoutMs?: number } | undefined }[] = [];
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Premiumize fake',
    cacheCheck: true,
    async checkCached(apiKey: any, infoHashes: any, options: any) {
      calls.push({ apiKey, infoHashes, options });
      return { cached: new Set(infoHashes), complete: true };
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
  };

  try {
    const expired = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['hash-a'], { timeoutMs: 0 }),
    );
    assert.equal(expired.known, false);
    assert.equal(expired.cached.size, 0);
    assert.equal(calls.length, 0, 'prazo esgotado não pode chamar o serviço');

    const bounded = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['hash-b'], { timeoutMs: 750 }),
    );
    assert.equal(bounded.known, true);
    assert.deepEqual([...bounded.cached], ['hash-b']);
    assert.deepEqual(calls[0], {
      apiKey: 'chave-fake',
      infoHashes: ['hash-b'],
      options: { timeoutMs: 750 },
    });
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('medição de repetição por hash: janela conta o que volta, ignora degradação', async () => {
  // A razão repeated/hashes na janela de 15 min é o gate do cache de
  // disponibilidade por hash; a medição não pode contar checagem que nem
  // chegou ao serviço (prazo esgotado), senão o número mente pra cima.
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Premiumize fake',
    cacheCheck: true,
    async checkCached(apiKey: any, infoHashes: any) {
      return { cached: new Set(infoHashes), complete: true };
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-tracking',
  };

  metrics.reset();
  try {
    // Degradação por prazo não é pergunta ao debrid: nada entra na janela.
    await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['track-degradado'], { timeoutMs: 0 }),
    );

    await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['track-AAA', 'track-bbb']),
    );
    // A janela normaliza caixa: 'aaa' casa com 'track-AAA' da busca anterior.
    // forceFresh (o mesmo escape do recheck do autofetch) impede o L1 do davail
    // de responder 'aaa' a partir do positivo gravado na chamada anterior — sem
    // ele a repetição sumiria da medição e o teste mediria só miss de cache.
    await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['track-aaa', 'track-ccc'], forceFreshOpts),
    );

    const counters = metrics.snapshot().counters;
    assert.equal(counters['debrid.check.hashes'], 4, 'só as checagens reais contam');
    assert.equal(counters['debrid.check.repeated'], 1, 'hash repetido na janela é contado');
    assert.equal(counters['debrid.check.cached'], 4, '⚡ conta hashes confirmados após cada merge completo');
  } finally {
    metrics.reset();
    debrid.BY_ID.set('premiumize', original);
  }
});
