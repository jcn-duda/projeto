// Autoridade das duas listas de limpeza (fail-safe simétrico do dropReady e
// do dropDownload) e a métrica de supressão.
//
// O dropDownload herdou o MESMO fail-safe do dropReady: só sai da conta o que
// o snapshot prova não ser do usuário, e a ausência de referência nunca
// autoriza remoção em NENHUMA das duas listas. O snapshot também é adquirido
// quando QUALQUER limpeza está ativa — desligar o dropReady não pode desligar
// a autoridade do dropDownload (N4), e a primeira checagem do processo (sem
// inventário) é supressão por FALTA DE AUTORIDADE, contada à parte para o
// diagnóstico não confundir com a proteção do acervo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { mockAccountWith, settle, flushImmediate } from './helpers/alldebrid-account-mock.js';

// A espera entre polls usa timer unref() — sem handle vivo o runner aborta os
// testes pendentes. Este handle só mantém o loop de pé durante o arquivo.
let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

test('B-1: snapshot fresco com o hash do usuário; eco não pronto — zero delete e zero etiqueta', async () => {
  // O upload é idempotente: a checagem toca um magnet que o usuário já tinha,
  // ele volta "não pronto" (a conta está re-baixando), e a limpeza de downloads
  // NÃO pode apagar o acervo nem a posse pode reetiquetá-lo como nosso.
  const KEY = 'chave-b1-cetico';
  const DO_USUARIO = 'f2'.repeat(20);
  const api = mockAccountWith([DO_USUARIO], [], { snapshotAfterUploads: true });
  metrics.reset();

  try {
    await alldebrid.warmInventory(KEY);
    await settle();
    await flushImmediate();

    await alldebrid.checkCached(KEY, [DO_USUARIO]);
    await settle();

    assert.deepEqual(api.deleted, [], 'o não-pronto do usuário é protegido pelo snapshot (fail-safe do dropDownload)');
    assert.equal(
      cache.get(`${prefix('adsub')}${accountScope(KEY)}:${DO_USUARIO}`),
      null,
      'zero etiqueta: hash presente no snapshot não é etiquetado como nosso',
    );
    assert.equal(
      metrics.snapshot().counters['debrid.dropped.download'] || 0,
      0,
      'nada de download foi removido de fato',
    );
  } finally {
    metrics.reset();
    api.restore();
  }
});

test('primeira checagem do processo com dropReady habilitado: nada de pronto sai e suppressedReady incrementa', async () => {
  // skipReadyDrop (sem inventário no primeiro request) é SUPRESSÃO por falta
  // de autoridade, não decisão — e agora conta com métrica própria.
  const KEY = 'chave-supressao-primeira';
  const NOVO = 'f3'.repeat(20);
  const api = mockAccountWith([], [NOVO]);
  metrics.reset();

  try {
    const result = await alldebrid.checkCached(KEY, [NOVO]);
    await settle();

    assert.equal(result.cached.has(NOVO), true, 'a checagem responde normalmente');
    assert.deepEqual(api.deleted, [], 'nada de pronto sai antes do inventário existir');
    assert.ok(
      (metrics.snapshot().counters['debrid.drop.suppressedReady'] || 0) >= 1,
      'a supressão por falta de autoridade é contada',
    );
  } finally {
    metrics.reset();
    api.restore();
  }
});

test('dropReady=false + dropUncached=true: snapshot adquirido, not-ready do usuário protegido, fantasma removido', async () => {
  // N4: a aquisição do snapshot não pode depender do dropReady. Com só o
  // dropUncached ativo, a limpeza de downloads ganha a MESMA autoridade — o
  // hash que o snapshot prova ser do usuário fica; o fantasma (fora do
  // snapshot) sai.
  const KEY = 'chave-drop-uncached-only';
  const DO_USUARIO = 'f4'.repeat(20);
  const FANTASMA = 'f5'.repeat(20);
  const api = mockAccountWith([DO_USUARIO], [], { snapshotAfterUploads: true });
  const originalReady = config.debrid.dropReady;
  const originalUncached = config.debrid.dropUncached;
  config.debrid.dropReady = false;
  config.debrid.dropUncached = true;

  try {
    await alldebrid.warmInventory(KEY);
    await settle();
    await flushImmediate();

    await alldebrid.checkCached(KEY, [DO_USUARIO, FANTASMA]);
    await settle();

    // O DO_USUARIO ficou com o id 1000 (preexistente); o FANTASMA, subido pela
    // checagem, ganhou o 2000 — é o único que a autoridade do snapshot deixa
    // a limpeza de downloads remover.
    assert.deepEqual(api.deleted, [2000], 'só o fantasma sai; o not-ready do usuário fica');
  } finally {
    config.debrid.dropReady = originalReady;
    config.debrid.dropUncached = originalUncached;
    api.restore();
  }
});
