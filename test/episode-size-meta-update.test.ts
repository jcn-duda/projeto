import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cache from '../src/utils/cache.js';
import { getMeta } from '../src/utils/cinemeta.js';
import { stubFetch } from './helpers/stub.js';

test('meta de série gravada sem a contagem volta ao Cinemeta uma única vez', async () => {
  const imdbId = `tt-ep-antiga-${process.pid}-${Date.now()}`;
  const key = `meta:series:${imdbId}`;
  cache.set(key, { name: 'Goliath', year: '2016', type: 'series' }, 60);
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ meta: { name: 'Goliath', year: '2016', videos: [{ season: 3 }] } }) }));
  try {
    const meta = await getMeta('series', imdbId);
    assert.equal(stub.calls.length, 1, 'a meta antiga busca a contagem');
    assert.equal(JSON.stringify(meta?.episodes), JSON.stringify({ 3: 1 }));
    await getMeta('series', imdbId);
    assert.equal(stub.calls.length, 1, 'a meta atualizada não chama de novo');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});

test('falha ao atualizar a meta antiga devolve a meta gravada, sem virar miss', async () => {
  const imdbId = `tt-ep-falha-${process.pid}-${Date.now()}`;
  const key = `meta:series:${imdbId}`;
  cache.set(key, { name: 'Goliath', year: '2016', type: 'series' }, 60);
  const stub = stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    const meta = await getMeta('series', imdbId);
    assert.equal(meta?.name, 'Goliath', 'a busca segue com nome e ano');
    assert.equal(cache.get(key)?.name, 'Goliath', 'a entrada gravada não vira miss');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});
