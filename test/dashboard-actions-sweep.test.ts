// Ação `sweep-dead` do /dashboard-action.json: a DECISÃO DE DONO é o que este
// teste protege (plano `aldebrid-sweeps-admin-route`, §5.2).
//
//   AllDebrid do OPERADOR → varredura NATIVA no gateway (POST /sweeps/run)
//   AllDebrid BYO         → erro explícito, SEM tocar no adaptador TS
//   outros serviços       → ponte nativa `/debrid/sweep-dead` (8710)
//
// O handler é chamado direto com um `services` mínimo: nada de subir o app, o
// que também garante que nenhum teste daqui depende da conta real.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import type { AppServices } from '../src/routes/types.js';
import { sweepDead } from '../src/routes/dashboard-actions-sweep.js';
import { flushPendingSweeps, resetSweepsBridgeForTests } from '../src/utils/sweeps-native.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8771';
const saved: Record<string, any> = {};
const BRIDGE = 'http://127.0.0.1:8772';

beforeEach(() => {
  resetSweepsBridgeForTests();
  saved.bridgeUrl = process.env.DEBRID_INTERNAL_URL;
  saved.bridgeToken = process.env.DEBRID_INTERNAL_TOKEN;
  process.env.DEBRID_INTERNAL_URL = BRIDGE;
  process.env.DEBRID_INTERNAL_TOKEN = 'tok-bridge';
  saved.service = config.debrid.service;
  saved.apiKey = config.debrid.apiKey;
  saved.allowEnvKey = config.debrid.allowEnvKey;
  saved.operatorEnvAccount = config.debrid.operatorEnvAccount;
  saved.storeUrl = config.streamStore.url;
  saved.storeToken = config.streamStore.token;
  saved.storeTimeoutMs = config.streamStore.timeoutMs;
  saved.sweepTimeoutMs = config.streamStore.sweepTimeoutMs;
  config.streamStore.url = BASE;
  config.streamStore.token = 'tok-teste';
  config.streamStore.timeoutMs = 200;
  config.streamStore.sweepTimeoutMs = 200;
});

