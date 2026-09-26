import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Os testes do override do painel MORAM aqui, não no rd-warmer.test.ts: com a
// conta de fundo do colhedor gravada, o arquivo clássico passaria dos 400
// linhas do catraca. O caso central é o contrato de fonte única — o painel
// decide o warm, e o `.env` RD não volta por baixo de um override AllDebrid.
process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import { rdGate } from '../src/debrid/rd-gate.js';
import * as harvesterDebrid from '../src/utils/harvester-debrid-live.js';
import rdWarmer from '../src/providers/rd-warmer.js';

const H = 'a'.repeat(40);

const saved = {
  service: config.debrid.service,
  apiKey: config.debrid.apiKey,
  allowEnvKey: config.debrid.allowEnvKey,
  resolveSecret: config.debrid.resolveSecret,
  rdWarm: { ...config.debrid.rdWarm },
  rdGate: { ...config.debrid.rdGate },
};

function restoreConfig() {
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.apiKey;
  config.debrid.allowEnvKey = saved.allowEnvKey;
  config.debrid.resolveSecret = saved.resolveSecret;
  config.debrid.rdWarm = { ...saved.rdWarm };
  config.debrid.rdGate = { ...saved.rdGate };
}

function mockFetch(handler: (url: URL, init?: RequestInit) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const calls: { url: URL; method: string }[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: String(init?.method || 'GET').toUpperCase() });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

function jsonOk(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

beforeEach(() => {
  restoreConfig();
  cache.clearNamespace('rdc');
  cache.clearNamespace('rdq');
  metrics.reset();
  rdLedger.reset();
  rdGate.reset();
  rdWarmer.reset();
  harvesterDebrid.resetForTest();

  config.debrid.rdWarm.enabled = true;
  config.debrid.rdWarm.idleWindowMs = 0;
  config.debrid.rdWarm.batch = 10;
  config.debrid.rdWarm.maxPerHour = 300;
  config.debrid.rdLedger.enabled = true;
  config.debrid.rdGate.minGapMs = 0;
  config.debrid.rdGate.cooldownMs = 0;
});

afterEach(() => {
  restoreConfig();
  rdGate.reset();
  harvesterDebrid.resetForTest();
});

test('rd-warmer: conta de fundo do painel (RD) ativa o aquecimento mesmo com .env AllDebrid', async () => {
  // Env não-RD sozinho: nada aquece. O override do painel com Real-Debrid é
  // fonte única e liga o warm com a chave DELE — o env AllDebrid não pode nem
  // desligar nem fornecer a credencial.
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = 'env-alldebrid';
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = 'segredo-do-teste';
  try {
    rdWarmer.reset();
    assert.equal(rdWarmer.rdInPlay(), false, 'env AllDebrid sozinho não aquece RD');

    const r = harvesterDebrid.set('realdebrid', 'chave-painel-rd');
    assert.equal(r.ok, true);
    assert.equal(rdWarmer.rdInPlay(), true, 'override RD ativa o aquecimento');
    assert.equal(rdWarmer.status().accountSource, 'panel');

    const auths: string[] = [];
    const mock = mockFetch((url, init) => {
      if (String(init?.method || 'GET').toUpperCase() === 'DELETE') return jsonOk({}, 204);
      if (url.pathname.endsWith('/torrents/addMagnet')) {
        auths.push(String((init?.headers as Record<string, string> | undefined)?.Authorization || ''));
        return jsonOk({ id: 'T-PANEL' });
      }
      if (url.pathname.includes('/torrents/info/')) return jsonOk({ status: 'downloaded', files: [], links: [] });
      throw new Error(`URL inesperada: ${url.pathname}`);
    });
    try {
      rdWarmer.enqueue([H], 100);
      await rdWarmer.tick();
      assert.equal(rdLedger.peek(H), 'hit', 'sonda rodou com a chave do painel');
      assert.equal(auths.length, 1);
      assert.equal(auths[0], 'Bearer chave-painel-rd', 'Authorization usa a chave do painel, não a do env');
    } finally {
      mock.restore();
    }
  } finally {
    config.debrid.resolveSecret = saved.resolveSecret;
    harvesterDebrid.resetForTest();
  }
});

test('rd-warmer: conta de fundo do painel com AllDebrid DESLIGA o aquecimento mesmo com .env RD', async () => {
  // Contrato de fonte única: o override do painel com outro serviço não pode
  // deixar o `.env` RD voltar por baixo — o warm fica off e a credencial de
  // sessão também não destrava (o operador escolheu desligar).
  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = 'env-rd-key';
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = 'segredo-do-teste';
  try {
    rdWarmer.reset();
    assert.equal(rdWarmer.rdInPlay(), true, 'env RD + gate abre o warm antes do override');
    assert.equal(rdWarmer.status().accountSource, 'env');

    const r = harvesterDebrid.set('alldebrid', 'chave-painel-ad');
    assert.equal(r.ok, true);
    assert.equal(rdWarmer.rdInPlay(), false, 'override AllDebrid desliga o warm mesmo com env RD');
    assert.equal(rdWarmer.status().accountSource, 'none');

    const mock = mockFetch(() => jsonOk({ id: 'T1' }));
    try {
      rdWarmer.enqueue([H], 100);
      await rdWarmer.tick();
      assert.deepEqual(mock.calls, [], 'nenhuma sonda com .env RD por baixo do override');
      assert.equal(rdLedger.peek(H), 'unknown', 'override AllDebrid não grava veredito no ledger');
    } finally {
      mock.restore();
    }
  } finally {
    config.debrid.resolveSecret = saved.resolveSecret;
    harvesterDebrid.resetForTest();
  }
});