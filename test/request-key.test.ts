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
  assert.equal(alice.startsWith('streams:v7:'), true);
});

test('bump de matching invalida streams e idx (v7): mudança de evitamento BR/DUB exige limpeza global', () => {
  // A correção BR_MARK (.org genérico) e DUB/HINDI muda matching/ranking; o
  // AGENTS.md manda invalidar streams+idx juntos. Fixa a versão corrente dos
  // dois nomespações para o bump não passar despercebido num próximo deploy.
  assert.equal(prefix('streams'), 'streams:v7:');
  assert.equal(prefix('idx'), 'idx:v7:');
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
