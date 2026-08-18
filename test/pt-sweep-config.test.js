const { test } = require('node:test');
const assert = require('node:assert');

// A flag precisa ser fixada ANTES do require: config.js lê o process.env uma
// única vez no carregamento, e cada arquivo de teste roda em processo próprio.
process.env.JACKETT_PT_SWEEP_GLOBAL = 'false';

const config = require('../src/config');

test('JACKETT_PT_SWEEP_GLOBAL=false desliga a varredura pt-BR nos globais', () => {
  assert.equal(config.jackett.ptSweepGlobal, false);
});
