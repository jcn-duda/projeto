import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import { H1 } from './helpers/autofetch-fixtures.js';

test('reindexDead reconstrói knownDead a partir do cache (bypass blacklist)', () => {
  const adapterId = 'alldebrid';
  const account = 'acc_reindex_dead';
  const key = autofetch.deadKey(adapterId, account, H1);
  cache.forget(key);
  // snapshot() prune entradas órfãs; garante que a chave plantada não está no Set.
  autofetch.snapshot();

  // Sem blacklist: knownDead só vê o morto após reindex.
  cache.set(key, 1, 3600);
  const before = autofetch.snapshot().deadBlacklistCount;
  const added = autofetch.reindexDead();
  assert.ok(added >= 1, 'reindex descobriu ao menos o dead plantado');
  const after = autofetch.snapshot().deadBlacklistCount;
  assert.equal(after, before + added, 'snapshot.deadBlacklistCount sobe pelo retorno do reindex');
  assert.equal(autofetch.isDead(adapterId, account, H1), true, 'dead plantado legível após reindex');

  cache.forget(key);
  // Prune no snapshot remove a chave esquecida do knownDead.
  const pruned = autofetch.snapshot().deadBlacklistCount;
  assert.equal(pruned, after - 1, 'forget + snapshot remove o dead reindexado do knownDead');
});
