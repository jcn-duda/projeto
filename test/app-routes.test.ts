import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Persistência desligada ANTES dos requires: o app real abre o módulo de
// cache e o data/cache.db do repo não pode ser tocado pelos testes.
process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { createTestServer, encodeConfig, withMockFetch, fakeResponse } from './e2e/e2e-harness.js';

let server: any;
const saved: Record<string, string> = {};

before(async () => {
  // O debrid e o token de diagnóstico efetivos vêm do .env do operador; os
  // testes decidem tudo pelo segmento de config, então o ambiente precisa
  // nascer neutro (e voltar ao que era no after).
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.testToken = config.jackett.testToken;
  saved.jackettApiKey = config.jackett.apiKey;
  saved.publicUrl = config.debrid.publicUrl;
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.jackett.testToken = '';
  // O mock intercepta o fetch, mas sem chave o jackett.search aborta antes
  // de perguntar ("JACKETT_API_KEY não configurada").
  config.jackett.apiKey = 'test-jackett-key';
  // O manifest só aponta para /logo.png quando há PUBLIC_URL; sem ela cai no
  // logo genérico do Stremio. Fixar aqui tira o teste da dependência do .env.
  config.debrid.publicUrl = 'https://addon.teste';

  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.debrid.service = saved.debridService;
  config.debrid.apiKey = saved.debridApiKey;
  config.debrid.resolveSecret = saved.resolveSecret;
  config.jackett.testToken = saved.testToken;
  config.jackett.apiKey = saved.jackettApiKey;
  config.debrid.publicUrl = saved.publicUrl;
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

test('páginas referenciam assets com ?v=<hash> e a rota ignora a query', async () => {
  // O acoplamento HTML↔módulos anda nos dois sentidos (o inline chama funções
  // dos módulos; os módulos buscam IDs do HTML): sem o versionamento por hash,
  // um deploy emparelharia HTML novo com módulo velho do cache do browser.
  // As asserções casam o ATRIBUTO INTEIRO, com a aspa de fechamento. A primeira
  // versão parava em `\?v=[0-9a-f]{10}` e passava verde com o HTML malformado
  // que a substituição gerava (`href="/configure.css?v=abc""`, atributo espúrio
  // `"` em cada tag) — regex frouxa demais para distinguir os dois casos.
  const configure = await server.request('GET', '/configure');
  assert.equal(configure.status, 200);
  assert.match(configure.text, /href="\/configure\.css\?v=[0-9a-f]{10}"[^"]/);
  assert.match(configure.text, /src="\/configure-app\.js\?v=[0-9a-f]{10}"[^"]/);
  assert.doesNotMatch(configure.text, /\?v=[0-9a-f]{10}""/);
  const dashboard = await server.request('GET', '/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /src="\/dashboard-core\.js\?v=[0-9a-f]{10}"[^"]/);
  assert.doesNotMatch(dashboard.text, /\?v=[0-9a-f]{10}""/);
  // Paridade HTML ↔ allowlist fechada: TODO asset local referenciado pelas
  // páginas precisa ter rota. Isso pega módulo novo copiado para dist/ mas
  // esquecido em PAGE_ASSETS (404 que derrubaria o boot inteiro).
  const assetUrls = [configure.text, dashboard.text]
    .flatMap((html) => [...html.matchAll(/(?:src|href)="(\/(?:configure|dashboard)[-\w]*\.(?:css|js)\?v=[0-9a-f]{10})"/g)])
    .map((match) => match[1]);
  assert.ok(assetUrls.some((url) => url.startsWith('/dashboard-harvest-debrid.js?v=')));
  for (const url of assetUrls) {
    const asset = await server.request('GET', url);
    assert.equal(asset.status, 200, `asset referenciado sem rota: ${url}`);
  }
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
    const busca = (maxResults: any) =>
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

test('Caddyfile e entrypoint não fecham /configure com basic_auth', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const near = path.join(here, '..');
  const root = fs.existsSync(path.join(near, 'Caddyfile')) ? near : path.join(here, '..', '..');
  const caddy = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
  const entry = fs.readFileSync(path.join(root, 'scripts', 'entrypoint.sh'), 'utf8');
  assert.doesNotMatch(caddy, /basic_auth/);
  assert.doesNotMatch(caddy, /configure-auth/);
  assert.doesNotMatch(entry, /CONFIGURE_PAGE_PASSWORD/);
  assert.doesNotMatch(entry, /basic_auth/);
});
