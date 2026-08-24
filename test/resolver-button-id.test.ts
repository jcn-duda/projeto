import { test } from 'node:test';
import assert from 'node:assert/strict';

import bludv from '../bludv-resolver/server.js';
import comandotorrents from '../comandotorrents-resolver/server.js';
import nerdfilmes from '../nerdfilmes-resolver/server.js';
import torrentdosfilmes from '../torrentdosfilmes-resolver/server.js';
import text from '../resolvers/text.js';
import torznab from '../resolvers/torznab.js';
import nestedUrl from '../resolvers/nested-url.js';
import searchPosts from '../resolvers/search-posts.js';
import protector from '../resolvers/protector.js';

const resolvers = {
  bludv,
  comandotorrents,
  nerdfilmes,
  torrentdosfilmes,
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

test('texto comum dos resolvers preserva as variantes de entidades', () => {
  assert.equal(text.decodeEntities('A&#x26;B &#8211; &hellip; &NDASH; &foo;'), 'A&B – … – &foo;');
  assert.equal(text.decodeEntitiesBasic('&amp; &quot; &#8217; &#039; &apos; &nbsp; &ndash;'), '& " \' \' \'   &ndash;');
  assert.equal(text.stripTags(' <b>A&#8211;B</b> <i>&hellip;</i> '), 'A–B …');
  assert.equal(
    text.stripTags(' <b>A&#8211;B</b> <i>&hellip;</i> ', text.decodeEntitiesBasic),
    'A&#8211;B &hellip;',
  );
});

test('texto comum dos resolvers preserva tamanho, escaping e atributos', () => {
  assert.equal(text.parseSize('2,8 GB'), Math.round(2.8 * 1024 ** 3));
  assert.equal(text.parseSize('invalido'), null);
  assert.equal(text.escapeXml('&<>"'), '&amp;&lt;&gt;&quot;');
  assert.equal(text.escapeHtml, text.escapeXml);
  assert.equal(text.attribute('<a href = "https://site.test/?q=A&amp;B">', 'href'), null);
  assert.equal(
    text.attribute('<a href = "https://site.test/?q=A&amp;B">', 'href', {
      decode: text.decodeEntitiesBasic,
      allowWhitespace: true,
    }),
    'https://site.test/?q=A&B',
  );
});

test('núcleo Torznab e URLs aninhadas preserva o contrato dos profiles', () => {
  assert.equal(
    torznab.capsXml('Perfil &amp; teste'),
    `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Perfil &amp; teste" version="1.0"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,season,ep"/>
    <movie-search available="yes" supportedParams="q"/>
  </searching>
  <categories>
    <category id="2000" name="Movies"/>
    <category id="5000" name="TV"/>
  </categories>
</caps>`,
  );
  const nested = nestedUrl.unwrapResolverUrl(
    'https://resolver/dl?url=https%3A%2F%2Fsite.test%2Fpost%2F&i=4&audio=dublado',
    'https://resolver',
    { quality: '720' },
    { paths: ['/resolve', '/dl'], fields: { index: 'i', audio: 'audio', quality: 'quality' } },
  );
  assert.deepEqual(nested, {
    url: 'https://site.test/post/', index: '4', audio: 'dublado', quality: '720',
  });
});

test('seleção comum filtra título e temporada antes de aplicar o limite', () => {
  const posts = [
    { title: 'A Casa do Dragão 1ª Temporada' },
    { title: 'A Casa do Dragão 2ª Temporada' },
    { title: 'A Casa do Dragão 2ª Temporada Extra' },
    { title: 'Outro título 2ª Temporada' },
  ];
  const selected = searchPosts.selectSearchPosts(() => posts, '<html>', 'A Casa do Dragão', ['S02', '2'], 1);
  assert.deepEqual(selected, [{ title: 'A Casa do Dragão 2ª Temporada' }]);
});

test('matcher comum de hosts preserva domínio e subdomínio permitidos', () => {
  assert.equal(protector.hasAllowedHost('site.test', ['site.test']), true);
  assert.equal(protector.hasAllowedHost('cdn.site.test', ['site.test']), true);
  assert.equal(protector.hasAllowedHost('site.test.evil.test', ['site.test']), false);
});
