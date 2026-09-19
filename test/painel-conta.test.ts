// Aba Conta: modelo puro da origem do número (instalação / operador / ausente)
// e o render que dela decorre. Sem DOM e sem rede.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contaView } from '../src/client/painel/conta-model.js';
import { ViewConta } from '../src/client/painel/view-conta.js';

/** Texto visível do VNode, achatado — é como a asserção lê o card. */
function textOf(node: any): string {
  if (node == null || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return String(node);
  if (typeof node.type === 'function') return textOf(node.type(node.props || {}));
  return textOf(node.props?.children);
}

/** Resposta real de produção (17/09/2026) com o painel aberto na RAIZ. */
const SEM_CHAVE_NA_REQUISICAO = {
  active: null,
  account: { ok: false, reason: 'sem-debrid', service: null },
  accounts: {
    alldebrid: {
      magnets: 864,
      ready: 857,
      active: 7,
      error: 0,
      oldestAt: 1787604585,
      ok: true,
      service: 'alldebrid',
      label: 'AllDebrid',
      warn: true,
      warnAt: 800,
    },
  },
};

const CONTA_ZERADA = {
  ok: false,
  service: null,
  label: null,
  total: 0,
  ready: 0,
  downloading: 0,
  dead: 0,
  cap: 1000,
  warnAt: 800,
  usagePercent: 0,
  oldestAt: null,
};

describe('contaView', () => {
  test('conta da instalação manda, e o aviso do operador vira warn', () => {
    const v = contaView(
      { ok: true, service: 'premiumize', label: 'Premiumize', total: 820, ready: 800, downloading: 20, dead: 0, cap: 1000, warnAt: 800, usagePercent: 82, oldestAt: 1787604585 },
      SEM_CHAVE_NA_REQUISICAO,
    );
    assert.equal(v.origem, 'instalacao');
    assert.equal(v.service, 'premiumize');
    assert.equal(v.total, 820);
    assert.equal(v.badge.variant, 'warn');
    assert.equal(v.nota, '');
  });

  test('sem chave na requisição, cai na conta do operador em vez de zero', () => {
    const v = contaView(CONTA_ZERADA, SEM_CHAVE_NA_REQUISICAO);
    assert.equal(v.origem, 'operador');
    assert.equal(v.service, 'alldebrid');
    assert.equal(v.total, 864);
    assert.equal(v.ready, 857);
    assert.equal(v.downloading, 7);
    assert.equal(v.percent, 86);
    assert.equal(v.oldestAt, 1787604585);
    // 864 passou do warnAt 800: o número que motiva abrir o painel.
    assert.equal(v.badge.variant, 'warn');
    assert.match(v.nota, /operador/i);
  });

  test('90% ou mais é err, mesmo vindo do operador', () => {
    const debrid = { accounts: { alldebrid: { ok: true, magnets: 950, ready: 950, service: 'alldebrid', label: 'AllDebrid' } } };
    assert.equal(contaView(CONTA_ZERADA, debrid).badge.variant, 'err');
  });

  test('nenhuma conta viva: estado de configuração, não zero disfarçado de conta limpa', () => {
    const v = contaView(CONTA_ZERADA, { account: { ok: false, reason: 'sem-debrid' }, accounts: {} });
    assert.equal(v.origem, 'ausente');
    assert.equal(v.total, 0);
    assert.equal(v.badge.text, 'SEM DEBRID');
    assert.equal(v.badge.variant, 'neutral');
    assert.match(v.nota, /URL de instalação/i);
  });

  test('com mais de uma conta viva, prefere a do serviço ativo', () => {
    const debrid = {
      active: 'alldebrid',
      accounts: {
        premiumize: { ok: true, magnets: 10, service: 'premiumize', label: 'Premiumize' },
        alldebrid: { ok: true, magnets: 864, service: 'alldebrid', label: 'AllDebrid' },
      },
    };
    assert.equal(contaView(CONTA_ZERADA, debrid).service, 'alldebrid');
  });

  test('payload ausente não explode', () => {
    const v = contaView(undefined, undefined);
    assert.equal(v.origem, 'ausente');
    assert.equal(v.cap, 1000);
    assert.equal(v.percent, 0);
  });
});

describe('ViewConta', () => {
  test('mostra a conta do operador e diz de onde o número veio', () => {
    const texto = textOf(ViewConta({ conta: CONTA_ZERADA, debrid: SEM_CHAVE_NA_REQUISICAO } as any));
    assert.match(texto, /864/);
    assert.match(texto, /857/);
    assert.match(texto, /Conta do operador/i);
    assert.doesNotMatch(texto, /SEM DEBRID/);
  });

  test('sem conta nenhuma, o card não finge conta limpa', () => {
    const texto = textOf(ViewConta({ conta: CONTA_ZERADA, debrid: { accounts: {} } } as any));
    assert.match(texto, /SEM DEBRID/);
    assert.match(texto, /URL de instalação/i);
  });
});