afterEach(() => {
  resetSweepsBridgeForTests();
  restoreEnv('DEBRID_INTERNAL_URL', saved.bridgeUrl);
  restoreEnv('DEBRID_INTERNAL_TOKEN', saved.bridgeToken);
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.apiKey;
  config.debrid.allowEnvKey = saved.allowEnvKey;
  config.debrid.operatorEnvAccount = saved.operatorEnvAccount;
  config.streamStore.url = saved.storeUrl;
  config.streamStore.token = saved.storeToken;
  config.streamStore.timeoutMs = saved.storeTimeoutMs;
  config.streamStore.sweepTimeoutMs = saved.sweepTimeoutMs;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function json(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

/** `services` mínimo: só o que o handler lê, com métrica e log observáveis. */
function makeServices() {
  const metrics: string[] = [];
  const services = {
    config,
    // Mesmo par que `runtime.normalize(null)` monta fora de request: o serviço
    // do `.env` e a chave só quando a herança está liberada.
    runtime: {
      opts: () => ({
        debridService: config.debrid.service,
        debridApiKey: config.debrid.allowEnvKey ? config.debrid.apiKey : '',
      }),
    },
    debrid,
    metrics: { count: (name: string) => metrics.push(name) },
    log: { info: () => {}, warn: () => {}, errorMessage: (err: unknown) => String(err) },
  };
  return { services: services as unknown as AppServices, metrics };
}

function makeRes() {
  const out = { body: null as any };
  const res = { json: (body: any) => { out.body = body; return body as any; } };
  return { res: res as any, out };
}

test('AllDebrid do operador: varredura NATIVA, métrica própria e refresh do status', async () => {
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = 'chave-do-operador';
  config.debrid.allowEnvKey = true;
  const { services, metrics } = makeServices();
  const { res, out } = makeRes();
  const stub = stubFetch((url) => (url.endsWith('/sweeps/run')
    ? json({ ok: true, kind: 'sweepDead', ran: true, applied: true, planned: 3, swept: 3, varridos: 3, falhas: 0, at: 1_793_300_000_000 })
    : json({ ok: true, mode: 'apply', scheduled: true, intervalMs: 21_600_000, counters: { runs: 1 } })));
  try {
    await sweepDead({ services, res, action: 'sweep-dead' });
    await flushPendingSweeps();

    assert.equal(out.body.ok, true);
    assert.equal(out.body.action, 'sweep-dead');
    assert.equal(out.body.error, undefined);
    assert.equal(out.body.result.varridos, 3, 'o painel continua lendo varridos/falhas');
    assert.equal(out.body.result.falhas, 0);
    assert.equal(out.body.result.kind, 'sweepDead');

    // Duas rotas: o pedido (POST) e o refresh do espelho (GET), nesta ordem.
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].url, `${BASE}/sweeps/run`);
    assert.equal(stub.calls[0].options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { kind: 'sweepDead', confirm: true });
    assert.equal(stub.calls[1].url, `${BASE}/sweeps`);

    assert.deepEqual(metrics, ['dashboard.sweep-dead', 'dashboard.sweep-dead.native'], 'a rota nativa é distinguível');
  } finally {
    stub.restore();
  }
});

test('AllDebrid BYO: erro explícito e NENHUMA chamada (não cai no adaptador TS)', async () => {
  // Chave da instalação na URL, sem conta do operador: `envOperatorAccount` falso.
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = '';
  config.debrid.allowEnvKey = false;
  config.debrid.operatorEnvAccount = false;
  const { services, metrics } = makeServices();
  const { res, out } = makeRes();
  const stub = stubFetch(() => json({ ok: true }));
  try {
    await sweepDead({ services, res, action: 'sweep-dead' });
    await flushPendingSweeps();
    assert.equal(stub.calls.length, 0, 'BYO não fala com o gateway NEM com o adaptador');

    assert.equal(out.body.ok, false);
    assert.equal(out.body.result, null);
    assert.match(String(out.body.error), /conta do operador/);
    assert.match(String(out.body.error), /BYO/);
    assert.deepEqual(metrics, ['dashboard.sweep-dead', 'dashboard.sweep-dead.byo-blocked']);
  } finally {
    stub.restore();
  }
});

test('AllDebrid BYO continua barrado com a conta do operador sem o gate ligado', async () => {
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = 'chave-no-env';
  config.debrid.allowEnvKey = false;
  config.debrid.operatorEnvAccount = false;
  const { services } = makeServices();
  const { res, out } = makeRes();
  const stub = stubFetch(() => json({ ok: true }));
  try {
    await sweepDead({ services, res, action: 'sweep-dead' });
    assert.equal(stub.calls.length, 0);
    assert.equal(out.body.ok, false);
    assert.match(String(out.body.error), /conta do operador/);
  } finally {
    stub.restore();
  }
});

test('premiumize (outro serviço): varredura pela ponte nativa /debrid/sweep-dead, sem adaptador TS', async () => {
  config.debrid.service = 'premiumize';
  config.debrid.apiKey = 'chave-da-instalacao';
  config.debrid.allowEnvKey = true;
  const { services, metrics } = makeServices();
  const { res, out } = makeRes();
  const stub = stubFetch((url) => (url.endsWith('/debrid/sweep-dead')
    ? json({ varridos: 2, falhas: 1, observados: 4 })
    : json({ ok: true })));
  try {
    await sweepDead({ services, res, action: 'sweep-dead' });
    assert.equal(stub.calls.length, 1, 'uma única chamada: a ponte');
    assert.equal(stub.calls[0].url, `${BRIDGE}/debrid/sweep-dead`);
    assert.equal(stub.calls[0].options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), {
      service: 'premiumize',
      apiKey: 'chave-da-instalacao',
      minAgeMs: config.debrid.sweepDeadMinAgeMs,
    });
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.result, { varridos: 2, falhas: 1, observados: 4 });
    assert.deepEqual(metrics, ['dashboard.sweep-dead'], 'sucesso não conta métrica de indisponível');
  } finally {
    stub.restore();
  }
});

test('premiumize: ponte responde 501 (sem varredura nativa) -> ok:false, indisponível', async () => {
  config.debrid.service = 'premiumize';
  config.debrid.apiKey = 'chave-da-instalacao';
  config.debrid.allowEnvKey = true;
  const { services, metrics } = makeServices();
  const { res, out } = makeRes();
  const stub = stubFetch(() => json({ error: 'service_not_ported' }, 501));
  try {
    await sweepDead({ services, res, action: 'sweep-dead' });
    assert.equal(stub.calls.length, 1);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.result, null);
    assert.match(String(out.body.error), /indisponível/);
    assert.deepEqual(metrics, ['dashboard.sweep-dead'], 'a métrica de indisponível é da ponte (contador global), não do services');
  } finally {
    stub.restore();
  }
});

test('sem chave da instalação: nenhuma chamada à ponte, indisponível', async () => {
  config.debrid.service = 'premiumize';
  config.debrid.apiKey = '';
  config.debrid.allowEnvKey = false;
  const { services } = makeServices();
  const { res, out } = makeRes();
  const stub = stubFetch(() => json({ varridos: 1, falhas: 0, observados: 1 }));
  try {
    await sweepDead({ services, res, action: 'sweep-dead' });
    assert.equal(stub.calls.length, 0);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.result, null);
  } finally {
    stub.restore();
  }
});
