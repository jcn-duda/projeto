import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as secretBox from '../src/utils/secret-box.js';
import { defaults } from '../src/runtime.js';
import * as harvesterDebrid from '../src/utils/harvester-debrid-live.js';

const SECRET = 'segredo-do-operador-de-teste';
const PANEL_KEY = 'chave-painel-42-abcdef';
const ENV_KEY = 'chave-env-do-operador';
const LONG_KEY = 'x'.repeat(600);

// O módulo é singleton process-wide: salva a config real uma vez e restaura em
// cada teste, para o estado de um caso nunca vazar para o próximo.
const saved = {
  service: config.debrid.service,
  apiKey: config.debrid.apiKey,
  allowEnvKey: config.debrid.allowEnvKey,
  operatorEnvAccount: config.debrid.operatorEnvAccount,
  resolveSecret: config.debrid.resolveSecret,
};

function restoreConfig() {
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.apiKey;
  config.debrid.allowEnvKey = saved.allowEnvKey;
  config.debrid.operatorEnvAccount = saved.operatorEnvAccount;
  config.debrid.resolveSecret = saved.resolveSecret;
}

beforeEach(() => {
  restoreConfig();
  harvesterDebrid.resetForTest();
});

afterEach(() => {
  restoreConfig();
  harvesterDebrid.resetForTest();
});

test('harvesterDebrid: capacidades derivadas do adaptador (quota-warn genérico, warm só RD)', () => {
  assert.deepEqual(harvesterDebrid.deriveCapabilities('realdebrid'), { quotaWarn: true, brWarm: true });
  assert.deepEqual(harvesterDebrid.deriveCapabilities('alldebrid'), { quotaWarn: true, brWarm: false });
  assert.deepEqual(harvesterDebrid.deriveCapabilities('torbox'), { quotaWarn: true, brWarm: false });
  // Debrid-Link não tem accountStatus; a capacidade reflete o contrato real do adaptador.
  assert.deepEqual(harvesterDebrid.deriveCapabilities('debridlink'), { quotaWarn: false, brWarm: false });
  assert.deepEqual(harvesterDebrid.deriveCapabilities(''), { quotaWarn: false, brWarm: false });
  assert.deepEqual(harvesterDebrid.deriveCapabilities('servico-inexistente'), { quotaWarn: false, brWarm: false });
});

test('harvesterDebrid: set sem RESOLVE_SECRET recusa e não grava nada', () => {
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = '';
  const r = harvesterDebrid.set('realdebrid', PANEL_KEY);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'resolve_secret_required');
    assert.match(r.fix, /RESOLVE_SECRET/);
  }
  assert.equal(harvesterDebrid.get(), null, 'nada foi armazenado');
  assert.equal(harvesterDebrid.snapshot().source, 'none');
});

test('harvesterDebrid: set exige o gate de operador como o catalog-env', () => {
  config.debrid.allowEnvKey = false;
  config.debrid.operatorEnvAccount = false;
  config.debrid.resolveSecret = SECRET;
  const r = harvesterDebrid.set('realdebrid', PANEL_KEY);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'chave-operador-desativada');
  assert.equal(harvesterDebrid.get(), null);
});

test('harvesterDebrid: set com serviço desconhecido e chave longa demais recusam', () => {
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;
  const r1 = harvesterDebrid.set('nope', PANEL_KEY);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, 'servico-desconhecido');

  const r2 = harvesterDebrid.set('realdebrid', LONG_KEY);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, 'chave-invalida');
  assert.equal(harvesterDebrid.get(), null);
});

test('harvesterDebrid: set grava selo AES (nunca a chave crua) e o snapshot só expõe identidade', () => {
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;
  const r = harvesterDebrid.set('realdebrid', PANEL_KEY);
  assert.equal(r.ok, true);

  const stored = harvesterDebrid.get();
  assert.ok(stored);
  assert.equal(stored!.service, 'realdebrid');
  assert.notEqual(stored!.sealedKey, PANEL_KEY, 'chave crua não é armazenada');
  assert.equal(secretBox.isSealed(stored!.sealedKey), true);
  assert.equal(secretBox.open(stored!.sealedKey), PANEL_KEY);

  // O cache persistido também carrega só o blob selado.
  const raw = cache.get(`${prefix('cfg')}harvesterDebrid`) as { sealedKey?: string } | null;
  assert.ok(raw);
  assert.equal(secretBox.isSealed(raw!.sealedKey), true);

  const snap = harvesterDebrid.snapshot();
  assert.equal(snap.service, 'realdebrid');
  assert.equal(snap.source, 'panel');
  assert.equal(snap.keySet, true);
  assert.equal(snap.sealed, true);
  assert.equal(snap.last4, PANEL_KEY.slice(-4));
  assert.equal(snap.fingerprint.length, 8);
  assert.ok(snap.updatedAt && snap.updatedAt > 0);
  assert.equal(JSON.stringify(snap).includes(PANEL_KEY), false, 'snapshot nunca ecoa a chave crua');
});

