const { test } = require('node:test');
const assert = require('node:assert/strict');

const resolvers = {
  bludv: require('../bludv-resolver/server'),
  comandotorrents: require('../comandotorrents-resolver/server'),
  nerdfilmes: require('../nerdfilmes-resolver/server'),
  torrentdosfilmes: require('../torrentdosfilmes-resolver/server'),
};

for (const [name, resolver] of Object.entries(resolvers)) {
  test(`${name}: identidade do botão vence posição alterada`, () => {
    const listed = { url: 'https://systemads1.com/go/listado' };
    const links = [{ url: 'https://systemads1.com/go/novo' }, listed, { url: 'https://systemads1.com/go/outro' }];
    assert.equal(resolver.pickButton(links, 0, resolver.buttonId(listed), 2), listed);
  });

  test(`${name}: href rotacionado mantém fallback posicional quando contagem é igual`, () => {
    const links = [{ url: 'https://systemads1.com/go/rotacionado' }, { url: 'https://systemads1.com/go/outro' }];
    assert.equal(resolver.pickButton(links, 1, resolver.buttonId({ url: 'https://systemads1.com/go/antigo' }), '2'), links[1]);
  });

  test(`${name}: lista editada falha sem escolher outro botão`, () => {
    const links = [{ url: 'https://systemads1.com/go/novo' }, { url: 'https://systemads1.com/go/outro' }, { url: 'https://systemads1.com/go/terceiro' }];
    assert.equal(resolver.pickButton(links, 1, resolver.buttonId({ url: 'https://systemads1.com/go/antigo' }), 2), null);
  });

  test(`${name}: URL antiga sem hash permanece posicional`, () => {
    const links = [{ url: 'https://systemads1.com/go/um' }, { url: 'https://systemads1.com/go/dois' }];
    assert.equal(resolver.pickButton(links, 1, null, null), links[1]);
  });

  // O cardigann manda a href inteira (que já é um /resolve) como param `url`,
  // então i/h/n chegam num nível aninhado. Perder o h aqui derrubaria a
  // identidade de volta para posição sem ninguém perceber — é justamente o
  // caminho que o Jackett exercita em produção.
  test(`${name}: h e n sobrevivem ao desempacotamento aninhado`, () => {
    const inner = 'https://resolver/resolve?url=https%3A%2F%2Fsite.test%2Fpost%2F&i=3&h=abc123def0&n=7';
    const wrapped = `https://resolver/resolve?url=${encodeURIComponent(inner)}`;
    const { url, index, hash, count } = resolver.unwrapResolverUrl(wrapped);
    assert.deepEqual({ url, index, hash, count }, {
      url: 'https://site.test/post/', index: '3', hash: 'abc123def0', count: '7',
    });
  });

  // Chamada direta (sem nível aninhado) é o caminho do teste manual e do /dl:
  // os params da própria requisição precisam valer como semente.
  test(`${name}: chamada direta lê i/h/n da própria requisição`, () => {
    const { url, index, hash, count } = resolver.unwrapResolverUrl(
      'https://site.test/post/',
      { index: '2', hash: 'feedface01', count: '5' },
    );
    assert.deepEqual({ url, index, hash, count }, {
      url: 'https://site.test/post/', index: '2', hash: 'feedface01', count: '5',
    });
  });
}
