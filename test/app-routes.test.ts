import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Persistência desligada ANTES dos requires: o app real abre o módulo de
// cache e o data/cache.db do repo não pode ser tocado pelos testes.
process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { WorkPickError } from '../src/debrid/common.js';
import * as cache from '../src/utils/cache.js';
import { createTestServer, encodeConfig, withMockFetch, fakeResponse } from './e2e/e2e-harness.js';

const HASH = 'f'.repeat(40);

// Adaptador fake registrado no registry real: os testes do /resolve exercitam
// o caminho completo (assinatura → current() → resolveLink) sem conhecer um
// serviço de verdade. Entra no before e sai no after.
const FAKE_ADAPTER = {
  id: 'fakebrid',
  label: 'FakeBridge',
  short: 'FK',
  cacheCheck: true,
  keyUrl: null,
  checkCached: async () => new Set(),
  resolveLink: async () => 'https://fake.test/dl/video.mp4',
};

function hmacSig(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

let server;
const saved = {};

before(async () => {
  // O debrid e o token de diagnóstico efetivos vêm do .env do operador; os
  // testes decidem tudo pelo segmento de config, então o ambiente precisa
  // nascer neutro (e voltar ao que era no after).
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.testToken = config.jackett.testToken;
  saved.jackettApiKey = config.jackett.apiKey;
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.jackett.testToken = '';
  // O mock intercepta o fetch, mas sem chave o jackett.search aborta antes
  // de perguntar ("JACKETT_API_KEY não configurada").
  config.jackett.apiKey = 'test-jackett-key';

  debrid.BY_ID.set(FAKE_ADAPTER.id, FAKE_ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(FAKE_ADAPTER.id);
  config.debrid.service = saved.debridService;
  config.debrid.apiKey = saved.debridApiKey;
  config.debrid.resolveSecret = saved.resolveSecret;
  config.jackett.testToken = saved.testToken;
  config.jackett.apiKey = saved.jackettApiKey;
});

test('/manifest.json responde sem segmento de config', async () => {
  const res = await server.request('GET', '/manifest.json');
  assert.equal(res.status, 200);
  assert.equal(res.json.id, config.addonId);
  assert.deepEqual(res.json.resources, ['stream']);
  assert.equal(res.json.behaviorHints.configurable, true);
});

test('logo do manifest é PNG e a rota serve o arquivo', async () => {
  // O cliente do Stremio desenha engrenagem no lugar de SVG na lista de
  // addons; voltar o manifest pro /logo.svg apaga o ícone sem quebrar nada
  // que um teste de rota perceba.
  const res = await server.request('GET', '/manifest.json');
  assert.match(res.json.logo, /\/logo\.png$/);
  const png = await server.request('GET', '/logo.png');
  assert.equal(png.status, 200);
});

test('segmento de 1 segmento que não é config vira 404, não manifest', async () => {
  // Sem o 404 do decode, qualquer caminho de um segmento serviria o manifest
  // com a config do .env — inclusive erro de digitação no install URL.
  const res = await server.request('GET', '/nao-e-config/manifest.json');
  assert.equal(res.status, 404);
});

test('segmento base64url válido serve o manifest e o overlay chega na busca', async () => {
  const segment = encodeConfig({ m: 3 });
  const res = await server.request('GET', `/${segment}/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(res.json.id, config.addonId);

  // Prova de que o overlay do usuário é usado de verdade: o MESMO lote de
  // resultados volta com tamanhos diferentes conforme o `m` do segmento.
  // O endpoint do Jackett devolve JSON (mapResults lê Results/Title/...), e
  // o segmento não força lista de indexers: ji vazio faria search() devolver
  // [] de propósito (sem indexers escolhidos não há o que consultar).
  const items = Array.from({ length: 6 }, (_, i) => ({
    Title: 'Test Title 2024 1080p',
    InfoHash: (i + 1).toString(16).padStart(40, '0'),
    MagnetUri: `magnet:?xt=urn:btih:${(i + 1).toString(16).padStart(40, '0')}`,
    Seeders: 100 + i,
    Size: 1024 * 1024 * 700,
    Tracker: 'mockindexer',
  }));
  const routes = [
    { match: '/api/v2.0/indexers/', handler: () => fakeResponse({ Results: items }) },
  ];

  await withMockFetch(routes, async () => {
    const busca = (maxResults) =>
      server.request(
        'GET',
        `/${encodeConfig({
          p: ['jackett'],
          m: maxResults,
          q: ['2160p', '1080p', '720p', '480p'],
          q1: 10,
        })}/stream/movie/tt1254207.json`,
      );

    const comDois = await busca(2);
    assert.equal(comDois.status, 200);
    assert.equal(comDois.json.streams.length, 2, 'maxResults do usuário corta a lista');

    // A chave de busca pode incluir a config; limpar garante que a segunda
    // medição não pegou carona no resultado da primeira.
    cache.clear();
    const comQuatro = await busca(4);
    assert.equal(comQuatro.status, 200);
    assert.equal(comQuatro.json.streams.length, 4, 'o limite acompanha o segmento');
  });
});

test('/resolve rejeita hash malformado com 400', async () => {
  const res = await server.request('GET', '/resolve/nao-eh-hash');
  assert.equal(res.status, 400);
  assert.equal(res.text, 'infoHash inválido');
});

test('/resolve com debrid ativo exige assinatura: sem sig ou sig errada dá 403', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });

  const semSig = await server.request('GET', `/${cfg}/resolve/${HASH}`);
  assert.equal(semSig.status, 403);
  assert.equal(semSig.text, 'assinatura inválida');

  const sigErrada = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${'0'.repeat(64)}`);
  assert.equal(sigErrada.status, 403);
});

test('/resolve com sig válido redireciona 302 para o link do debrid', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  // Sem RESOLVE_SECRET o segredo efetivo é a própria chave do segmento.
  const sig = hmacSig('fake-key', HASH);

  const res = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${sig}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://fake.test/dl/video.mp4');
});

test('/resolve cobre temporada/episódio na assinatura', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const ep = '?s=1&e=2';

  // Sig do hash puro não vale para o pedido com episódio — e vice-versa.
  const sigSemEp = hmacSig('fake-key', HASH);
  const errada = await server.request('GET', `/${cfg}/resolve/${HASH}${ep}&sig=${sigSemEp}`);
  assert.equal(errada.status, 403);

  const sigComEp = hmacSig('fake-key', `${HASH}${ep}`);
  const certa = await server.request('GET', `/${cfg}/resolve/${HASH}${ep}&sig=${sigComEp}`);
  assert.equal(certa.status, 302);
});

