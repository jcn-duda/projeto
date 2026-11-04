import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as autofetch from '../src/providers/autofetch.js';
import { NATIVE_BUDGET_PREFIX } from '../src/providers/autofetch-budget-native.js';
import { kvForget, kvSet } from '../src/utils/native-kv.js';
import { H1 } from './helpers/autofetch-fixtures.js';

test('snapshot conta o dead gravado direto no KV nativo (escritor é o worker do gateway)', () => {
  const adapterId = 'alldebrid';
  const account = 'acc_reindex_dead';
  const key = autofetch.deadKey(adapterId, account, H1);
  kvForget(key);
  const base = autofetch.snapshot().deadBlacklistCount;

  // Plantio DIRETO no KV, sem `blacklist()` nem reindex: é o que o worker
  // nativo faz. Antes o painel ficava em 0 até o próximo boot do Node.
  kvSet(key, 1, 3600);
  assert.equal(autofetch.snapshot().deadBlacklistCount, base + 1, 'dead nativo aparece no snapshot seguinte');
  assert.equal(autofetch.reindexDead(), 0, 'snapshot já sincronizou o índice');
  assert.equal(autofetch.isDead(adapterId, account, H1), true, 'dead plantado legível');

  kvForget(key);
  assert.equal(autofetch.snapshot().deadBlacklistCount, base, 'forget + snapshot tira o dead do índice');
});

test('snapshot lê o orçamento horário reservado pelo worker nativo', () => {
  const now = Date.now();
  const key = `${NATIVE_BUDGET_PREFIX}${'ab'.repeat(32)}`;
  kvForget(key);
  autofetch.resetBudget();
  const empty = autofetch.snapshot().budget;
  assert.equal(empty.used, 0);
  assert.ok(empty.limit > 0, 'sem reserva o teto configurado ainda aparece (nada de 0 / 0)');

  // Um carimbo fora da janela de 1 h não conta.
  kvSet(key, [now - 2 * 3600_000, now - 60_000, now - 1000], 3600);
  const snap = autofetch.snapshot().budget;
  assert.equal(snap.used, 2, 'só os carimbos da última hora contam');
  assert.equal(snap.limit, empty.limit, 'uma conta nativa = um teto');
  assert.equal(snap.accounts.length, 1);
  assert.equal(snap.accounts[0].id, 'ab'.repeat(6));
  kvForget(key);
});
