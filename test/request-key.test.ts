import { test } from 'node:test';
import assert from 'node:assert';

import { accountScope, streamsCacheKey } from '../src/utils/request-key.js';
import { prefix } from '../src/utils/cache-keys.js';

test('streamsCacheKey isola contas de debrid sem expor a API key', () => {
  const base = { providers: ['jackett'], maxResults: 40 };
  const alice = streamsCacheKey('movie', 'tt123', { ...base, debridApiKey: 'alice-secret' });
  const bob = streamsCacheKey('movie', 'tt123', { ...base, debridApiKey: 'bob-secret' });

  assert.notEqual(alice, bob);
  assert.equal(alice.includes('alice-secret'), false);
  assert.equal(bob.includes('bob-secret'), false);
  assert.equal(alice, streamsCacheKey('movie', 'tt123', { ...base, debridApiKey: 'alice-secret' }));
  assert.equal(alice.startsWith('streams:v18:'), true);
});

test('versões correntes separam lista v18 do índice v13', () => {
  // A correção BR_MARK (.org genérico), DUB/HINDI e a fronteira `bthd` mudam
  // matching/ranking; o AGENTS.md manda invalidar streams+idx juntos. v11: a
  // guarda do rutracker passa a aceitar FAIXA de anos (`[1999-2003, …] Dub`),
  // mesma classe do Coyote Ugly — o índice persiste `dubbed`/`isBr` OR-aderente
  // e não se corrigiria só com o reboot. A lista está em v16 pelo MESMO
  // conserto (v15 foi o overlay Jev gateado, que muda `_br`/`_dubbed` da lista);
  // o idx bumpa agora porque a classificação determinística dele mudou.
  // v17/v12: `seleZen` (DUB russo) entrou na mesma guarda. v18/v13: `LAT.DUB`
  // e o espelho de cena EN publicado por site BR.
  assert.equal(prefix('streams'), 'streams:v18:');
  assert.equal(prefix('idx'), 'idx:v13:');
});

test('streamsCacheKey preserva a separação por conteúdo e por modo sem conta', () => {
  const base = { providers: ['jackett'], maxResults: 40 };
  assert.notEqual(
    streamsCacheKey('movie', 'tt123', base),
    streamsCacheKey('movie', 'tt123', { ...base, maxResults: 20 }),
  );
  assert.equal(accountScope(''), accountScope(undefined));
  assert.notEqual(accountScope('key-a'), accountScope('key-b'));
});

test('cache separa prioridade e cotas por qualidade', () => {
  const base = { providers: ['jackett'], max1080p: 4, indexerPriority: [] };
  assert.notEqual(
    streamsCacheKey('movie', 'tt123', base),
    streamsCacheKey('movie', 'tt123', { ...base, indexerPriority: ['nerdfilmes'] }),
  );
  assert.notEqual(
    streamsCacheKey('movie', 'tt123', base),
    streamsCacheKey('movie', 'tt123', { ...base, max1080p: 8 }),
  );
});


test('cache varia com o mapa de limites por indexador', () => {
  const base = { providers: ['jackett'], maxPerIndexer: 0, indexerLimits: {} };
  assert.notEqual(
    streamsCacheKey('movie', 'tt123', base),
    streamsCacheKey('movie', 'tt123', { ...base, indexerLimits: { yts: 3 } }),
  );
  // 0 é override explícito (sem limite) e precisa de cache próprio também.
  assert.notEqual(
    streamsCacheKey('movie', 'tt123', { ...base, indexerLimits: { yts: 3 } }),
    streamsCacheKey('movie', 'tt123', { ...base, indexerLimits: { yts: 0 } }),
  );
});

test('cache varia com resolveUncached para não misturar formas de stream', () => {
  const base = { providers: ['jackett'], maxResults: 40 };
  assert.notEqual(
    streamsCacheKey('movie', 'tt123', { ...base, resolveUncached: false }),
    streamsCacheKey('movie', 'tt123', { ...base, resolveUncached: true }),
  );
});