test('harvesterDebrid: reset via chave vazia limpa sem gate nem segredo', () => {
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;
  assert.equal(harvesterDebrid.set('realdebrid', PANEL_KEY).ok, true);
  assert.equal(harvesterDebrid.get()?.service, 'realdebrid');

  // Clear não grava nada: roda mesmo com gate fechado e sem RESOLVE_SECRET.
  config.debrid.allowEnvKey = false;
  config.debrid.operatorEnvAccount = false;
  config.debrid.resolveSecret = '';
  const r = harvesterDebrid.set('', '   ');
  assert.equal(r.ok, true, 'chave vazia é reset, não validação');
  assert.equal(harvesterDebrid.get(), null);
  assert.equal(cache.get(`${prefix('cfg')}harvesterDebrid`), null, 'registro removido do cache');
});

test('harvesterDebrid: resolveQuota — painel vence o .env e o clear volta ao .env', () => {
  // .env = AllDebrid com gate aberto.
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = ENV_KEY;
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;

  const envQuota = harvesterDebrid.resolveQuota();
  assert.ok(envQuota);
  assert.equal(envQuota!.adapter.id, 'alldebrid');
  assert.equal(envQuota!.apiKey, ENV_KEY);

  // Painel grava TorBox: fonte única.
  assert.equal(harvesterDebrid.set('torbox', PANEL_KEY).ok, true);
  const panelQuota = harvesterDebrid.resolveQuota();
  assert.ok(panelQuota);
  assert.equal(panelQuota!.adapter.id, 'torbox');
  assert.equal(panelQuota!.apiKey, PANEL_KEY);

  // Clear: volta ao .env.
  assert.equal(harvesterDebrid.set('torbox', '').ok, true);
  const back = harvesterDebrid.resolveQuota();
  assert.ok(back);
  assert.equal(back!.adapter.id, 'alldebrid');
  assert.equal(back!.apiKey, ENV_KEY);
});

test('harvesterDebrid: resolveQuota respeita o gate de operador (env sem gate = null)', () => {
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = ENV_KEY;
  config.debrid.allowEnvKey = false;
  config.debrid.operatorEnvAccount = false;
  assert.equal(harvesterDebrid.resolveQuota(), null, 'chave do .env sem gate de operador não é usada');
  const closed = harvesterDebrid.snapshot();
  assert.equal(closed.source, 'none', 'status não anuncia conta env com gate fechado');
  assert.equal(closed.keySet, false, 'identidade da chave fica oculta com gate fechado');
  assert.equal(closed.envService, 'alldebrid', 'serviço permanece como pista de configuração');

  config.debrid.operatorEnvAccount = true;
  assert.equal(harvesterDebrid.resolveQuota()?.apiKey, ENV_KEY, 'operatorEnvAccount abre o env');
  assert.equal(harvesterDebrid.snapshot().source, 'env', 'status acompanha o gate aberto');
});

test('harvesterDebrid: resolveWarm — env RD + gate liga; painel RD vence; painel AllDebrid DESLIGA mesmo com env RD', () => {
  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = ENV_KEY;
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;

  const env = harvesterDebrid.resolveWarm();
  assert.deepEqual(env, { source: 'env', apiKey: ENV_KEY });

  assert.equal(harvesterDebrid.set('realdebrid', PANEL_KEY).ok, true);
  const panelRd = harvesterDebrid.resolveWarm();
  assert.deepEqual(panelRd, { source: 'panel', apiKey: PANEL_KEY });

  // Override AllDebrid: o .env RD NÃO pode voltar por baixo (contrato).
  assert.equal(harvesterDebrid.set('alldebrid', 'chave-ad-do-painel').ok, true);
  assert.deepEqual(harvesterDebrid.resolveWarm(), { source: 'off', reason: 'painel-desliga' });

  // Clear: volta ao env RD.
  assert.equal(harvesterDebrid.set('alldebrid', '').ok, true);
  assert.deepEqual(harvesterDebrid.resolveWarm(), { source: 'env', apiKey: ENV_KEY });
});

