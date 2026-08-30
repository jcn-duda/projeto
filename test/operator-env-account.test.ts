import { test } from 'node:test';
import assert from 'node:assert/strict';

// Persistência desligada antes dos requires: o catálogo lê o próprio banco
// local e os testes não podem tocar o data/ do repo.
process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { catalogStatusEnv } from '../src/debrid/catalog-env.js';
import { defaults } from '../src/runtime.js';

// ---------------------------------------------------------------------------
// Dois gates de chave, de propósito separados (config/debrid.ts):
// - allowEnvKey ........ HERANÇA da chave do .env para instalações sem dk
// - operatorEnvAccount . FEATURES de operador (catálogo, varreduras, painel)
//   - envOperatorAccount é o OU dos dois (preserva o modo de usuário único)
// Caso real que motivou o motivo explícito: VPS com DEBRID_API_KEY presente e
// DEBRID_ALLOW_ENV_KEY=false mostrava "sem-conta-operador" — dizia o oposto
// do que o .env demonstrava e escondia o conserto.
// ---------------------------------------------------------------------------

type Saved = {
  service: string;
  apiKey: string;
  allowEnvKey: boolean;
  operatorEnvAccount: boolean;
};

function save(): Saved {
  return {
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    allowEnvKey: config.debrid.allowEnvKey,
    operatorEnvAccount: config.debrid.operatorEnvAccount,
  };
}

function restore(s: Saved) {
  config.debrid.service = s.service;
  config.debrid.apiKey = s.apiKey;
  config.debrid.allowEnvKey = s.allowEnvKey;
  config.debrid.operatorEnvAccount = s.operatorEnvAccount;
}

test('catálogo: sem DEBRID_API_KEY segue sem-conta-operador', () => {
  const s = save();
  try {
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = '';
    config.debrid.allowEnvKey = true;
    const r = catalogStatusEnv();
    assert.equal(r.ok, false);
    assert.equal((r as { reason?: string }).reason, 'sem-conta-operador');
  } finally {
    restore(s);
  }
});

test('catálogo: chave presente com uso desligado devolve motivo próprio + hint', () => {
  const s = save();
  try {
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = 'chave-do-operador';
    config.debrid.allowEnvKey = false;
    config.debrid.operatorEnvAccount = false;
    const r = catalogStatusEnv() as { ok: false; reason: string; hint?: string };
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'chave-operador-desativada');
    assert.match(r.hint || '', /DEBRID_OPERATOR_ENV_ACCOUNT/);
    assert.match(r.hint || '', /DEBRID_ALLOW_ENV_KEY/);
  } finally {
    restore(s);
  }
});

test('catálogo: operatorEnvAccount=true liga o painel SEM herdar chave (allowEnvKey=false)', () => {
  const s = save();
  try {
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = 'chave-do-operador';
    config.debrid.allowEnvKey = false;
    config.debrid.operatorEnvAccount = true;
    const r = catalogStatusEnv();
    // Leitura local do banco (sem rede): ok significa que a guarda abriu.
    assert.equal(r.ok, true);
    assert.equal((r as { report?: unknown }).report !== undefined, true);
  } finally {
    restore(s);
  }
});

test('runtime: operatorEnvAccount NÃO entrega a chave do .env a instalação sem dk', () => {
  const s = save();
  try {
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = 'chave-do-operador';
    config.debrid.allowEnvKey = false;
    config.debrid.operatorEnvAccount = true;
    assert.equal(defaults().debridApiKey, '', 'herança continua vedada pelo allowEnvKey');
    assert.equal(defaults().debridService, 'alldebrid');
  } finally {
    restore(s);
  }
});

test('config: DEBRID_OPERATOR_ENV_ACCOUNT=true vira gate de operador via env', async () => {
  process.env.DEBRID_ALLOW_ENV_KEY = 'false';
  process.env.DEBRID_OPERATOR_ENV_ACCOUNT = 'true';
  try {
    // Instância fresca da fábrica (bust de cache via query): a config é um
    // singleton no topo dos módulos, e o teste não pode mutar o compartilhado.
    const fresh = (await import('../src/config.js' + '?operator-env=override')) as any;
    assert.equal(fresh.default.debrid.allowEnvKey, false);
    assert.equal(fresh.default.debrid.operatorEnvAccount, true);
    assert.equal(fresh.default.debrid.envOperatorAccount, true);
  } finally {
    delete process.env.DEBRID_ALLOW_ENV_KEY;
    delete process.env.DEBRID_OPERATOR_ENV_ACCOUNT;
  }
});

test('config: default do flag novo é false e não muda quem nunca o setou', async () => {
  delete process.env.DEBRID_OPERATOR_ENV_ACCOUNT;
  process.env.DEBRID_ALLOW_ENV_KEY = 'true';
  try {
    const fresh = (await import('../src/config.js' + '?operator-env=default')) as any;
    assert.equal(fresh.default.debrid.operatorEnvAccount, false);
    assert.equal(fresh.default.debrid.envOperatorAccount, true, 'allowEnvKey=true segue ligando tudo');
  } finally {
    delete process.env.DEBRID_ALLOW_ENV_KEY;
  }
});
