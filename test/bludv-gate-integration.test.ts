import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../resolvers/profiles/bludv.js';
import { stubFetch } from './helpers/stub.js';

import { gatePost, gateUrl, postUrl, siteUrl, legacyButton, legacyUrl, searchPage } from './helpers/bludv-gate-fixtures.js';

const gateHtml = gatePost();

test('BLUDV: post somente com gate produz botão resolvível, não erro legado', async () => {
  const resolver = createResolver({ siteUrl: 'https://bludvfilmes1.xyz' });
  const stub = stubFetch((url) => {
    assert.equal(url, postUrl, 'a descoberta não deve executar a cadeia do gate');
    return new Response(gateHtml);
  });
  try {
    const { links } = await resolver.getPostLinks(postUrl);
    assert.equal(links.length, 1, 'o portão não pode virar zero releases');
    assert.equal(links[0].url, gateUrl());
    assert.equal(links[0].quality, 1080);
  } finally {
    stub.restore();
  }
});

test('BLUDV: post misto conserva gate e legado como botões distintos', async () => {
  const resolver = createResolver({ siteUrl });
  const stub = stubFetch(() => new Response(gateHtml + legacyButton));
  try {
    const { links } = await resolver.getPostLinks(postUrl);
    assert.deepEqual(new Set(links.map((link) => link.url)), new Set([gateUrl(), legacyUrl]));
    assert.equal(links.length, 2);
  } finally { stub.restore(); }
});

test('BLUDV: busca lista gate sem esperar o prazo de anúncio de 30 segundos', { timeout: 3000 }, async () => {
  const resolver = createResolver({ siteUrl });
  const stub = stubFetch((url) => {
    if (url === `${siteUrl}/?s=filme%20fixture`) return new Response(searchPage());
    if (url === postUrl) return new Response(gateHtml);
    throw new Error('a listagem não pode esperar a resolução do gate');
  });
  try {
    const start = performance.now();
    const items = await resolver.searchPosts('filme fixture');
    assert.equal(items.length, 1, 'a busca deve publicar o botão /resolve, não []');
    assert.equal(items[0].link.url, gateUrl());
    assert.ok(performance.now() - start < 2000, 'a espera do anúncio vazou para a busca');
    // O card do Jackett consome o href da linha como DownloadUri e o resolve com
    // `?url=` — não `/dl`, que é a rota de botão do consumidor interativo.
    assert.match(resolver.searchPageHtml(items), /\/resolve\?url=/);
  } finally { stub.restore(); }
});
