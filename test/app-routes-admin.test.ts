import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createApp, asyncRoute } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { BlockedError, WorkPickError, EpisodePickError, NoVideoError, DubLieError } from '../src/debrid/common.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as releaseIndex from '../src/utils/release-index.js';
import type { DebridAdapter } from '../types/domain.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { createTestServer, encodeConfig, withMockFetch, fakeResponse } from './e2e/e2e-harness.js';

const FAKE_ADAPTER = {
  id: 'fakebrid',
  label: 'FakeBridge',
  short: 'FK',
  cacheCheck: true,
  keyUrl: null as unknown as string,
  checkCached: async () => new Set<string>(),
  resolveLink: async () => 'https://fake.test/dl/video.mp4',
} as DebridAdapter;

function hmacSig(secret: any, payload: any) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

let server: any;
const saved: Record<string, string> = {};
before(async () => {
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.testToken = config.jackett.testToken;
  saved.jackettApiKey = config.jackett.apiKey;
  saved.publicUrl = config.debrid.publicUrl;
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.jackett.testToken = '';
  config.jackett.apiKey = 'test-jackett-key';
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.BY_ID.set(FAKE_ADAPTER.id, FAKE_ADAPTER);
  const { app } = createApp();
  server = await createTestServer(app);
});
after(async () => {
  await server.close();
  debrid.BY_ID.delete(FAKE_ADAPTER.id);
  config.debrid.service = saved.debridService;
  config.debrid.apiKey = saved.debridApiKey;
  config.debrid.resolveSecret = saved.resolveSecret;
  config.jackett.testToken = saved.testToken;
  config.jackett.apiKey = saved.jackettApiKey;
  config.debrid.publicUrl = saved.publicUrl;
});

test('/defaults.json nunca expõe a chave de debrid do operador', async () => {
  // O jackettCatalog.load() da rota faz fetch; o mock garante que nenhum
  // pedido saia do processo.
  await withMockFetch([{ match: '/api/v2.0/indexers', handler: () => fakeResponse([]) }], async () => {
    config.debrid.apiKey = 'segredo-do-operador';
    try {
      const res = await server.request('GET', '/defaults.json');
      assert.equal(res.status, 200);
      assert.equal(res.json.debridApiKey, '', 'a chave volta sempre vazia');
      assert.ok(!res.text.includes('segredo-do-operador'), 'a chave não vaza em nenhum campo');
      assert.ok(Array.isArray(res.json.services), 'o seletor de serviços vem do registry');
      assert.equal(res.json.sealKeyEnabled, false, 'sem RESOLVE_SECRET o selo fica desligado');
    } finally {
      config.debrid.apiKey = '';
    }
  });
});

test('/seal-config devolve 503 sem RESOLVE_SECRET', async () => {
  const res = await server.request('POST', '/seal-config', {
    body: encodeConfig({ m: 2 }),
  });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /RESOLVE_SECRET/);
});

test('/metrics.json: 503 sem token configurado, 401 com token errado, 200 com o certo', async () => {
  const semToken = await server.request('GET', '/metrics.json');
  assert.equal(semToken.status, 503);

  config.jackett.testToken = 'tok-diagnostico';
  try {
    const errado = await server.request('GET', '/metrics.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    });
    assert.equal(errado.status, 401);

    const semHeader = await server.request('GET', '/metrics.json');
    assert.equal(semHeader.status, 401);

    const certo = await server.request('GET', '/metrics.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-diagnostico' },
    });
    assert.equal(certo.status, 200);
    assert.equal(typeof certo.json.counters, 'object');
    assert.equal(typeof certo.json.cache.entries, 'number');
  } finally {
    config.jackett.testToken = '';
  }
});

test('asyncRoute intercepta rejeição assíncrona, responde 500 e não derruba o processo (Tarefa 2.7)', async () => {
  const miniApp = express();
  // Registra uma rota async que falha com rejeição proposital
  miniApp.get('/test-async-crash', asyncRoute(async () => {
    throw new Error('Falha assíncrona simulada proposital');
  }));

  const testSrv = await createTestServer(miniApp);
  try {
    const res = await testSrv.request('GET', '/test-async-crash');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal_error' });
  } finally {
    await testSrv.close();
  }
});

