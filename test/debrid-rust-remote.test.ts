import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { RustWriteError } from '../src/debrid/rust-remote.js';

function withPremiumize<T>(fn: () => T): T {
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'k' };
  return runtime.run({ opts }, fn);
}

config.jackett.testToken = config.jackett.testToken || 'token-de-teste';

test('flag vazia fica no TS; 501 lê no TS e não reescreve; 200 não chama o TS', async () => {
  const previous = config.debrid.rustServices.slice();
  const adapter = debrid.BY_ID.get('premiumize');
  if (!adapter) throw new Error('premiumize ausente');
  const savedCheck = adapter.checkCached;
  const savedLink = adapter.resolveLink;
  const realFetch = globalThis.fetch;
  try {
    config.debrid.rustServices = [];
    const plain = withPremiumize(() => debrid.current());
    assert.equal(plain, adapter);

    config.debrid.rustServices = ['premiumize'];
    let checks = 0;
    let links = 0;
    let calls = 0;
    adapter.checkCached = async () => {
      checks += 1;
      return new Set(['h']);
    };
    adapter.resolveLink = async () => {
      links += 1;
      return 'http://ts.example/video';
    };
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'service_not_ported' }), { status: 501 });
    }) as typeof fetch;
    const wrapped = withPremiumize(() => debrid.current());
    if (!wrapped) throw new Error('sem adaptador');
    const cached = await wrapped.checkCached('chave', ['h']);
    const hit = cached instanceof Set ? cached.has('h') : cached.cached.has('h');
    assert.equal(hit, true);
    assert.equal(checks, 1);
    await assert.rejects(() => wrapped.resolveLink('chave', 'abc'), (err: unknown) => {
      assert.ok(err instanceof RustWriteError);
      return true;
    });
    assert.equal(links, 0);
    assert.equal(calls, 2);

    checks = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({ cached: ['abc'], complete: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const again = withPremiumize(() => debrid.current());
    if (!again) throw new Error('sem adaptador');
    const direct = await again.checkCached('chave', ['abc']);
    const remoteHit = direct instanceof Set ? direct.has('abc') : direct.cached.has('abc');
    assert.equal(remoteHit, true);
    assert.equal(checks, 0);
  } finally {
    adapter.checkCached = savedCheck;
    adapter.resolveLink = savedLink;
    globalThis.fetch = realFetch;
    config.debrid.rustServices = previous;
  }
});

test('harness não finge paridade de serviço ainda não portado', () => {
  const self = spawnSync(process.execPath, ['scripts/rust/debrid-diff.mjs', '--self-test'], { encoding: 'utf8' });
  assert.equal(self.status, 0, self.stderr);
  const pending = spawnSync(process.execPath, ['scripts/rust/debrid-diff.mjs', '--service=premiumize'], { encoding: 'utf8' });
  assert.equal(pending.status, 2);
  assert.match(pending.stderr, /ainda não portado/);
});
