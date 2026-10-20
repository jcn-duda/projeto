// `markKnownBroken`: o histórico ruim da CONTA (bad/lie/dead) vira `broken` nos
// itens das rotas internas, para o `/stream` nativo cortar o que o
// `pruneKnownBroken` do Node corta. Sem debrid/chave nada é marcado (controle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { markKnownBroken } from '../src/routes/internal-search-evidence.js';

const adapter = {
  id: 'premiumize', label: 'Premiumize fake', short: 'pm', cacheCheck: true, keyUrl: 'https://x.test',
  async checkCached() { return { cached: new Set(), complete: true }; },
  async resolveLink() { return null; },
};

test('markKnownBroken marca bad e lie da conta e deixa o resto', () => {
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-broken-route';
  const bad = '1'.repeat(40);
  const lie = '2'.repeat(40);
  const ok = '3'.repeat(40);
  magnetdb.forgetBad('premiumize', key, bad);
  magnetdb.markBad('premiumize', key, bad);
  magnetdb.markLie('premiumize', key, lie);
  try {
    const items: any[] = [{ infoHash: bad }, { infoHash: lie }, { infoHash: ok }];
    runtime.run({ opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: key }, encoded: 'x' }, () => {
      markKnownBroken(items);
    });
    assert.deepEqual(items.map((i) => Boolean(i.broken)), [true, true, false]);

    // Outra conta não herda a marca (cache de debrid pertence a ela).
    const outros: any[] = [{ infoHash: bad }];
    runtime.run({ opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'outra-chave' }, encoded: 'y' }, () => {
      markKnownBroken(outros);
    });
    assert.equal(Boolean(outros[0].broken), false);
  } finally {
    magnetdb.forgetBad('premiumize', key, bad);
    if (original) debrid.BY_ID.set('premiumize', original); else debrid.BY_ID.delete('premiumize');
  }
});
