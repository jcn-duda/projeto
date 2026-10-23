import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import config from '../src/config.js';
import { abortDelay, errorCode, errorMessage, hasHash, unreachableCount, withPremiumize } from './helpers/rust-remote-stub.js';
import debrid from '../src/debrid/index.js';
import { AuthError, EpisodePickError, isBlockedError, isNoVideoError } from '../src/debrid/common.js';
import { RustWriteError } from '../src/debrid/rust-remote.js';
import * as metrics from '../src/utils/metrics.js';

const TEST_KEY = 'chave-de-teste-rust';

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
    const unreachableBeforeSkip = unreachableCount();
    const skipped = await skippedAdapter.checkCached(TEST_KEY, ['h-zero'], { timeoutMs: 0 });
    assert.equal(fetches, 0, 'timeoutMs 0 não pode abrir fetch');
    assert.equal(checks, 0, 'timeoutMs 0 não pode chamar o checkCached do TS');
    assert.equal(hasHash(skipped, 'h-zero'), false);
    assert.equal(unreachableCount(), unreachableBeforeSkip, 'timeoutMs 0 não é a API caída');

    checks = 0;
    const portedAdapter = useFetch((async () => new Response(JSON.stringify({ error: 'service_not_ported' }), {
      status: 501,
    })) as typeof fetch);
    const unreachableBefore501 = unreachableCount();
    const ported = await portedAdapter.checkCached(TEST_KEY, ['h-501']);
    assert.equal(checks, 1, 'HTTP 501 da checagem ainda cai no TS');
    assert.equal(hasHash(ported, 'h-501'), true);
    assert.equal(unreachableCount(), unreachableBefore501, 'HTTP 501 não conta a checagem como inacessível');

    const playCases: { status: number; body: { kind: string; message: string }; check: (err: unknown) => void }[] = [
      { status: 422, body: { kind: 'no_video', message: 'o torrent não contém nenhum arquivo de vídeo' },
        check(err) { assert.equal(isNoVideoError(err), true); assert.equal(errorCode(err), 'NO_VIDEO'); } },
      { status: 409, body: { kind: 'episode_pick', message: `episódio ${TEST_KEY}` },
        check(err) { assert.equal(errorCode(err), 'EPISODE_PICK'); } },
      { status: 406, body: { kind: 'dub_lie', message: `dublagem ${TEST_KEY}` },
        check(err) { assert.equal(errorCode(err), 'DUB_LIE'); } },
      { status: 451, body: { kind: 'blocked', message: `bloqueado ${TEST_KEY}` },
        check(err) { assert.equal(isBlockedError(err), true); } },
      { status: 412, body: { kind: 'work_pick', message: `obra ${TEST_KEY}` },
        check(err) { assert.equal(errorCode(err), 'WORK_PICK'); } },
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

    links = 0;
    const episodePlay = useFetch((async () => new Response(JSON.stringify({
      error: 'episode_pick', kind: 'episode_pick', message: `episódio ausente ${TEST_KEY}`,
      evidence: { wantedSeason: 2, wantedEpisode: 5, declaredSeasons: [2], declaredEpisodes: [4, 6], sample: 'Serie.S02E04.mkv' },
      context: { videoCount: 3, samples: ['Serie.S02E04.mkv', 'Serie.S02E06.mkv'] },
    }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch);
    await assert.rejects(() => episodePlay.resolveLink(TEST_KEY, 'abc'), (err: unknown) => {
      assert.ok(err instanceof EpisodePickError);
      if (!(err instanceof EpisodePickError)) return false;
      assert.deepEqual(err.evidence?.declaredSeasons, [2]);
      assert.deepEqual(err.evidence?.declaredEpisodes, [4, 6]);
      assert.equal(err.evidence?.sample, 'Serie.S02E04.mkv');
      assert.equal(err.context?.videoCount, 3);
      assert.deepEqual(err.context?.samples, ['Serie.S02E04.mkv', 'Serie.S02E06.mkv']);
      assert.equal(errorMessage(err).includes(TEST_KEY), false, errorMessage(err));
      return true;
    });
    assert.equal(links, 0, 'resolveLink do TS chamado no episode_pick com prova');

    const remoteMisses: string[] = [];
    const missCases: { label: string; hash: string; respond: () => Promise<Response> }[] = [
      { label: 'rede', hash: 'h-net', respond: () => Promise.reject(new Error('rede caiu')) },
      { label: 'HTTP 500', hash: 'h-500',
        respond: async () => new Response(JSON.stringify({ error: 'other', kind: 'other', message: 'falhou' }), {
          status: 500, headers: { 'content-type': 'application/json' } }) },
    ];
    for (const spec of missCases) {
      checks = 0;
      fetches = 0;
      const beforeUnreachable = unreachableCount();
      const miss = useFetch((async () => { fetches += 1; return spec.respond(); }) as typeof fetch);
      // Dois hashes na rede: o contador é da checagem, não de cada hash.
      const hashes = spec.label === 'rede' ? [spec.hash, 'h-net-extra'] : [spec.hash];
      const result = await miss.checkCached(TEST_KEY, hashes);
      const gained = unreachableCount() - beforeUnreachable;
      if (fetches !== 1) remoteMisses.push(`${spec.label}: fetch=${fetches}`);
      if (checks !== 0) remoteMisses.push(`${spec.label}: TS=${checks}`);
      if (hasHash(result, spec.hash)) remoteMisses.push(`${spec.label}: hash presente`);
      if (gained !== 1) remoteMisses.push(`${spec.label}: unreachable=${gained}`);
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

test('play AllDebrid pelo Rust grava davail=0 do frio e a prova dos arquivos', async () => {
  const { wrap } = await import('../src/debrid/rust-remote.js');
  const { peekDavail } = await import('../src/debrid/cache-check.js');
  const { peekFileSizes } = await import('../src/debrid/file-sizes.js');
  const adapter = debrid.BY_ID.get('alldebrid');
  if (!adapter) throw new Error('alldebrid ausente');
  const savedTtl = config.debrid.availNegTtl;
  config.debrid.availNegTtl = 3600;
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  const remote = (impl: typeof fetch) => wrap(adapter, { token: 'tok', fetchImpl: impl });
  try {
    // Frio que a guarda do delete liberou: a busca seguinte não pinta ⚡ nele.
    const cold = 'c'.repeat(40);
    const link = await remote(reply(200, { url: null, unavailable: true })).resolveLink(TEST_KEY, cold);
    assert.equal(link, null);
    assert.equal(peekDavail('alldebrid', TEST_KEY, cold), 0);

    // Frio protegido (unavailable false): nada de negativo.
    const held = 'd'.repeat(40);
    await remote(reply(200, { url: null, unavailable: false })).resolveLink(TEST_KEY, held);
    assert.equal(peekDavail('alldebrid', TEST_KEY, held), null);

    // Pronto: devolve o link e grava os tamanhos que a listagem lê.
    const ready = 'e'.repeat(40);
    const url = await remote(reply(200, {
      url: 'https://cdn.example/ep2', unavailable: false,
      files: [{ path: 'Show/Show.S01E01.1080p.mkv', size: 111 }, { path: 'Show/Show.S01E02.1080p.mkv', size: 222 }],
    })).resolveLink(TEST_KEY, ready, { season: 1, episode: 2 });
    assert.equal(url, 'https://cdn.example/ep2');
    const sizes = peekFileSizes(ready) as Array<{ path?: string; size?: number }> | null;
    assert.ok(sizes && sizes.some((f) => f.size === 222), 'prova de tamanho gravada');

    // Mentira de dublagem: a prova entra antes do erro, como no TS.
    const lie = 'f'.repeat(40);
    await assert.rejects(() => remote(reply(406, {
      error: 'dub_lie', kind: 'dub_lie', message: 'mentira',
      files: [{ path: 'Movie.2024.ENG.1080p.mkv', size: 333 }],
    })).resolveLink(TEST_KEY, lie));
    const lieSizes = peekFileSizes(lie) as Array<{ size?: number }> | null;
    assert.ok(lieSizes && lieSizes.some((f) => f.size === 333));
  } finally {
    config.debrid.availNegTtl = savedTtl;
  }
});

test('pullMetrics devolve só `rust.debrid.*` e marca unreachable sem a 8710', async () => {
  const { pullMetrics } = await import('../src/debrid/rust-remote.js');
  const saved = { fetch: globalThis.fetch, native: config.nativeMetrics };
  const reply = (body: Record<string, number>) => (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  try {
    config.nativeMetrics = {
      // A 8710 só recebe o token em loopback; o fetch é dublê, nada sai daqui.
      gatewayUrl: 'http://gw.local', debridUrl: 'http://127.0.0.1:8710', token: 'tok', timeoutMs: 100,
    };
    globalThis.fetch = reply({ 'index.rust.hit': 3, 'rust.debrid.check.hit': 9 });
    assert.deepEqual(await pullMetrics(), { 'rust.debrid.check.hit': 9 }, 'índice da 7000 não vaza no recorte legado');
    globalThis.fetch = (async () => { throw new Error('fora'); }) as unknown as typeof fetch;
    assert.deepEqual(await pullMetrics(), { 'rust.debrid.metrics.unreachable': 1 });
  } finally {
    globalThis.fetch = saved.fetch;
    config.nativeMetrics = saved.native;
  }
});

// Fase 0.2 (`adrm`): `blocked` do outcome nativo só vira ⚡ com PROVA no `dinv`.
test('escape do adrm no caminho nativo: só o inventário PRONTO devolve o ⚡', async () => {
  const { wrap } = await import('../src/debrid/rust-remote.js');
  const adrm = await import('../src/debrid/alldebrid-reupload.js');
  const memo = await import('../src/debrid/inventory-memo.js');
  const { accountScope } = await import('../src/utils/request-key.js');
  const adapter = debrid.BY_ID.get('alldebrid');
  if (!adapter) throw new Error('alldebrid ausente');
  const key = 'chave-de-teste-adrm-nativo';
  const account = accountScope(key);
  const provado = 'a'.repeat(40);
  const semProva = 'b'.repeat(40);
  const saved = { block: config.debrid.reuploadBlock, ttl: config.debrid.alldebridReuploadBlockTtlMs, cleanup: config.debridRust.alCleanup };
  Object.assign(config.debrid, { reuploadBlock: true, alldebridReuploadBlockTtlMs: 3600_000 });
  config.debridRust.alCleanup = false; // sem fatos: o teste mede o escape
  const reply = (async () => new Response(JSON.stringify({ cached: [], blocked: [provado, semProva], complete: true }), { status: 200 })) as unknown as typeof fetch;
  const native = wrap(adapter, { token: 'tok', fetchImpl: reply });
  const unblocked = () => metrics.snapshot().counters['rust.debrid.check.unblockedByInventory'] || 0;
  try {
    for (const hash of [provado, semProva]) assert.equal(adrm.markReuploadBlocked(account, hash, 'Some.Movie.2024.1080p.WEB-DL.mkv'), true);
    // Memo frio: sem prova o ⚡ não nasce e a marca fica.
    const antes = unblocked();
    const frio = await native.checkCached(key, [provado, semProva]);
    assert.equal(hasHash(frio, provado) || hasHash(frio, semProva), false, 'memo frio não inventa ⚡');
    assert.equal(adrm.reuploadBlocked(account, provado), true, 'sem prova a marca fica');
    assert.equal(unblocked(), antes, 'sem prova não conta destrave');
    // Só `provado` reaparece PRONTO no inventário da conta (memo dinv).
    memo.store('alldebrid', key, [{ title: 'Some.Movie.2024', infoHash: provado, size: 1 }]);
    const quente = await native.checkCached(key, [provado, semProva]);
    assert.equal(hasHash(quente, provado), true, 'pronto no dinv entra no cached');
    assert.equal(hasHash(quente, semProva), false, 'hash sem prova segue escondido');
    assert.equal(adrm.reuploadBlocked(account, provado), false, 'adrm expurgado com prova');
    assert.equal(adrm.reuploadBlocked(account, semProva), true, 'marca do outro intacta');
    assert.equal(unblocked(), antes + 1, 'um destrave por hash provado');
  } finally {
    for (const hash of [provado, semProva]) { memo.forget('alldebrid', key, hash); adrm.forgetReuploadBlock(account, hash); }
    Object.assign(config.debrid, { reuploadBlock: saved.block, alldebridReuploadBlockTtlMs: saved.ttl });
    config.debridRust.alCleanup = saved.cleanup;
  }
});

// Fase 3.2 do plano: o 200 da 8710 com `unusable` é conta recusada, não "não sei".
test('envelope 200 com unusable vira conta recusada, sem cair no TS', async () => {
  const adapter = debrid.BY_ID.get('premiumize');
  if (!adapter) throw new Error('premiumize ausente');
  const saved = { services: config.debrid.rustServices.slice(), check: adapter.checkCached, fetch: globalThis.fetch };
  const counter = (name: string) => metrics.snapshot().counters[name] || 0;
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  // Chave e hash únicos: davail e memo de checagem casam por conta+hash.
  const run = (tag: string) => withPremiumize(() => debrid.checkCached([`${tag}${'0'.repeat(39)}`]), tag);
  let tsChecks = 0;
  try {
    config.debrid.rustServices = ['premiumize'];
    adapter.checkCached = async (_key, hashes) => { tsChecks += 1; return new Set(hashes); };
    globalThis.fetch = reply({ cached: [], known: false, complete: false, unusable: { reason: 'auth', message: 'invalid key' } });
    const authBefore = counter('debrid.auth.invalid');
    const auth = await run('chave-unusable-9a');
    assert.deepEqual([auth.known, auth.cached.size, auth.unusable?.reason], [false, 0, 'auth']);
    assert.equal(counter('debrid.auth.invalid') - authBefore, 1, 'métrica de credencial recusada');
    globalThis.fetch = reply({ cached: [], known: false, complete: false, unusable: { reason: 'quota', message: 'MAGNET_TOO_MANY' } });
    const quotaBefore = counter('debrid.quota.exceeded');
    const quota = await run('chave-unusable-9b');
    assert.deepEqual([quota.known, quota.unusable?.reason], [false, 'quota']);
    assert.equal(counter('debrid.quota.exceeded') - quotaBefore, 1, 'métrica de conta no teto');
    globalThis.fetch = reply({ cached: [], known: true, complete: true });
    const plain = await run('chave-unusable-9c');
    assert.deepEqual([plain.known, plain.cached.size, plain.unusable], [true, 0, undefined], 'sem unusable nada regrediu');
    assert.equal(tsChecks, 0, 'envelope 200 nunca cai no checkCached do TS');
  } finally {
    adapter.checkCached = saved.check;
    globalThis.fetch = saved.fetch;
    config.debrid.rustServices = saved.services;
  }
});

// Fase 3.1: conta e arquivos não repetem a pergunta quando o serviço já recusou.
test('conta e arquivos: recusa sobe sem segunda pergunta; 501 e queda caem no TS', async () => {
  const adapter = debrid.BY_ID.get('premiumize');
  if (!adapter) throw new Error('premiumize ausente');
  const saved = { services: config.debrid.rustServices.slice(), account: adapter.accountStatus, fileLink: adapter.fileLink, fetch: globalThis.fetch };
  const counter = (name: string) => metrics.snapshot().counters[name] || 0;
  let tsAccount = 0;
  let tsFiles = 0;
  try {
    config.debrid.rustServices = ['premiumize'];
    adapter.accountStatus = async () => { tsAccount += 1; return { magnets: 3 }; };
    adapter.fileLink = async () => { tsFiles += 1; return { url: 'http://ts.example/f', size: 9 }; };
    const reply = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const current = (tag: string) => {
      const wrapped = withPremiumize(() => debrid.current(), `chave-${tag}`);
      if (!wrapped) throw new Error('sem adaptador');
      return wrapped;
    };
    globalThis.fetch = reply(403, { kind: 'auth', message: 'invalid key' });
    await assert.rejects(() => current('a').accountStatus!('k-a'), (err: unknown) => err instanceof AuthError);
    await assert.rejects(() => current('b').fileLink!('k-b', 'hash', 'a.mp4'), (err: unknown) => err instanceof AuthError);
    assert.deepEqual([tsAccount, tsFiles], [0, 0], 'recusa do serviço não vira segunda pergunta');
    globalThis.fetch = reply(501, { error: 'service_not_ported' });
    assert.deepEqual(await current('c').accountStatus!('k-c'), { magnets: 3 });
    assert.deepEqual(await current('d').fileLink!('k-d', 'hash', 'a.mp4'), { url: 'http://ts.example/f', size: 9 });
    assert.deepEqual([tsAccount, tsFiles], [1, 1], '501 continua caindo no TS');
    globalThis.fetch = reply(502, { error: 'other' });
    const accountBefore = counter('rust.debrid.account.unreachable');
    const filesBefore = counter('rust.debrid.files.unreachable');
    await current('e').accountStatus!('k-e');
    await current('f').fileLink!('k-f', 'hash', 'a.mp4');
    assert.equal(counter('rust.debrid.account.unreachable') - accountBefore, 1, 'queda da conta é medida');
    assert.equal(counter('rust.debrid.files.unreachable') - filesBefore, 1, 'queda dos arquivos é medida');
    assert.deepEqual([tsAccount, tsFiles], [2, 2], 'sem veredito o TS responde uma vez');
  } finally {
    adapter.accountStatus = saved.account;
    adapter.fileLink = saved.fileLink;
    globalThis.fetch = saved.fetch;
    config.debrid.rustServices = saved.services;
  }
});
