import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { aiControl, jevDisagreements, resetTypesafeForTests } from '../src/ai/index.js';
import { DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
import { createTestServer } from './e2e/e2e-harness.js';

/**
 * As 5 ações do Jev (jev-pause/jev-resume/jev-drain/jev-cooldown-reset/
 * jev-disagreements) no /dashboard-action.json. Suíte própria pela catraca de
 * linhas: o harness mínimo (token + server) basta — nenhuma dessas ações toca
 * debrid, Jackett ou cache; o estado que elas mudam é o controle EFÊMERO em
 * memória das duas filas shadow (src/ai/index.ts).
 */

const TOKEN = 'tok-dashboard-jev';
let server: any;
let savedTestToken = '';

before(async () => {
  savedTestToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  // Não vaza pausa/cooldown para outras suítes: estado efêmero, restaura.
  aiControl.resume();
  aiControl.resetCooldown();
  resetTypesafeForTests();
  config.jackett.testToken = savedTestToken;
});

test('ações do Jev pausam, retomam, drenam e zeram o cooldown das filas shadow', async () => {
  const pause = await server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { action: 'jev-pause' },
  });
  assert.equal(pause.status, 200);
  assert.equal(pause.json.ok, true);
  assert.equal(pause.json.action, 'jev-pause');
  assert.equal(pause.json.paused, true);
  assert.equal(pause.json.status.audioClassify, true, 'a pausa alcança a pergunta 1');
  assert.equal(pause.json.status.dubLie, true, 'a pausa é GLOBAL (pergunta 2 também)');
  assert.equal(aiControl.isPaused(), true);

  const resume = await server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { action: 'jev-resume' },
  });
  assert.equal(resume.status, 200);
  assert.equal(resume.json.ok, true);
  assert.equal(resume.json.action, 'jev-resume');
  assert.equal(resume.json.paused, false);
  assert.equal(resume.json.status.audioClassify, false, 'o retomar libera a pergunta 1');
  assert.equal(resume.json.status.dubLie, false, 'e a pergunta 2 junto');
  assert.equal(aiControl.isPaused(), false);

  const drain = await server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { action: 'jev-drain' },
  });
  assert.equal(drain.status, 200);
  assert.equal(drain.json.ok, true);
  assert.equal(drain.json.action, 'jev-drain');

  const reset = await server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { action: 'jev-cooldown-reset' },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.ok, true);
  assert.equal(reset.json.action, 'jev-cooldown-reset');
});

test('jev-disagreements: 401 sem token; 200 com token devolve os dois anéis', async () => {
  // Read-only e NÃO destrutiva: fora de DESTRUCTIVE_ACTIONS (sem `confirm`).
  assert.equal(DESTRUCTIVE_ACTIONS.has('jev-disagreements'), false);

  // Sem token o guard corta ANTES do despacho.
  const semToken = await server.request('POST', '/dashboard-action.json', {
    body: { action: 'jev-disagreements' },
  });
  assert.equal(semToken.status, 401);

  resetTypesafeForTests();
  const comToken = await server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { action: 'jev-disagreements' },
  });
  assert.equal(comToken.status, 200);
  assert.equal(comToken.json.ok, true);
  assert.equal(comToken.json.action, 'jev-disagreements');
  assert.ok(Array.isArray(comToken.json.audioClassify), 'anel da pergunta 1 é lista');
  assert.ok(Array.isArray(comToken.json.dubLie), 'anel da pergunta 2 é lista');
  // Estado em memória, sem comportamento extra: a fachada e a ação leem o mesmo.
  assert.deepEqual(comToken.json.audioClassify, jevDisagreements().audioClassify);
  assert.deepEqual(comToken.json.dubLie, jevDisagreements().dubLie);
});
