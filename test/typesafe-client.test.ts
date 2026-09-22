/**
 * Cliente TypeSafe (única dona do fetch) — contratos do slice, SEM rede:
 *   1. allowlist: o estado enviado carrega SÓ `post_title`;
 *   2. segredo SÓ no header `Authorization: Bearer` — nunca em mensagem de
 *      erro, nunca no corpo;
 *   3. kinds FECHADOS: 401/403→auth, 429→rate, outro !ok→http, abort→timeout,
 *      falha de fetch→network, corpo sem noul válido→shape;
 *   4. parse defensivo: não-JSON e noul fora de [0,1] não viram número.
 * 1 tentativa é contrato do chamador (fila): o cliente não tem retry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import { askJevAudio, AskError } from '../src/ai/typesafe-client.js';

const KEY = 'tsk-secret-abc123';
const BASE = { endpoint: 'https://ts.test/v1/systemone', apiKey: KEY, model: 'jev-test', title: 'Filme Dublado 1080p', timeoutMs: 3000 };

const okRes = (body: any, status = 200, headers?: any) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: headers || { get: () => null },
  text: async () => JSON.stringify(body),
});

test('sucesso: noul + usage, Bearer no header, estado só post_title', async () => {
  let stub: FetchStub | null = stubFetch(() =>
    okRes({ answers: { is_ptbr_dub: { noul: 0.83 } }, usage: { input_tokens: 41, output_tokens: 3 } }),
  );
  try {
    const res = await askJevAudio(BASE);
    assert.equal(res.noul, 0.83);
    assert.deepEqual(res.usage, { input: 41, output: 3 });
    const call = stub.calls[0];
    assert.equal(call.options?.headers && (call.options.headers as any).Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(String(call.options?.body));
    assert.deepEqual(Object.keys(body.state), ['post_title'], 'allowlist: só post_title');
    assert.equal(body.state.post_title, BASE.title);
    assert.equal(body.model, 'jev-test');
    assert.ok(body.questions.is_ptbr_dub, 'pergunta is_ptbr_dub vai no corpo');
  } finally {
    stub.restore();
  }
});

test('kinds: 401/403→auth, 429→rate (+Retry-After), 500→http', async () => {
  for (const [status, kind, headers] of [
    [401, 'auth', null],
    [403, 'auth', null],
    [429, 'rate', { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) }],
    [500, 'http', null],
  ] as const) {
    const stub = stubFetch(() => okRes({ erro: 'x' }, status as number, headers));
    try {
      await assert.rejects(
        () => askJevAudio(BASE),
        (e: any) => e instanceof AskError && e.kind === kind,
      );
    } finally {
      stub.restore();
    }
  }
});

test('429 honra Retry-After em ms', async () => {
  const stub = stubFetch(() =>
    okRes({}, 429, { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) }),
  );
  try {
    await assert.rejects(
      () => askJevAudio(BASE),
      (e: any) => e instanceof AskError && e.kind === 'rate' && e.retryAfterMs === 2000,
    );
  } finally {
    stub.restore();
  }
});

test('timeout: estouro do AbortSignal vira kind timeout', async () => {
  const stub = stubFetch((_url, options) => {
    const signal = (options as any)?.signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
      );
    });
  });
  try {
    await assert.rejects(
      () => askJevAudio({ ...BASE, timeoutMs: 40 }),
      (e: any) => e instanceof AskError && e.kind === 'timeout',
    );
  } finally {
    stub.restore();
  }
});

test('rede: falha do fetch vira kind network', async () => {
  const stub = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    await assert.rejects(
      () => askJevAudio(BASE),
      (e: any) => e instanceof AskError && e.kind === 'network',
    );
  } finally {
    stub.restore();
  }
});

test('shape: não-JSON, envelope estranho e noul fora de [0,1] não viram número', async () => {
  const bodies = [
    'isto não é json',
    JSON.stringify({ answers: {} }),
    JSON.stringify({ answers: { is_ptbr_dub: { noul: '0.9' } } }),
    JSON.stringify({ answers: { is_ptbr_dub: { noul: 1.5 } } }),
    JSON.stringify({ answers: { is_ptbr_dub: { noul: -0.1 } } }),
  ];
  for (const raw of bodies) {
    const stub = stubFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => raw,
    }));
    try {
      await assert.rejects(
        () => askJevAudio(BASE),
        (e: any) => e instanceof AskError && e.kind === 'shape',
      );
    } finally {
      stub.restore();
    }
  }
});

test('nenhum erro vaza a chave na mensagem', async () => {
  const stub = stubFetch(() => okRes({}, 401));
  try {
    try {
      await askJevAudio(BASE);
      assert.fail('deveria rejeitar');
    } catch (e: any) {
      assert.ok(!String(e.message).includes(KEY), 'mensagem sem chave');
      assert.ok(!String(e.stack).includes(KEY), 'stack sem chave');
    }
  } finally {
    stub.restore();
  }
});
