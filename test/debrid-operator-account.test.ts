import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { AuthError, RateLimitError } from '../src/debrid/common.js';
import type { DebridAdapter } from '../types/domain.js';
import { createTestServer } from './e2e/e2e-harness.js';

const TOKEN = 'tok-debrid-operator';
let server: any;
let receivedKey = '';
let calls = 0;
let mode: 'ok' | 'auth' | 'rate' | 'timeout' = 'ok';
const saved: Record<string, any> = {};

const ADAPTER = {
  id: 'accountfake',
  label: 'Conta Fake',
  short: 'CF',
  cacheCheck: true,
  abortSafeCacheCheck: false,
  keyUrl: 'https://example.invalid/key',
  checkCached: async () => new Set<string>(),
  resolveLink: async () => null,
  inventory: async () => [],
  enqueue: async () => ({ accepted: true }),
  torrentStatus: async () => ({ state: 'unknown' }),
  magnetList: async () => [],
  accountStatus: async (key: string) => {
    calls += 1;
    receivedKey = key;
    if (mode === 'auth') throw new AuthError(`invalid key ${key} encoded=${encodeURIComponent(key)}`);
    if (mode === 'rate') throw new RateLimitError('rate limit reached', 1000);
    if (mode === 'timeout') return new Promise(() => {});
    return { ok: true, magnets: 42, ready: 30, active: 4, error: 8, premiumUntil: 1999999999 };
  },
} as unknown as DebridAdapter;

before(async () => {
  saved.token = config.jackett.testToken;
  saved.timeout = config.debrid.dashboardAccountTimeoutMs;
  saved.service = config.debrid.service;
  saved.key = config.debrid.apiKey;
  config.jackett.testToken = TOKEN;
  config.debrid.dashboardAccountTimeoutMs = 20;
  debrid.BY_ID.set(ADAPTER.id, ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(ADAPTER.id);
  config.jackett.testToken = saved.token;
  config.debrid.dashboardAccountTimeoutMs = saved.timeout;
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.key;
});

function post(body: Record<string, unknown>, token = TOKEN) {
  return server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': token },
    body,
  });
}

test('debrid-account-test: exige token e valida serviço/chave sem confirm', async () => {
  const semToken = await server.request('POST', '/dashboard-action.json', {
    body: { action: 'debrid-account-test', service: ADAPTER.id, key: 'x' },
  });
  assert.equal(semToken.status, 401);
  const desconhecido = await post({ action: 'debrid-account-test', service: 'naoexiste', key: 'x' });
  assert.equal(desconhecido.status, 400);
  assert.equal(desconhecido.json.reason, 'servico-desconhecido');
  const vazia = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: '   ' });
  assert.equal(vazia.status, 400);
  assert.equal(vazia.json.reason, 'chave-ausente');
  const longa = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: 'x'.repeat(513) });
  assert.equal(longa.status, 400);
  assert.equal(longa.json.reason, 'chave-invalida');
  // A action não está na allowlist destrutiva: nenhum confirm é necessário.
  const ok = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: 'chave-curta' });
  assert.equal(ok.status, 200);
});

test('sucesso: usa a chave informada sem memo/persistência e nunca a ecoa', async () => {
  mode = 'ok'; calls = 0; receivedKey = '';
  const secret = ' segredo-super-secreto-9876 ';
  const serviceBefore = config.debrid.service;
  const keyBefore = config.debrid.apiKey;
  const first = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: secret });
  const second = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: secret });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(receivedKey, secret.trim());
  assert.equal(calls, 2, 'teste pontual não usa memo');
  assert.equal(first.json.last4, '9876');
  assert.equal(first.json.fingerprint.length, 8);
  assert.equal(first.json.account.magnets, 42);
  assert.deepEqual(first.json.capabilities, {
    cacheCheck: true,
    abortSafeCacheCheck: false,
    accountStatus: true,
    inventory: true,
    autofetch: true,
    torrentStatus: true,
    catalogCleanup: true,
  });
  const serialized = JSON.stringify(first.json);
  assert.equal(serialized.includes(secret.trim()), false);
  assert.equal(config.debrid.service, serviceBefore);
  assert.equal(config.debrid.apiKey, keyBefore);
});

test('falhas auth/rate/timeout preservam reason/fix e scrubam a credencial', async () => {
  const secret = 'segredo/Auth+9876';
  mode = 'auth';
  const auth = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: secret });
  assert.equal(auth.status, 200);
  assert.equal(auth.json.ok, false);
  assert.equal(auth.json.reason, 'auth');
  assert.match(auth.json.fix, /chave/i);
  const serialized = JSON.stringify(auth.json);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(encodeURIComponent(secret)), false);
  assert.match(auth.json.error, /\*\*\*/);

  mode = 'rate';
  const rate = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: secret });
  assert.equal(rate.json.reason, 'rate');
  assert.match(rate.json.fix, /aguarde/i);

  mode = 'timeout';
  const timeout = await post({ action: 'debrid-account-test', service: ADAPTER.id, key: secret });
  assert.equal(timeout.json.reason, 'timeout');
  assert.match(timeout.json.fix, /não respondeu/i);
  mode = 'ok';
});

test('frontend: seção segura e teste não deixa a chave no DOM (módulo ESM real)', async () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /id="debridTestService"/);
  assert.match(html, /id="debridTestKey"[^>]*type="password"/);
  assert.match(html, /não salva|não altera/i);

  const { resetDashboardEnvironment } = await import('./helpers/dashboard.js');
  const { dom, mods } = await resetDashboardEnvironment();
  const secret = 'chave-no-dom-1234';
  const payload = {
    ok: true, service: 'accountfake', label: 'Conta Fake', last4: '1234', fingerprint: 'deadbeef',
    account: { magnets: 9, ready: 8, active: 1 }, capabilities: { cacheCheck: true, inventory: false },
  };
  const requests: any[] = [];
  dom.setFetch((url: string, init: any) => {
    requests.push({ url: String(url), init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  });
  mods.state.DashState.token = 'tok';
  dom.element('debridTestService').value = 'accountfake';
  dom.element('debridTestKey').value = secret;
  mods.debridTest.runDebridAccountTest();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/dashboard-action.json');
  assert.deepEqual(JSON.parse(requests[0].init.body), { action: 'debrid-account-test', service: 'accountfake', key: secret });
  assert.equal(dom.byId['debridTestKey'].value, '', 'input limpo em todo desfecho');
  const rendered = collectText(dom.byId['debridTestOutput']) + ' ' + collectText(dom.byId['debridTestFeedback']);
  assert.equal(rendered.includes(secret), false, 'chave não reaparece no DOM');
  assert.match(rendered, /Conta Fake/);
  assert.match(rendered, /Magnets/);
  dom.cleanup();
});

function collectText(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(collectText)).join(' ');
}
