import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import { parseXml, fallback, load, resetCatalogCache, syncAutoIndexers } from '../src/providers/jackett-catalog.js';
import { loadNativeCatalog } from '../src/providers/catalog-native.js';
import { jackettServiceFlag } from '../src/routes/dashboard-status-helpers.js';
import { stubFetch } from './helpers/stub.js';

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
  // O rótulo do fallback nasce do id, e `-cardigann` é detalhe do card local:
  // o usuário lê "Hdrtorrent", não "Hdrtorrent Cardigann". O ID permanece.
  const cardigann = out.filter((item) => /-cardigann$/i.test(item.id));
  assert.ok(cardigann.length > 0, 'o .env de teste tem ao menos um card local');
  assert.ok(
    cardigann.every((item) => !/cardigann/i.test(item.label)),
    'sufixo de implementação não vaza para o rótulo',
  );
  assert.ok(
    cardigann.some((item) => item.id === 'hdrtorrent-cardigann' && item.label === 'Hdrtorrent'),
    'hdrtorrent-cardigann é rotulado Hdrtorrent',
  );
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
    assert.equal(list.filter((item) => !item.virtual).length, 0, 'XML vazio é medição vazia, não fallback');
    assert.equal(jackettServiceFlag(list), false, 'o card virtual do Mico não prova Jackett vivo');
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.url = saved.url;
    resetCatalogCache();
  }
});

test('fallback por falha de rede expira em 30s e o catálogo vivo volta (boot antes do Jackett)', async () => {
  // VPS 2026-09-18: o addon subiu antes do Jackett, o fallback do .env ficou 15
  // min em cache e a /configure escondeu o LimeTorrents (só existe no Jackett).
  resetCatalogCache();
  const saved = { apiKey: config.jackett.apiKey, url: config.jackett.url, ttl: config.jackett.catalogTtl };
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  let up = false;
  let calls = 0;
  Date.now = () => now;
  config.jackett.apiKey = 'chave-teste-catalog';
  config.jackett.url = 'http://jackett.test';
  config.jackett.catalogTtl = 900;
  globalThis.fetch = (async () => {
    calls += 1;
    if (!up) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, text: async () => '<indexers><indexer id="limetorrents" configured="true"><title>LimeTorrents</title><language>en-US</language></indexer></indexers>' };
  }) as unknown as typeof fetch;
  try {
    assert.equal((await load()).source, 'fallback');
    up = true;
    now += 10_000;
    assert.equal((await load()).source, 'fallback', 'dentro de 30s serve o fallback em cache');
    assert.equal(calls, 1);
    now += 25_000;
    const live = await load();
    assert.equal(live.source, 'live', 'passados 30s tenta o Jackett de novo');
    assert.ok(live.some((i) => i.id === 'limetorrents'));
    assert.equal(calls, 2);
    now += 60_000;
    await load();
    assert.equal(calls, 2, 'catálogo vivo segue o TTL cheio');
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.url = saved.url;
    config.jackett.catalogTtl = saved.ttl;
    resetCatalogCache();
  }
});

test('lista automática: sem JACKETT_INDEXERS o catálogo vivo vira a lista padrão, no lugar', async () => {
  resetCatalogCache();
  const saved = {
    apiKey: config.jackett.apiKey, url: config.jackett.url,
    auto: config.jackett.indexersAuto, indexers: [...config.jackett.indexers],
  };
  const realFetch = globalThis.fetch;
  const ref = config.jackett.indexers;
  config.jackett.apiKey = 'chave-teste-catalog';
  config.jackett.url = 'http://jackett.test';
  config.jackett.indexersAuto = true;
  ref.splice(0, ref.length);
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => '<indexers><indexer id="limetorrents" configured="true"><title>LimeTorrents</title></indexer><indexer id="yts" configured="true"><title>YTS</title></indexer></indexers>',
  })) as unknown as typeof fetch;
  try {
    await load();
    assert.deepEqual(config.jackett.indexers, ['limetorrents', 'yts'], 'indexer do Jackett entra sem .env');
    assert.equal(config.jackett.indexers, ref, 'mesma referência: quem já leu o array vê a lista nova');
    assert.equal(syncAutoIndexers([]), false, 'catálogo vazio não apaga a lista');
    assert.deepEqual(config.jackett.indexers, ['limetorrents', 'yts']);

    // .env explícito manda: o catálogo não mexe na lista.
    config.jackett.indexersAuto = false;
    ref.splice(0, ref.length, 'thepiratebay');
    assert.equal(syncAutoIndexers([{ id: 'yts', label: 'YTS', language: '', isBr: false }]), false);
    assert.deepEqual(config.jackett.indexers, ['thepiratebay']);
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.url = saved.url;
    config.jackett.indexersAuto = saved.auto;
    ref.splice(0, ref.length, ...saved.indexers);
    resetCatalogCache();
  }
});

// F4.4 — ponte do catálogo NATIVO (gateway, admin 8711). A ponte vive em
// `catalog-native.ts`; aqui o assunto é o shape que ela entrega (igual ao
// `load()` do TS) e a queda para o caminho de sempre quando o gateway não
// responde. Sem rede: fetch dublado (stubFetch).

test('ponte nativa: cards do gateway entram com o shape do load() do TS (status + source)', async () => {
  const saved = { url: config.streamStore.url, token: config.streamStore.token };
  config.streamStore.url = 'http://127.0.0.1:8711';
  config.streamStore.token = 'tok-catalog-native';
  let sent: { headers?: Record<string, string> } = {};
  const stub = stubFetch((url, options) => {
    sent = { headers: options?.headers as Record<string, string> };
    assert.match(url, /\/indexers\/catalog$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        cards: [
          { id: 'Bludv-Cardigann', label: 'BLUDV', language: 'pt-BR', isBr: true },
          { id: 'mico', label: 'Mico Leão Dublado', language: 'pt-BR', isBr: true, virtual: true },
        ],
        source: 'live',
      }),
    };
  });
  try {
    const list = await loadNativeCatalog();
    assert.ok(list, 'a ponte respondeu');
    assert.equal(list.source, 'live', 'o source vem do gateway, não do TS');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'bludv-cardigann', 'id normalizado como no TS');
    assert.ok('status' in list[0], 'decoração de status presente no shape');
    assert.equal(list[1].virtual, true, 'o virtual do Mico atravessa a ponte');
    assert.equal(sent.headers?.['x-indexer-test-token'], 'tok-catalog-native');
    assert.equal(jackettServiceFlag(list), true, 'catálogo vivo do gateway prova Jackett vivo');
  } finally {
    stub.restore();
    config.streamStore.url = saved.url;
    config.streamStore.token = saved.token;
  }
});

test('ponte nativa fora devolve null e o caminho TS segue como única fonte', async () => {
  resetCatalogCache();
  const saved = { apiKey: config.jackett.apiKey, url: config.jackett.url };
  const realFetch = globalThis.fetch;
  config.jackett.apiKey = '';
  // O dublê cobre a ponte E o TS no mesmo teste: ambos falham/fallback.
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  try {
    assert.equal(await loadNativeCatalog(), null, 'fail-open: null, não lançamento');
    const list = await load();
    assert.equal(list.source, 'fallback', 'sem a ponte o TS alimenta como sempre');
    assert.equal(jackettServiceFlag(list), 'naomedido', 'fallback do TS não vira "live" por causa da ponte');
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.apiKey = saved.apiKey;
    resetCatalogCache();
  }
});