test('/resolve devolve 502 quando o debrid lança e 404 quando não há vídeo', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const sig = hmacSig('fake-key', HASH);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => {
      throw new Error('serviço fora do ar');
    };
    const falha = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${sig}`);
    assert.equal(falha.status, 502);
    assert.equal(falha.text, 'falha ao resolver no debrid');

    FAKE_ADAPTER.resolveLink = async () => null;
    const semVideo = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${sig}`);
    assert.equal(semVideo.status, 404);
    assert.equal(semVideo.text, 'nenhum arquivo de vídeo no torrent');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve devolve 404 com mensagem de pack quando pickFile lança WorkPickError', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hint = JSON.stringify({ n: ['O Poderoso Chefão', 'The Godfather'], y: 1972, p: 1 });
  // A assinatura cobre a dica CRUA (não URL-encoded).
  const sig = hmacSig('fake-key', `${HASH}&w=${hint}`);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new WorkPickError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${HASH}?w=${encodeURIComponent(hint)}&sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'não foi possível identificar este filme dentro do pack');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/defaults.json nunca expõe a chave de debrid do operador', async () => {
  // O jackettCatalog.load() da rota faz fetch; o mock garante que nenhum
  // pedido saia do processo.
  await withMockFetch([{ match: '/api/v2.0/indexers', handler: () => fakeResponse([]) }], async () => {
    config.debrid.apiKey = 'segredo-do-operador';
    try {
      const res = await server.request('GET', '/defaults.json');
      assert.equal(res.status, 200);
      assert.equal(res.json.debridApiKey, '', 'a chave volta sempre vazia');
      assert.ok(!res.text.includes('segredo-do-operador'), 'a chave não vaza em nenhum campo');
      assert.ok(Array.isArray(res.json.services), 'o seletor de serviços vem do registry');
      assert.equal(res.json.sealKeyEnabled, false, 'sem RESOLVE_SECRET o selo fica desligado');
    } finally {
      config.debrid.apiKey = '';
    }
  });
});

test('/seal-config devolve 503 sem RESOLVE_SECRET', async () => {
  const res = await server.request('POST', '/seal-config', {
    body: encodeConfig({ m: 2 }),
  });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /RESOLVE_SECRET/);
});

test('/metrics.json: 503 sem token configurado, 401 com token errado, 200 com o certo', async () => {
  const semToken = await server.request('GET', '/metrics.json');
  assert.equal(semToken.status, 503);

  config.jackett.testToken = 'tok-diagnostico';
  try {
    const errado = await server.request('GET', '/metrics.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    });
    assert.equal(errado.status, 401);

    const semHeader = await server.request('GET', '/metrics.json');
    assert.equal(semHeader.status, 401);

    const certo = await server.request('GET', '/metrics.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-diagnostico' },
    });
    assert.equal(certo.status, 200);
    assert.equal(typeof certo.json.counters, 'object');
    assert.equal(typeof certo.json.cache.entries, 'number');
  } finally {
    config.jackett.testToken = '';
  }
});
