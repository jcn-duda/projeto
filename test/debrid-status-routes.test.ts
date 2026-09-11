import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { resetAccountStatusMemo } from '../src/debrid/account-status.js';
import { createApp } from '../src/app.js';
import config from '../src/config.js';

config.jackett.testToken = config.jackett.testToken || 'token-de-teste';
config.debrid.service = 'alldebrid';
config.debrid.apiKey = 'chave-de-teste';

const TOKEN = config.jackett.testToken;

function mockAccount(total: any, ready = 0) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          magnets: Array.from({ length: total }, (_, i) => ({
            id: i,
            ready: i < ready,
            size: 1024,
            uploadDate: 1_700_000_000 + i,
          })),
        },
      }),
    };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

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

const withPremiumize = (fn: () => unknown) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-pm' },
      encoded: 'cfg',
    },
    fn,
  ) as Promise<AccountStatusResult>;

function mockRealDebridAccount(torrents = [{ id: '1', status: 'downloaded' }, { id: '2', status: 'downloading' }]) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    const strUrl = String(url);
    if (strUrl.includes('127.0.0.1')) return realFetch(url, init);
    if (strUrl.includes('/user')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 12345, username: 'testuser', expiration: '2028-01-01T00:00:00.000Z' }),
      };
    }
    if (strUrl.includes('/torrents')) {
      return {
        ok: true,
        status: 200,
        json: async () => torrents,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

async function request(app: any, path: any, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('a rota exige o token de diagnóstico', async () => {
  const { app } = createApp();
  const semToken = await request(app, '/debrid-status.json');
  assert.equal(semToken.status, 401);

  const tokenErrado = await request(app, '/debrid-status.json', { 'X-Indexer-Test-Token': 'outro' });
  assert.equal(tokenErrado.status, 401);
});

test('a rota responde 200 com o diagnóstico mesmo com a conta ruim', async () => {
  // Conta estourada não é erro de request: o corpo É a resposta útil.
  resetAccountStatusMemo();
  const restore = mockAccount(1000);
  const { app } = createApp();
  try {
    const { status, body } = await request(app, '/debrid-status.json', {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.magnets, 1000);
    assert.equal(body.warn, true);
  } finally {
    restore();
  }
});

test('com config na URL o verificador olha a chave DAQUELA instalação', async () => {
  resetAccountStatusMemo();
  const segment = runtime.encode({
    [runtime.SCHEMA.debridService.key]: 'alldebrid',
    [runtime.SCHEMA.debridApiKey.key]: 'chave-da-instalacao',
  });
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    const total = auth.includes('chave-da-instalacao') ? 500 : 999;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          magnets: Array.from({ length: total }, (_, i) => ({
            id: i,
            ready: true,
            size: 1024,
            uploadDate: 1_700_000_000 + i,
          })),
        },
      }),
    };
  }) as unknown as typeof globalThis.fetch;
  const restore = () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
  const { app } = createApp();
  try {
    const { status, body } = await request(app, `/${segment}/debrid-status.json`, {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.service, 'alldebrid');
    assert.equal(body.magnets, 500);
  } finally {
    restore();
  }
});

test('a rota expõe a unidade dos magnets no warnAt', async () => {
  resetAccountStatusMemo();
  const restore = mockAccount(500);
  const { app } = createApp();
  try {
    const { status, body } = await request(app, '/debrid-status.json', {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.warnAt, 800);
    assert.equal(body.warnAtUnit, 'magnets');
  } finally {
    restore();
  }
});

test('warnAt do fair-use carrega a unidade explícita no corpo', async () => {
  resetAccountStatusMemo();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', limit_used: 0.42, premium_until: 1799999999 }),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    const status = await withPremiumize(() => debrid.accountStatus());
    assert.equal(status.warnAt, 0.8);
    assert.equal(status.warnAtUnit, 'fair-use');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('a rota /debrid-status.json inclui bloco rd quando o serviço é realdebrid', async () => {
  const oldService = config.debrid.service;
  const oldApiKey = config.debrid.apiKey;
  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = 'chave-rd-teste';
  const restore = mockRealDebridAccount();
  const { app } = createApp();
  try {
    const { status, body } = await request(app, '/debrid-status.json', {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.service, 'realdebrid');
    assert.ok(body.rd, 'bloco rd deve estar presente');
    assert.equal(typeof body.rd.ledger, 'object');
    assert.equal(typeof body.rd.ledger.tracked, 'number');
    assert.equal(typeof body.rd.ledger.hits, 'number');
    assert.equal(typeof body.rd.ledger.misses, 'number');
    assert.equal(typeof body.rd.ledger.blocked, 'number');
    assert.equal(typeof body.rd.oracle, 'object');
    assert.equal(typeof body.rd.oracle.enabled, 'boolean');
    assert.equal(typeof body.rd.oracle.stremthru, 'boolean');
    assert.equal(typeof body.rd.oracle.torrentio, 'boolean');
    assert.equal(typeof body.rd.gate, 'object');
    assert.equal(typeof body.rd.gate.enabled, 'boolean');
    assert.ok(Array.isArray(body.rd.gate.accounts));
    assert.equal(typeof body.rd.warm, 'object');
    assert.equal(typeof body.rd.warm.enabled, 'boolean');
    assert.equal(typeof body.rd.warm.queueDepth, 'number');
    assert.equal(typeof body.rd.warm.paused, 'boolean');
    assert.equal(typeof body.rd.warm.processedLastHour, 'number');
  } finally {
    restore();
    config.debrid.service = oldService;
    config.debrid.apiKey = oldApiKey;
  }
});

test('com config na URL apontando para realdebrid, /debrid-status.json inclui o bloco rd', async () => {
  const segment = runtime.encode({
    ds: 'realdebrid',
    dk: 'chave-rd-instalacao',
  });
  const restore = mockRealDebridAccount();
  const { app } = createApp();
  try {
    const { status, body } = await request(app, `/${segment}/debrid-status.json`, {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.service, 'realdebrid');
    assert.ok(body.rd, 'bloco rd deve estar presente');
    assert.equal(typeof body.rd.ledger.tracked, 'number');
    assert.equal(typeof body.rd.oracle.enabled, 'boolean');
    assert.equal(typeof body.rd.gate.enabled, 'boolean');
    assert.equal(typeof body.rd.warm.queueDepth, 'number');
  } finally {
    restore();
  }
});
