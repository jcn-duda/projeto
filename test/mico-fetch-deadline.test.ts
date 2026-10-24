// Regressão do deadline DURO de rede do Mico (Mico travado ~16h, 2026-10-08):
// a busca ao vivo (`fetchMicoStreams`) tem de terminar SEMPRE (a página de
// catálogo do raspador é do sidecar Rust desde a Fase 6) — o `AbortSignal` nativo
// normalmente cobre o corpo, mas se o abort for ignorado/não chegar a promessa
// fica pendente. `fetchJsonWithin` rejeita a corrida pelo NOSSO timer
// (`TimeoutError`), então o corpo pendente é cortado. Sem rede real: stub de
// `global.fetch` + deadline curto.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const { fetchMicoStreams } = await import('../src/providers/mico.js');
const { stubFetch } = await import('./helpers/stub.js');

const savedTimeout = config.mico.timeout;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  config.mico.timeout = 40;
});

after(() => {
  config.mico.timeout = savedTimeout;
});

/** Erro rejeitado por `p`, `null` se resolver, `'hung'` se não terminar em 1s. */
async function settledError(p: Promise<unknown>): Promise<unknown> {
  return Promise.race([p.then(() => null, (err) => err), sleep(1000).then(() => 'hung' as const)]);
}

function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'TimeoutError';
}

test('fetchMicoStreams: corpo 200 que nunca termina é cortado com TimeoutError', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  try {
    const err = await settledError(fetchMicoStreams('https://mico.test/stream/movie/tt1234567.json', 40));
    assert.notEqual(err, 'hung', 'a promessa precisa terminar');
    assert.ok(isTimeoutError(err), `esperava TimeoutError, veio ${String((err as Error)?.name)}`);
  } finally {
    stub.restore();
  }
});

test('fetchMicoStreams: fetch que nunca resolve (nem headers) é cortado com TimeoutError', async () => {
  const stub = stubFetch(() => new Promise(() => {}));
  try {
    const err = await settledError(fetchMicoStreams('https://mico.test/stream/movie/tt1234567.json', 40));
    assert.notEqual(err, 'hung', 'a promessa precisa terminar');
    assert.ok(isTimeoutError(err), `esperava TimeoutError, veio ${String((err as Error)?.name)}`);
  } finally {
    stub.restore();
  }
});

test('fetchMicoStreams: 200 com corpo normal continua parseando', async () => {
  const stub = stubFetch(() => ({
    ok: true, status: 200,
    json: async () => ({ streams: [{ infoHash: 'a'.repeat(40), title: 'Obra (2000) 1080p DUBLADO\n👥 5', sources: [] }] }),
  }));
  try {
    const { items, ok } = await fetchMicoStreams('https://mico.test/stream/movie/tt1234567.json', 2000);
    assert.equal(ok, true);
    assert.equal(items.length, 1);
    assert.equal(items[0].infoHash, 'a'.repeat(40));
  } finally {
    stub.restore();
  }
});
