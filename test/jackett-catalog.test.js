const { test } = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const { parseXml, fallback } = require('../src/providers/jackett-catalog');

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
