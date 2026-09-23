import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stampRelativeImports } from '../src/routes/client-imports.js';

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

test('sem PUBLIC_URL o logo do manifest usa o origin da requisição', async () => {
  // O logo genérico do Stremio aparecia como peça de quebra-cabeça em toda
  // instalação local (localhost/IP da LAN sem PUBLIC_URL).
  const savedUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = '';
  const local = await createTestServer(createApp().app);
  try {
    const res = await local.request('GET', '/manifest.json');
    assert.match(res.json.logo, /^http:\/\/[^/]+\/logo\.png$/);
    assert.doesNotMatch(res.json.logo, /stremio\.com/);
  } finally {
    await local.close();
    config.debrid.publicUrl = savedUrl;
  }
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
  assert.match(configure.text, /src="\/client\/configure\/entry\.js\?v=[0-9a-f]{10}"[^"]/);
  assert.doesNotMatch(configure.text, /\?v=[0-9a-f]{10}""/);
  const painel = await server.request('GET', '/painel');
  assert.equal(painel.status, 200);
  assert.match(painel.text, /href="\/painel\.css\?v=[0-9a-f]{10}"[^"]/);
  assert.match(painel.text, /src="\/client\/painel\/entry\.js\?v=[0-9a-f]{10}"[^"]/);
  assert.doesNotMatch(painel.text, /\?v=[0-9a-f]{10}""/);
  // Paridade HTML ↔ allowlist fechada: TODO asset local referenciado pelas
  // páginas precisa ter rota. Os filhos ESM (importados pelo entry) não levam
  // ?v= no HTML; a cobertura deles é feita por allowlist no painel-esm.test.
  const assetUrls = [configure.text, painel.text]
    .flatMap((html) => [...html.matchAll(/(?:src|href)="(\/(?:(?:configure|painel)[-\w]*\.css|dashboard-tokens\.css|client\/(?:configure|painel)\/entry\.js)\?v=[0-9a-f]{10})"/g)])
    .map((match) => match[1]);
  assert.ok(assetUrls.some((url) => url.startsWith('/client/painel/entry.js?v=')));
  assert.ok(assetUrls.some((url) => url.startsWith('/client/configure/entry.js?v=')));
  for (const url of assetUrls) {
    const asset = await server.request('GET', url);
    assert.equal(asset.status, 200, `asset referenciado sem rota: ${url}`);
  }
});

test('contrato de cache: HTML no-store e asset imutável só com o fingerprint corrente', async () => {
  // O HTML precisa ser sempre fresco: um HTML velho no cache do browser
  // chamaria URLs ?v= antigas e prenderia o boot numa versão que o deploy já
  // não emparelha. `no-store` fecha memória e disco.
  for (const page of ['/configure', '/painel']) {
    const res = await server.request('GET', page);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${page} deve ser no-store`);
  }
  // A rota casa pelo path e aceita o entry sem query: o mesmo caminho sem o
  // hash aponta para conteúdo mutável, então `immutable` ali congelaria por um
  // ano. Só o ?v= CORRENTE ganha o cache longo.
  const painel = await server.request('GET', '/painel');
  const versioned = painel.text.match(/(\/client\/painel\/entry\.js\?v=[0-9a-f]{10})/);
  assert.ok(versioned, 'o HTML deve versionar o entry com o fingerprint');
  assert.ok(versioned[1]);
  const asset = await server.request('GET', versioned[1]);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const bare = await server.request('GET', '/client/painel/entry.js');
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get('cache-control'), 'no-cache');
  const wrong = await server.request('GET', '/client/painel/entry.js?v=0000000000');
  assert.equal(wrong.status, 200);
  assert.doesNotMatch(String(wrong.headers.get('cache-control')), /immutable/);

  // Cliente ESM de /painel: os filhos (importados sem ?v=) saem no-cache com
  // ETag de CONTEÚDO (hash do byte) e revalidam por 304 quando o módulo não mudou.
  const painelChild = await server.request('GET', '/client/painel/fmt.js');
  assert.equal(painelChild.status, 200);
  assert.equal(painelChild.headers.get('cache-control'), 'no-cache');
  const painelEtag = String(painelChild.headers.get('etag'));
  // O corpo SERVIDO é o do disco com os imports relativos carimbados com o
  // fingerprint — sem isso a URL do filho seria a mesma entre deploys e um
  // cache no caminho (a Cloudflare reescrevia nosso `no-cache` para 4h) serviria
  // módulo velho ao lado de um entry novo. O ETag acompanha o corpo servido,
  // não o arquivo em disco: um ETag do disco confirmaria um 304 sobre conteúdo
  // que não é o que sai na resposta.
  const fingerprint = versioned[1].split('?v=')[1];
  const servedBody = stampRelativeImports(
    fs.readFileSync(new URL('../src/public/client/painel/fmt.js', import.meta.url), 'utf8'),
    fingerprint,
  );
  assert.match(painelChild.text, /from '\.\/core\.js\?v=[0-9a-f]{10}'/, 'import do filho carimbado');
  const expectedEtag = '"' + createHash('sha256')
    .update(Buffer.from(servedBody, 'utf8'))
    .digest('hex').slice(0, 32) + '"';
  assert.equal(painelEtag, expectedEtag, 'ETag é o hash do corpo SERVIDO, não do arquivo em disco');
  assert.match(painelEtag, /^"[0-9a-f]{32}"$/);
  const otherChild = await server.request('GET', '/client/painel/core.js');
  assert.notEqual(String(otherChild.headers.get('etag')), painelEtag, 'módulos diferentes → ETags diferentes');
  const painelRevalidated = await server.request('GET', '/client/painel/fmt.js', { headers: { 'if-none-match': painelEtag } });
  assert.equal(painelRevalidated.status, 304);

  // O fingerprint precisa mudar quando a FORMA de servir muda, não só quando o
  // byte em disco muda: a URL promete o corpo SERVIDO. Sem isso, o dia em que o
  // carimbo entrou a mesma `?v=<hash>` passou a devolver conteúdo diferente, a
  // CDN ficou com metade dos módulos velhos e o painel abriu em branco com duas
  // instâncias do preact.
  // A suíte roda de dist/: a fonte .ts está um nível acima do que o .js vê.
  const publicSrc = ['../src/routes/public.ts', '../../src/routes/public.ts']
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(publicSrc, 'fonte de public.ts não encontrada a partir do teste');
  assert.match(
    fs.readFileSync(publicSrc, 'utf8'),
    /fingerprint\.update\('serving-pipeline-v\d+'\)/,
    'o fingerprint precisa incluir a versão do pipeline de entrega',
  );

  // Cliente ESM de /configure: o entry versionado é immutable; os filhos
  // (importados sem ?v=) saem no-cache e revalidam por ETag → 304 quando o
  // módulo não mudou. É o que pega deploy-skew sem congelar filho velho.
  const configure = await server.request('GET', '/configure');
  const entryUrl = configure.text.match(/(\/client\/configure\/entry\.js\?v=[0-9a-f]{10})/);
  assert.ok(entryUrl, 'o configure.html debe versionar o entry com o fingerprint');
  const entry = await server.request('GET', entryUrl![1]);
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const bareEntry = await server.request('GET', '/client/configure/entry.js');
  assert.equal(bareEntry.status, 200);
  assert.doesNotMatch(String(bareEntry.headers.get('cache-control')), /immutable/);
  assert.equal(bareEntry.headers.get('cache-control'), 'no-cache');
  const child = await server.request('GET', '/client/configure/init.js');
  assert.equal(child.status, 200);
  assert.equal(child.headers.get('cache-control'), 'no-cache');
  const etag = String(child.headers.get('etag'));
  assert.match(etag, /^"[0-9a-f]{32}"$/, 'filho do configure com ETag de conteúdo');
  const revalidated = await server.request('GET', '/client/configure/init.js', { headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304);
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
          d: 0,
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

test('atalhos legados do painel: /autofetch e /harvester redirecionam para a aba certa', async () => {
  const rootAf = await server.request('GET', '/autofetch');
  assert.equal(rootAf.status, 302);
  assert.equal(rootAf.headers.get('location'), '/painel#chupim');
  const rootHarv = await server.request('GET', '/harvester');
  assert.equal(rootHarv.status, 302);
  assert.equal(rootHarv.headers.get('location'), '/painel#colhedor');

  const segment = encodeConfig({ m: 3 });
  const cfgAf = await server.request('GET', `/${segment}/autofetch`);
  assert.equal(cfgAf.status, 302);
  assert.equal(cfgAf.headers.get('location'), `/${segment}/painel#chupim`);
  const cfgHarv = await server.request('GET', `/${segment}/harvester`);
  assert.equal(cfgHarv.status, 302);
  assert.equal(cfgHarv.headers.get('location'), `/${segment}/painel#colhedor`);
});

test('o dashboard legado saiu: /dashboard e /:userConfig/dashboard devolvem 404', async () => {
  const root = await server.request('GET', '/dashboard');
  assert.equal(root.status, 404);
  const segment = encodeConfig({ m: 3 });
  const cfg = await server.request('GET', `/${segment}/dashboard`);
  assert.equal(cfg.status, 404);
});