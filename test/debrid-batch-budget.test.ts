import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batched } from '../src/debrid/common.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import * as premiumize from '../src/debrid/premiumize.js';
import * as torbox from '../src/debrid/torbox.js';
import type { DebridAdapter } from '../types/domain.js';

const hashes = (n: any, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;
const forceFreshOpts: { timeoutMs?: number; forceFresh?: boolean } = { forceFresh: true };

test('abortSafeCacheCheck:false com orçamento suficiente roda sem teto dinâmico', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const calls: { apiKey: string; infoHashes: string[]; options: { timeoutMs?: number } | undefined }[] = [];
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey: any, infoHashes: any, options: any) {
      calls.push({ apiKey, infoHashes, options });
      return new Set(infoHashes);
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-budget',
  };

  try {
    const result = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      // 750ms está acima do piso: a consulta disputa a corrida em vez de adiar
      // a checagem inteira para o passe tardio.
      () => debrid.checkCached(['hash-budget'], { timeoutMs: 750 }),
    );
    assert.equal(calls.length, 1, 'orçamento suficiente executa a consulta na primeira resposta');
    assert.equal(calls[0].options, undefined, 'a consulta não recebe teto dinâmico');
    assert.equal(result.known, true);
    assert.deepEqual([...result.cached], ['hash-budget']);
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('orçamento abaixo do piso não chama rede em consulta não abortável', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  let calls = 0;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached() {
      calls += 1;
      return new Set();
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-floor',
  };

  try {
    const result = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      // Abaixo do piso a consulta só atrasaria a resposta sem chance útil de
      // vencer — e, na AllDebrid, cada chamada é um upload de verdade.
      () => debrid.checkCached(['hash-floor'], { timeoutMs: 100 }),
    );
    assert.equal(result.known, false);
    assert.equal(result.cached.size, 0);
    assert.equal(calls, 0, 'abaixo do piso o upload nem começa');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('corrida perdida devolve unknown; o sem-teto junta a mesma consulta', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  let calls = 0;
  let openCheck: (value?: any) => void = () => {};
  const gate = new Promise((resolve) => { openCheck = resolve; });
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    checkCached(apiKey: any, infoHashes: any) {
      calls += 1;
      // Não resolve até o teste liberar: a corrida da primeira resposta perde
      // de propósito, mas o trabalho continua em background.
      return gate.then(() => new Set(infoHashes));
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-lost',
  };
  const hashes = ['hash-lost-a', 'hash-lost-b'];

  // O timer da corrida é unref'd (não segura o processo vivo). Num processo de
  // teste sem servidor isso deixaria o loop esvaziar antes dos 450ms e o runner
  // cancelaria o teste como pendente; o keepAlive ref'd segura o loop até lá.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const lost = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes, { timeoutMs: 450 }),
    );
    assert.equal(lost.known, false, 'a resposta não espera a consulta');
    assert.equal(lost.cached.size, 0);
    assert.equal(calls, 1, 'a consulta continua depois de perder a corrida');

    openCheck();

    // O passe tardio (sem teto) não pode repetir o upload: junta a mesma promise.
    const joined = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(joined.known, true);
    assert.deepEqual([...joined.cached].sort(), [...hashes].sort());
    assert.equal(calls, 1, 'o sem-teto junta a mesma promise, sem segundo upload');
  } finally {
    clearInterval(keepAlive);
    debrid.BY_ID.set('premiumize', original);
  }
});

test('resultado conhecido permanece coalescido para o passe tardio', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const calls: string[][] = [];
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey: any, infoHashes: any) {
      calls.push(infoHashes);
      return new Set(infoHashes);
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-known',
  };
  const hashes = ['hash-known-a', 'hash-known-b'];

  try {
    const first = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(first.known, true);

    // Resposta confiável vira dedupe curto: o passe tardio de uma segunda busca
    // não pode repetir o upload enquanto a consulta ainda vale (60s).
    const second = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(second.known, true);
    assert.deepEqual([...second.cached].sort(), [...hashes].sort());
    assert.equal(calls.length, 1, 'resultado conhecido continua coalescido');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('falha da consulta não abortável não fica memorizada', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  let calls = 0;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey: any, infoHashes: any) {
      calls += 1;
      if (calls === 1) throw new Error('serviço fora do ar');
      return new Set(infoHashes);
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-fail',
  };
  const hashes = ['hash-fail-a'];

  try {
    const failed = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(failed.known, false, 'falha vira unknown na hora');

    // Falha não pode ficar memorizada: se a segunda chamada juntasse a promise
    // morta, o ⚡ nunca se recuperaria quando o serviço voltasse.
    const recovered = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(recovered.known, true, 'chamada sem teto reexecuta o adaptador');
    assert.deepEqual([...recovered.cached], hashes);
    assert.equal(calls, 2, 'a segunda consulta roda de novo em vez de juntar a falha');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('resposta incompleta não fica memorizada e permite recuperar known', async () => {
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  let calls = 0;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey: any, infoHashes: any) {
      calls += 1;
      if (calls === 1) return { cached: new Set([infoHashes[0]]), complete: false };
      return { cached: new Set(infoHashes), complete: true };
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-incomplete',
  };
  const hashes = ['hash-inc-a', 'hash-inc-b'];

  try {
    const incomplete = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(incomplete.known, false, 'lote perdido não é "não tem"');

    const recovered = await runWith<{ cached: Set<string>; known: boolean }>(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(recovered.known, true);
    assert.deepEqual([...recovered.cached].sort(), [...hashes].sort());
    assert.equal(calls, 2, 'resposta incompleta não fica memorizada');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('Premiumize e TorBox aplicam o teto recebido na requisição real do adaptador', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  };
  globalThis.fetch = (async (url: any) => {
    const premiumizeRequest = String(url).includes('premiumize.me');
    return {
      ok: true,
      json: async () => premiumizeRequest
        ? { status: 'success', response: [true] }
        : { data: [{ hash: 'hash-torbox' }] },
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    const pm = await premiumize.checkCached('chave-fake', ['hash-premiumize'], { timeoutMs: 321 });
    const tb = await torbox.checkCached('chave-fake', ['hash-torbox'], { timeoutMs: 654 });
    assert.deepEqual([...pm.cached], ['hash-premiumize']);
    assert.deepEqual([...tb.cached], ['hash-torbox']);
    assert.deepEqual(timeouts, [321, 654]);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

