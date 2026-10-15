import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { isBlockedError, isNoVideoError } from '../src/debrid/common.js';
import { RustWriteError } from '../src/debrid/rust-remote.js';

const TEST_KEY = 'chave-de-teste-rust';

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function hasHash(result: Set<string> | { cached: Set<string> }, hash: string): boolean {
  return result instanceof Set ? result.has(hash) : result.cached.has(hash);
}

/**
 * `AbortSignal.timeout` não expõe a duração (o símbolo interno só diz que
 * há prazo). O abort é o relógio: ~1,5s cabe; os 6s do DEBRID_TIMEOUT_MS não.
 */
function abortDelay(signal: AbortSignal | undefined, ceilingMs: number): Promise<number> {
  if (!signal) return Promise.reject(new Error('fetch sem AbortSignal'));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`signal não abortou em ${ceilingMs}ms`)), ceilingMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(Date.now() - started);
    }, { once: true });
  });
}

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

    // O mesmo test() segue: node:test paralelo dividiria o adaptador global.
    // O wrap captura globalThis.fetch; cada dublê precisa de um current() novo.
    adapter.checkCached = async (_apiKey, hashes) => {
      checks += 1;
      return new Set(hashes);
    };
    const useFetch = (impl: typeof fetch) => {
      globalThis.fetch = impl;
      const next = withPremiumize(() => debrid.current());
      if (!next) throw new Error('sem adaptador');
      return next;
    };

    checks = 0;
    let fetches = 0;
    let abortMs = -1;
    const timedAdapter = useFetch((async (_url: string, init?: RequestInit) => {
      fetches += 1;
      abortMs = await abortDelay(init?.signal ?? undefined, 2800);
      return new Response(JSON.stringify({ cached: [], complete: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
    const timed = await timedAdapter.checkCached(TEST_KEY, ['h-1500'], { timeoutMs: 1500 });
    assert.equal(fetches, 1);
    assert.equal(checks, 0);
    assert.ok(config.debrid.timeout >= 4000, `DEBRID_TIMEOUT_MS=${config.debrid.timeout} não separa 1,5s de 6s`);
    assert.ok(
      abortMs >= 1000 && abortMs <= 2800 && abortMs < config.debrid.timeout / 2,
      `AbortSignal abortou em ${abortMs}ms; DEBRID_TIMEOUT_MS=${config.debrid.timeout}`,
    );
    assert.equal(hasHash(timed, 'h-1500'), false);

    fetches = 0;
    checks = 0;
    const skippedAdapter = useFetch((async () => {
      fetches += 1;
      return new Response(JSON.stringify({ cached: ['h-zero'], complete: true }), { status: 200 });
    }) as typeof fetch);
    const skipped = await skippedAdapter.checkCached(TEST_KEY, ['h-zero'], { timeoutMs: 0 });
    assert.equal(fetches, 0, 'timeoutMs 0 não pode abrir fetch');
    assert.equal(checks, 0, 'timeoutMs 0 não pode chamar o checkCached do TS');
    assert.equal(hasHash(skipped, 'h-zero'), false);

    checks = 0;
    const portedAdapter = useFetch((async () => new Response(JSON.stringify({ error: 'service_not_ported' }), {
      status: 501,
    })) as typeof fetch);
    const ported = await portedAdapter.checkCached(TEST_KEY, ['h-501']);
    assert.equal(checks, 1, 'HTTP 501 da checagem ainda cai no TS');
    assert.equal(hasHash(ported, 'h-501'), true);

    const playCases: { status: number; body: { kind: string; message: string }; check: (err: unknown) => void }[] = [
      {
        status: 422,
        body: { kind: 'no_video', message: 'o torrent não contém nenhum arquivo de vídeo' },
        check(err) {
          assert.equal(isNoVideoError(err), true);
          assert.equal(errorCode(err), 'NO_VIDEO');
        },
      },
      {
        status: 409,
        body: { kind: 'episode_pick', message: `episódio ${TEST_KEY}` },
        check(err) { assert.equal(errorCode(err), 'EPISODE_PICK'); },
      },
      {
        status: 406,
        body: { kind: 'dub_lie', message: `dublagem ${TEST_KEY}` },
        check(err) { assert.equal(errorCode(err), 'DUB_LIE'); },
      },
      {
        status: 451,
        body: { kind: 'blocked', message: `bloqueado ${TEST_KEY}` },
        check(err) { assert.equal(isBlockedError(err), true); },
      },
      {
        status: 412,
        body: { kind: 'work_pick', message: `obra ${TEST_KEY}` },
        check(err) { assert.equal(errorCode(err), 'WORK_PICK'); },
      },
    ];
    for (const spec of playCases) {
      links = 0;
      const play = useFetch((async () => new Response(JSON.stringify(spec.body), {
        status: spec.status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch);
      await assert.rejects(() => play.resolveLink(TEST_KEY, 'abc'), (err: unknown) => {
        spec.check(err);
        assert.equal(errorMessage(err).includes(TEST_KEY), false, errorMessage(err));
        return true;
      });
      assert.equal(links, 0, `resolveLink do TS chamado no HTTP ${spec.status}`);
    }

    const remoteMisses: string[] = [];
    const missCases: { label: string; hash: string; respond: () => Promise<Response> }[] = [
      {
        label: 'rede',
        hash: 'h-net',
        respond: () => Promise.reject(new Error('rede caiu')),
      },
      {
        label: 'HTTP 500',
        hash: 'h-500',
        respond: async () => new Response(JSON.stringify({ error: 'other', kind: 'other', message: 'falhou' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      },
    ];
    for (const spec of missCases) {
      checks = 0;
      fetches = 0;
      const miss = useFetch((async () => {
        fetches += 1;
        return spec.respond();
      }) as typeof fetch);
      const result = await miss.checkCached(TEST_KEY, [spec.hash]);
      if (fetches !== 1) remoteMisses.push(`${spec.label}: fetch=${fetches}`);
      if (checks !== 0) remoteMisses.push(`${spec.label}: TS=${checks}`);
      if (hasHash(result, spec.hash)) remoteMisses.push(`${spec.label}: hash presente`);
    }
    assert.equal(remoteMisses.length, 0, remoteMisses.join('; '));
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
