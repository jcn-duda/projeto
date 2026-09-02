import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { resetAccountStatusMemo } from '../src/debrid/account-status.js';
import config from '../src/config.js';

interface AccountStatusResult {
  ok: boolean;
  service: string | null;
  label?: string;
  supported?: boolean;
  reason?: string;
  error?: string;
  warn?: boolean;
  warnAt?: number;
  warnAtUnit?: string;
  magnets?: number;
  ready?: number;
  active?: number;
  limitUsed?: number | null;
  premiumUntil?: number | null;
  oldestAt?: number | string | null;
  usedPct?: number;
  cached?: boolean;
  fetchedAt?: number;
  fix?: string | null;
}

const withKey = (fn: () => unknown) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'chave-de-teste' },
      encoded: 'cfg',
    },
    fn,
  ) as Promise<AccountStatusResult>;

function mockAccountCounting(payload: () => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    calls += 1;
    return { ok: true, status: 200, json: async () => payload() };
  }) as unknown as typeof globalThis.fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

const okPayload = () => ({
  status: 'success',
  data: {
    magnets: Array.from({ length: 5 }, (_, i) => ({
      id: i,
      ready: true,
      size: 1024,
      uploadDate: 1_700_000_000 + i,
    })),
  },
});

const authPayload = () => ({
  status: 'error',
  error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' },
});

test('memo: duas leituras dentro do TTL = 1 consulta; corpo traz fetchedAt e cached', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    const first = await withKey(() => debrid.accountStatus());
    const oneFlight = mock.count();
    assert.ok(oneFlight > 0, 'a primeira leitura foi à rede');
    assert.equal(first.cached, false);
    assert.equal(typeof first.fetchedAt, 'number');
    const second = await withKey(() => debrid.accountStatus());
    assert.equal(mock.count(), oneFlight, 'segunda leitura veio do memo');
    assert.equal(second.cached, true);
    assert.equal(second.fetchedAt, first.fetchedAt, 'fetchedAt marca a consulta, não a leitura');
    assert.equal(second.magnets, first.magnets);
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: TTL expirado reconsulta, e TTL=0 desliga o memo', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    config.debrid.dashboardAccountTtlMs = 25;
    await withKey(() => debrid.accountStatus());
    const oneFlight = mock.count();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const depois = await withKey(() => debrid.accountStatus());
    assert.equal(mock.count(), oneFlight * 2, 'TTL vencido foi à rede de novo');
    assert.equal(depois.cached, false);

    config.debrid.dashboardAccountTtlMs = 0;
    resetAccountStatusMemo();
    await withKey(() => debrid.accountStatus());
    const base = mock.count();
    await withKey(() => debrid.accountStatus());
    assert.equal(mock.count(), base + oneFlight, 'com 0 cada leitura consulta');
    const direto = await withKey(() => debrid.accountStatus());
    assert.equal(direto.cached, false, 'memo desligado nunca diz cached');
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: chaves distintas nunca dividem entrada', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    const primeira = await withKey(() => debrid.accountStatus());
    const umaChave = mock.count();
    const outra = await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'outra-chave' }, encoded: 'cfg' },
      () => debrid.accountStatus(),
    ) as AccountStatusResult;
    assert.equal(outra.cached, false, 'chave nova não herda memo da anterior');
    assert.equal(mock.count(), umaChave * 2, 'cada conta pagou a própria consulta');
    const repetida = await withKey(() => debrid.accountStatus());
    assert.equal(repetida.cached, true);
    assert.equal(repetida.fetchedAt, primeira.fetchedAt);
    assert.equal(mock.count(), umaChave * 2, 'memo da primeira chave continua valendo');
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: chamada concorrente é coalescida em uma consulta só', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    await withKey(() => debrid.accountStatus());
    const umVoo = mock.count();
    resetAccountStatusMemo();
    const antes = mock.count();
    const [a, b] = await Promise.all([
      withKey(() => debrid.accountStatus()),
      withKey(() => debrid.accountStatus()),
    ]);
    assert.equal(mock.count() - antes, umVoo, 'duas leituras concorrentes = 1 consulta');
    assert.equal(a.cached, false);
    assert.equal(b.cached, false, 'quem participou da consulta em voo viu dado novo');
    assert.equal(a.fetchedAt, b.fetchedAt);
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: falha auth preserva reason/fix e não congela além do TTL', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(authPayload);
  try {
    const primeira = await withKey(() => debrid.accountStatus());
    assert.equal(primeira.ok, false);
    assert.equal(primeira.reason, 'auth');
    assert.ok(primeira.fix, 'o conserto viaja no corpo da falha');
    const memoizada = await withKey(() => debrid.accountStatus());
    assert.equal(memoizada.cached, true);
    assert.equal(memoizada.reason, primeira.reason);
    assert.equal(memoizada.fix, primeira.fix, 'reason/fix sobrevivem ao memo');
    config.debrid.dashboardAccountTtlMs = 25;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const renovada = await withKey(() => debrid.accountStatus());
    assert.equal(renovada.cached, false, 'TTL curto é o teto do congelamento da falha');
    assert.equal(renovada.reason, 'auth');
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('dashboardAccounts reutiliza o memo para a conta do operador', async () => {
  resetAccountStatusMemo();
  const saved = {
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    allowEnvKey: config.debrid.allowEnvKey,
    ttl: config.debrid.dashboardAccountTtlMs,
  };
  const mock = mockAccountCounting(okPayload);
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = 'chave-do-operador';
  config.debrid.allowEnvKey = true;
  config.debrid.dashboardAccountTtlMs = 60_000;
  try {
    const ler = () =>
      runtime.run(
        { opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-pm' }, encoded: 'cfg' },
        () => debrid.dashboardAccounts({ ok: true, service: 'premiumize' }),
      ) as Promise<Record<string, any>>;
    const first = await ler();
    const umVoo = mock.count();
    assert.ok(first.alldebrid, 'conta do operador entra no mapa');
    assert.equal(first.alldebrid.cached, false);
    const second = await ler();
    assert.equal(mock.count(), umVoo, 'segunda leitura do operador veio do memo');
    assert.equal(second.alldebrid.cached, true);
    assert.equal(second.alldebrid.fetchedAt, first.alldebrid.fetchedAt);
  } finally {
    mock.restore();
    config.debrid.service = saved.service;
    config.debrid.apiKey = saved.apiKey;
    config.debrid.allowEnvKey = saved.allowEnvKey;
    config.debrid.dashboardAccountTtlMs = saved.ttl;
  }
});