test('/metrics.json e /debrid-status.json passam pelo diagnosticGate e devolvem 429 sob concorrência (Tarefa 2.6)', async () => {
  config.jackett.testToken = 'tok-diagnostico-gate';
  // Cria uma instância isolada para ter seu próprio gate
  const isolatedApp = createApp().app;
  const isolatedSrv = await createTestServer(isolatedApp);

  try {
    let releaseHold: (() => void) | null = null;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    await withMockFetch([], async () => {
      // Fazemos o debrid accountStatus segurar o assento do gate
      const originalAccountStatus = debrid.accountStatus;
      try {
        debrid.accountStatus = (async () => {
          await holdPromise;
          return { ok: true, service: 'alldebrid', label: 'AllDebrid', supported: true, warn: false, warnAt: 800, warnAtUnit: 'magnets', magnets: 10 };
        }) as any;

        // Dispara uma chamada ao /debrid-status.json que segura a vaga
        const inFlightReq = isolatedSrv.request('GET', '/debrid-status.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-gate' },
        });

        // Aguarda brevemente para garantir que inFlightReq adquiriu a vaga no gate
        await new Promise((r) => setTimeout(r, 20));

        // Segunda chamada concorrente ao /metrics.json deve receber 429 pelo gate ocupado
        const metricsRes = await isolatedSrv.request('GET', '/metrics.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-gate' },
        });
        assert.equal(metricsRes.status, 429);
        assert.match(metricsRes.json.error, /teste em andamento|limite de testes/i);

        // Terceira chamada concorrente ao /debrid-status.json deve também receber 429
        const debridRes = await isolatedSrv.request('GET', '/debrid-status.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-gate' },
        });
        assert.equal(debridRes.status, 429);
        assert.equal(debridRes.json.ok, false);
        assert.match(debridRes.json.error, /teste em andamento|limite de testes/i);

        // Libera a requisição inicial
        releaseHold?.();
        const firstRes = await inFlightReq;
        assert.equal(firstRes.status, 200);
      } finally {
        debrid.accountStatus = originalAccountStatus;
      }
    });
  } finally {
    config.jackett.testToken = '';
    await isolatedSrv.close();
  }
});

test('/debrid-status.json: debrid pendurado solta o assento no prazo e a monitoração segue viva (race do gate)', async () => {
  config.jackett.testToken = 'tok-diagnostico-race';
  const originalTimeout = config.debrid.dashboardAccountTimeoutMs;
  // Prazo curto: o teste não pode esperar os 3s de produção.
  config.debrid.dashboardAccountTimeoutMs = 80;
  const isolatedApp = createApp().app;
  const isolatedSrv = await createTestServer(isolatedApp);
  try {
    await withMockFetch([], async () => {
      const originalAccountStatus = debrid.accountStatus;
      try {
        // Nunca resolve: sem o race, o assento ficaria preso até o teto do fetch.
        debrid.accountStatus = (() => new Promise(() => {})) as any;
        const res = await isolatedSrv.request('GET', '/debrid-status.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-race' },
        });
        assert.equal(res.status, 200, 'o diagnóstico sai mesmo com o debrid pendurado');
        assert.equal(res.json.reason, 'timeout');

        // O finally liberou o assento: a próxima monitoração não leva 429.
        const metricsRes = await isolatedSrv.request('GET', '/metrics.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-race' },
        });
        assert.equal(metricsRes.status, 200);
      } finally {
        debrid.accountStatus = originalAccountStatus;
      }
    });
  } finally {
    config.debrid.dashboardAccountTimeoutMs = originalTimeout;
    config.jackett.testToken = '';
    await isolatedSrv.close();
  }
});