test('harvesterDebrid: resolveWarm sem conta nenhuma vai para off sem-conta', () => {
  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = ENV_KEY;
  config.debrid.allowEnvKey = false;
  config.debrid.operatorEnvAccount = false;
  assert.deepEqual(harvesterDebrid.resolveWarm(), { source: 'off', reason: 'sem-conta' });
  assert.equal(harvesterDebrid.resolveQuota(), null);
});

test('harvesterDebrid: snapshot sem RESOLVE_SECRET com selo armazenado vira keySet false e sealBroken true', () => {
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;
  assert.equal(harvesterDebrid.set('realdebrid', PANEL_KEY).ok, true);

  // Servidor perdeu o RESOLVE_SECRET (ou trocou): o selo não abre mais.
  config.debrid.resolveSecret = '';
  const snap = harvesterDebrid.snapshot();
  assert.equal(snap.service, 'realdebrid');
  assert.equal(snap.source, 'panel');
  assert.equal(snap.sealed, true);
  assert.equal(snap.keySet, false);
  // Sinal explícito de selo órfão (rotacionou o RESOLVE_SECRET): a UI mostra
  // o aviso em vez de apenas "chave não definida" com o serviço do painel.
  assert.equal(snap.sealBroken, true);
  assert.equal(snap.last4, '');
  assert.equal(snap.fingerprint, '');
  assert.equal(JSON.stringify(snap).includes(PANEL_KEY), false);

  // Nenhum consumidor recebe a chave; o warm fica desligado (fonte única) e o
  // quota-warn não roda — nunca um valor lixo indo para a API.
  assert.deepEqual(harvesterDebrid.resolveWarm(), { source: 'off', reason: 'painel-desliga' });
  assert.equal(harvesterDebrid.resolveQuota(), null);
});

test('harvesterDebrid: snapshot expõe capabilitiesByService (mesma fonte do backend, sem drift no front)', () => {
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;
  config.debrid.service = '';
  config.debrid.apiKey = '';
  const snap = harvesterDebrid.snapshot();
  const byService = snap.capabilitiesByService;
  assert.ok(byService, 'mapa de capacidades por serviço presente');
  assert.deepEqual(byService.alldebrid, { quotaWarn: true, brWarm: false }, 'AllDebrid: quota-warn sim, warm RD não');
  assert.deepEqual(byService.realdebrid, { quotaWarn: true, brWarm: true }, 'RD: ambos');
  assert.deepEqual(byService.debridlink, { quotaWarn: false, brWarm: false }, 'Debrid-Link não tem accountStatus');
});

test('harvesterDebrid: inicialização preguiçosa relê do cache após resetMemory', () => {
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;
  assert.equal(harvesterDebrid.set('torbox', PANEL_KEY).ok, true);
  const original = harvesterDebrid.get();
  assert.ok(original);

  harvesterDebrid.resetMemory();
  // A primera chamada pós-reset relê do cache (get → initIfNeeded).
  const rehydrated = harvesterDebrid.get();
  assert.ok(rehydrated, 'conta relida do cache');
  assert.equal(rehydrated!.service, 'torbox');
  assert.equal(secretBox.open(rehydrated!.sealedKey), PANEL_KEY);
  assert.equal(rehydrated!.updatedAt, original!.updatedAt, 'updatedAt preservado no roundtrip');

  const snap = harvesterDebrid.snapshot();
  assert.equal(snap.source, 'panel');
  assert.equal(snap.keySet, true);
});

test('harvesterDebrid: override NÃO toca a config do .env nem o runtime de instalação', () => {
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = ENV_KEY;
  config.debrid.allowEnvKey = true;
  config.debrid.resolveSecret = SECRET;

  const defaultsBefore = defaults().debridApiKey;
  assert.equal(harvesterDebrid.set('torbox', PANEL_KEY).ok, true);

  // O caminho do usuário (env + runtime) continua intacto: nada do painel
  // vaza para opts()/current() nem para instalações anônimas.
  assert.equal(config.debrid.service, 'alldebrid');
  assert.equal(config.debrid.apiKey, ENV_KEY);
  assert.equal(defaults().debridApiKey, defaultsBefore);
  assert.equal(harvesterDebrid.resolveQuota()?.adapter.id, 'torbox');
});
