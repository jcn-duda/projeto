// O bloco `f3` do painel lê a medição do gateway e nunca pinta 0% sem medir.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import config from '../src/config.js';
import { brCoverageStatus } from '../src/utils/br-coverage-native.js';

const realFetch = globalThis.fetch;
const savedUrl = config.streamStore.url;
const savedToken = config.streamStore.token;
afterEach(() => {
  globalThis.fetch = realFetch;
  config.streamStore.url = savedUrl;
  config.streamStore.token = savedToken;
});

function configured() {
  config.streamStore.url = 'http://127.0.0.1:8711/';
  config.streamStore.token = 'tok';
}

test('ecoa a medição do gateway com o token no header', async () => {
  configured();
  const seen: { url: string; token: string | null }[] = [];
  const body = { enabled: true, samples: 2, latest: { targetWorks: 10 }, popularCoverage: 0.5 };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), token: new Headers(init.headers).get('x-indexer-test-token') });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await brCoverageStatus(), body);
  assert.deepEqual(seen, [{ url: 'http://127.0.0.1:8711/br-coverage', token: 'tok' }]);
});

for (const [name, respond] of [
  ['queda', async () => { throw new Error('ECONNREFUSED'); }],
  ['HTTP 404 de gateway velho', async () => new Response('{}', { status: 404 })],
  ['corpo fora do contrato', async () => new Response('{"ok":true}', { status: 200 })],
] as const) {
  test(`${name} vira "não medido", sem 0% falso`, async () => {
    configured();
    globalThis.fetch = respond as unknown as typeof fetch;
    const status = await brCoverageStatus();
    assert.equal(status.popularCoverage, null);
    assert.equal(status.latest, null);
    assert.deepEqual(status._origem, { popularCoverage: 'naomedido', brWarmRate: 'naomedido', discoveryRate: 'naomedido' });
  });
}