test('/resolve: BlockedError devolve 451 legal sem gravar bad ou alive', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashBlocked = '3'.repeat(40);
  const sig = hmacSig('fake-key', hashBlocked);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  // A lista pronta é a única "prova" que sobrevive quando o bloqueio só
  // aparece no play: sem invalidar o namespace, o card [RD⚡] morto
  // continuaria sendo servido até o fim do TTL.
  cache.set('streams:v10:teste-bloqueio-451', { streams: [{ name: 'x', infoHash: hashBlocked }] }, 900);
  assert.ok(cache.get('streams:v10:teste-bloqueio-451'), 'precondição: entrada de streams existe');

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new BlockedError('HTTP 451 — infringing_file'); };
    const res = await server.request('GET', `/${cfg}/resolve/${hashBlocked}?sig=${sig}`);
    assert.equal(res.status, 451);
    assert.equal(res.text, 'o debrid bloqueou este conteúdo por motivo legal');
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashBlocked), false, '451 não prova ausência de vídeo');
    assert.equal(magnetdb.isAlive('fakebrid', 'fake-key', hashBlocked), false, '451 nunca é play resolvido');
    assert.equal(cache.get('streams:v10:teste-bloqueio-451'), null, 'o play bloqueado invalidou a lista pronta');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('router do protocolo preserva CORS e responde preflight sem chegar à busca', async () => {
  const manifest = await server.request('GET', '/manifest.json');
  assert.equal(manifest.headers.get('access-control-allow-origin'), '*');

  const preflight = await server.request('OPTIONS', '/stream/movie/tt1254207.json', {
    headers: { 'Access-Control-Request-Headers': 'X-Stremio-Test' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(String(preflight.headers.get('access-control-allow-methods')), /GET/);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'X-Stremio-Test');
});

test('rotas globais não caem sob o overlay', async () => {
  const manifest = await server.request('GET', '/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.id, config.addonId);

  // Se o decode do overlay viesse antes desta rota, "resolve" seria tratado
  // como config inválida e responderia 404, não a validação do infoHash.
  const resolve = await server.request('GET', '/resolve/nao-eh-hash');
  assert.equal(resolve.status, 400);
  assert.equal(resolve.text, 'infoHash inválido');
});

test('segmento inválido não vira overlay válido', async () => {
  const res = await server.request('GET', '/nao-e-config/manifest.json');
  assert.equal(res.status, 404);
});

test('overlay válido preserva manifest e resolve configurados', async () => {
  const userConfig = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const manifest = await server.request('GET', `/${userConfig}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.id, config.addonId);

  const resolve = await server.request('GET', `/${userConfig}/resolve/nao-eh-hash`);
  assert.equal(resolve.status, 400);
  assert.equal(resolve.text, 'infoHash inválido');
});

test('/resolve: DubLieError destrava a proteção durável da conta/adapter do play', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashLie = '4'.repeat(40);
  const account = accountScope('fake-key');
  const markerKey = `${prefix('adprot')}fakebrid:${account}:${hashLie}`;
  const sig = hmacSig('fake-key', hashLie);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    // Pré-condição: registro durável retido (o que o autofetch do AllDebrid
    // deixaria). A rota destrava pelo adapter/conta EFETIVOS do play — aqui,
    // o adaptador fake registrado no registry real.
    cache.set(markerKey, { acceptedAt: Date.now(), readyAt: null }, 3600);
    assert.ok(cache.peek(markerKey), 'precondição: retenção durável de pé');

    FAKE_ADAPTER.resolveLink = async () => {
      throw new DubLieError({ videoCount: 1, matchedGroup: 'WEB', sample: 'Movie.2024.1080p.WEB.mkv' });
    };
    const res = await server.request('GET', `/${cfg}/resolve/${hashLie}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'o torrent anunciado como dublado contém conteúdo em inglês');
    assert.equal(cache.get(markerKey), null, 'a prova de release EN destrava a retenção no play');
    assert.equal(magnetdb.isLie('fakebrid', 'fake-key', hashLie), true, 'a mentira também vai para o banco de magnets');

    // Sem registro, a rota segue respondendo igual (idempotente: nada a limpar).
    const res2 = await server.request('GET', `/${cfg}/resolve/${hashLie}?sig=${sig}`);
    assert.equal(res2.status, 404);
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
    cache.forget(markerKey);
  }
});

