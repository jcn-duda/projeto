import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import { parseXml, fallback, load, resetCatalogCache } from '../src/providers/jackett-catalog.js';

test('parseXml lê catálogo Torznab sem expor campos extras', () => {
  const brId = config.jackett.ptBrIndexers[0] || 'comandotorrents';
  const xml = `
    <indexers>
      <indexer id="${brId}" configured="true">
        <title>Comando &amp; Torrents</title>
        <language>pt-BR</language>
        <link>https://segredo.invalid</link>
      </indexer>
      <indexer id="1337x" configured="true">
        <title>1337x</title>
        <language>en-US</language>
      </indexer>
    </indexers>`;
  const out = parseXml(xml);

  assert.deepEqual(out, [
    { id: brId, label: 'Comando & Torrents', language: 'pt-BR', isBr: true },
    { id: '1337x', label: '1337x', language: 'en-US', isBr: false },
  ]);
  assert.ok(out.every((item) => Object.keys(item).sort().join(',') === 'id,isBr,label,language'));
});

test('parseXml ignora ids inseguros e fallback deduplica os configurados', () => {
  assert.deepEqual(parseXml('<indexers><indexer id="../../env"><title>X</title></indexer></indexers>'), []);
  const out = fallback();
  assert.equal(new Set(out.map((item) => item.id)).size, out.length);
  assert.ok(out.every((item) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id)));
});

test('parseXml decodifica entidades em atributos do catálogo', () => {
  const items = parseXml(`
    <indexers>
      <indexer id="filmes" name="HD &amp; Filmes &#8211; &quot;Oficial&quot;" language="pt-BR"></indexer>
    </indexers>
  `);
  assert.equal(items[0].label, 'HD & Filmes – "Oficial"');
});

test('parseXml preserva entidade inválida e não decodifica duas vezes', () => {
  const items = parseXml(`
    <indexers>
      <indexer id="seguro" name="A &#x2FFFFD; &#38;amp; B&nbsp;C"></indexer>
    </indexers>
  `);
  assert.equal(items[0].label, 'A &#x2FFFFD; &amp; B C');
});

test('não medido → source fallback (Jackett morto com .env cheio não conta como live)', async () => {
  resetCatalogCache();
  const saved = { apiKey: config.jackett.apiKey, url: config.jackett.url };
  const realFetch = globalThis.fetch;
  config.jackett.apiKey = 'chave-teste-catalog';
  config.jackett.url = 'http://jackett.invalid';
  // Rede falha → fallback do .env; IDs presentes NÃO são medição.
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  try {
    const list = await load();
    assert.equal(list.source, 'fallback', 'falha de rede = fallback, não live');
    assert.ok(list.length > 0, 'fallback ainda traz IDs do .env');
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.url = saved.url;
    resetCatalogCache();
  }
});

test('API Jackett OK → source live (vazio = medido morto)', async () => {
  resetCatalogCache();
  const saved = { apiKey: config.jackett.apiKey, url: config.jackett.url };
  const realFetch = globalThis.fetch;
  config.jackett.apiKey = 'chave-teste-catalog';
  config.jackett.url = 'http://jackett.test';
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => '<indexers></indexers>',
  })) as unknown as typeof fetch;
  try {
    const list = await load();
    assert.equal(list.source, 'live');
    assert.equal(list.length, 0, 'XML vazio é medição vazia, não fallback');
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.url = saved.url;
    resetCatalogCache();
  }
});
