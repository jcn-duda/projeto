const { test } = require('node:test');
const assert = require('node:assert');

const { accountScope, streamsCacheKey } = require('../src/utils/request-key');

test('streamsCacheKey isola contas de debrid sem expor a API key', () => {
  const base = { providers: ['jackett'], maxResults: 40 };
  const alice = streamsCacheKey('movie', 'tt123', { ...base, debridApiKey: 'alice-secret' });
  const bob = streamsCacheKey('movie', 'tt123', { ...base, debridApiKey: 'bob-secret' });

  assert.notEqual(alice, bob);
  assert.equal(alice.includes('alice-secret'), false);
  assert.equal(bob.includes('bob-secret'), false);
  assert.equal(alice, streamsCacheKey('movie', 'tt123', { ...base, debridApiKey: 'alice-secret' }));
  assert.equal(alice.startsWith('streams:v2:'), true);
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
