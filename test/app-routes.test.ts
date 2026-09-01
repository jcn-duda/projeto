import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Persistência desligada ANTES dos requires: o app real abre o módulo de
// cache e o data/cache.db do repo não pode ser tocado pelos testes.
process.env.CACHE_PERSIST = 'false';

import express from 'express';
import { createApp, asyncRoute } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { BlockedError, WorkPickError, EpisodePickError, NoVideoError, DubLieError } from '../src/debrid/common.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as releaseIndex from '../src/utils/release-index.js';
import type { DebridAdapter } from '../types/domain.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
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
  keyUrl: null as unknown as string,
  checkCached: async () => new Set<string>(),
  resolveLink: async () => 'https://fake.test/dl/video.mp4',
} as DebridAdapter;

function hmacSig(secret: any, payload: any) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

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
  // A allowlist casa pelo path: o `?v=` não precisa constar dela.
  const asset = await server.request('GET', '/configure.css?v=0000000000');
  assert.equal(asset.status, 200);
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
    // null não distingue "sem vídeo" de "ainda baixando": o texto é honesto
    // sobre a dúvida, e nada entra no banco de magnets (teste abaixo).
    assert.equal(semVideo.status, 404);
    assert.equal(semVideo.text, 'o torrent ainda está baixando no debrid');
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

test('/resolve devolve 404 quando pickFile não identifica episódio no pack', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const sig = hmacSig('fake-key', `${HASH}?s=1&e=5`);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new EpisodePickError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${HASH}?s=1&e=5&sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'este episódio não foi encontrado no pack');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: EpisodePickError com evidência grava miss no índice da obra', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashMiss = 'e'.repeat(40);
  // A dica carrega o `i` (imdbId) — é ele que permite gravar a evidência no
  // índice da obra, escopada ao episódio pedido.
  const hint = JSON.stringify({ n: ['True Detective'], y: 2014, i: 'tt7700009' });
  const sig = hmacSig('fake-key', `${hashMiss}?s=1&e=5&w=${hint}`);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => {
      throw new EpisodePickError({
        wantedSeason: 1,
        wantedEpisode: 5,
        declaredSeasons: [1],
        declaredEpisodes: [7],
        sample: 'True.Detective.S01E07.1080p.WEB.mkv',
      });
    };
    const res = await server.request('GET', `/${cfg}/resolve/${hashMiss}?s=1&e=5&w=${encodeURIComponent(hint)}&sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'este episódio não foi encontrado no pack');
    assert.equal(
      releaseIndex.isMissing('tt7700009', { season: 1, episode: 5 }, hashMiss),
      true,
      'a prova "este hash não serve este episódio" fica no índice',
    );
    // Prova fina: o mesmo hash continua valendo para os outros episódios.
    assert.equal(releaseIndex.isMissing('tt7700009', { season: 1, episode: 7 }, hashMiss), false);
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

// Banco de magnets no /resolve: só a falha DETERMINÍSTICA (NoVideoError) grava
// bad; null (transitório), pick falho e erro de rede não condenam o hash.
// Cada caso usa hash próprio para não contaminar o estado entre testes.
test('/resolve: null NÃO grava bad no banco de magnets', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashNull = 'a'.repeat(40);
  const sig = hmacSig('fake-key', hashNull);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => null;
    const res = await server.request('GET', `/${cfg}/resolve/${hashNull}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(
      magnetdb.isBad('fakebrid', 'fake-key', hashNull),
      false,
      'null é transitório na maioria dos adaptadores — gravar era blacklists de torrent bom',
    );
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: NoVideoError grava bad e devolve 404 honesto', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashBad = 'b'.repeat(40);
  const sig = hmacSig('fake-key', hashBad);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new NoVideoError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${hashBad}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'nenhum arquivo de vídeo no torrent');
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashBad), true, 'listagem com arquivos e nenhum vídeo é prova');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: WorkPickError e EpisodePickError não gravam nada', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashWork = 'c'.repeat(40);
  const hashEp = 'd'.repeat(40);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new WorkPickError(); };
    await server.request('GET', `/${cfg}/resolve/${hashWork}?sig=${hmacSig('fake-key', hashWork)}`);
    FAKE_ADAPTER.resolveLink = async () => { throw new EpisodePickError(); };
    await server.request('GET', `/${cfg}/resolve/${hashEp}?s=1&e=2&sig=${hmacSig('fake-key', `${hashEp}?s=1&e=2`)}`);
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashWork), false, 'o pack pode servir outra obra');
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashEp), false, 'o pack pode servir outro episódio');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: link resolveu grava alive no banco de magnets', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashOk = '1'.repeat(40);
  const sig = hmacSig('fake-key', hashOk);

  const res = await server.request('GET', `/${cfg}/resolve/${hashOk}?sig=${sig}`);
  assert.equal(res.status, 302);
  assert.equal(magnetdb.isAlive('fakebrid', 'fake-key', hashOk), true, 'play resolvido é evidência de vivo + instantâneo');
});

test('/resolve: MAGNET_DB=false desliga a gravação', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashOff = '2'.repeat(40);
  const sig = hmacSig('fake-key', hashOff);
  const originalEnabled = config.magnetDb.enabled;
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    config.magnetDb.enabled = false;
    FAKE_ADAPTER.resolveLink = async () => { throw new NoVideoError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${hashOff}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashOff), false, 'kill-switch desliga o banco inteiro');
  } finally {
    config.magnetDb.enabled = originalEnabled;
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

test('asyncRoute intercepta rejeição assíncrona, responde 500 e não derruba o processo (Tarefa 2.7)', async () => {
  const miniApp = express();
  // Registra uma rota async que falha com rejeição proposital
  miniApp.get('/test-async-crash', asyncRoute(async () => {
    throw new Error('Falha assíncrona simulada proposital');
  }));

  const testSrv = await createTestServer(miniApp);
  try {
    const res = await testSrv.request('GET', '/test-async-crash');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal_error' });
  } finally {
    await testSrv.close();
  }
});

test('/metrics.json e /debrid-status.json passam pelo diagnosticGate e devolvem 429 sob concorrência (Tarefa 2.6)', async () => {
  config.jackett.testToken = 'tok-diagnostico-gate';
  // Cria uma instância isolada para ter seu próprio gate
  const isolatedApp = createApp().app;
  const isolatedSrv = await createTestServer(isolatedApp);

  try {
    let releaseHold: (() => void) | null = null;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    await withMockFetch([], async () => {
      // Fazemos o debrid accountStatus segurar o assento do gate
      const originalAccountStatus = debrid.accountStatus;
      try {
        debrid.accountStatus = (async () => {
          await holdPromise;
          return { ok: true, service: 'alldebrid', label: 'AllDebrid', supported: true, warn: false, warnAt: 800, warnAtUnit: 'magnets', magnets: 10 };
        }) as any;

        // Dispara uma chamada ao /debrid-status.json que segura a vaga
        const inFlightReq = isolatedSrv.request('GET', '/debrid-status.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-gate' },
        });

        // Aguarda brevemente para garantir que inFlightReq adquiriu a vaga no gate
        await new Promise((r) => setTimeout(r, 20));

        // Segunda chamada concorrente ao /metrics.json deve receber 429 pelo gate ocupado
        const metricsRes = await isolatedSrv.request('GET', '/metrics.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-gate' },
        });
        assert.equal(metricsRes.status, 429);
        assert.match(metricsRes.json.error, /teste em andamento|limite de testes/i);

        // Terceira chamada concorrente ao /debrid-status.json deve também receber 429
        const debridRes = await isolatedSrv.request('GET', '/debrid-status.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-gate' },
        });
        assert.equal(debridRes.status, 429);
        assert.equal(debridRes.json.ok, false);
        assert.match(debridRes.json.error, /teste em andamento|limite de testes/i);

        // Libera a requisição inicial
        releaseHold?.();
        const firstRes = await inFlightReq;
        assert.equal(firstRes.status, 200);
      } finally {
        debrid.accountStatus = originalAccountStatus;
      }
    });
  } finally {
    config.jackett.testToken = '';
    await isolatedSrv.close();
  }
});

test('/debrid-status.json: debrid pendurado solta o assento no prazo e a monitoração segue viva (race do gate)', async () => {
  config.jackett.testToken = 'tok-diagnostico-race';
  const originalTimeout = config.debrid.dashboardAccountTimeoutMs;
  // Prazo curto: o teste não pode esperar os 3s de produção.
  config.debrid.dashboardAccountTimeoutMs = 80;
  const isolatedApp = createApp().app;
  const isolatedSrv = await createTestServer(isolatedApp);
  try {
    await withMockFetch([], async () => {
      const originalAccountStatus = debrid.accountStatus;
      try {
        // Nunca resolve: sem o race, o assento ficaria preso até o teto do fetch.
        debrid.accountStatus = (() => new Promise(() => {})) as any;
        const res = await isolatedSrv.request('GET', '/debrid-status.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-race' },
        });
        assert.equal(res.status, 200, 'o diagnóstico sai mesmo com o debrid pendurado');
        assert.equal(res.json.reason, 'timeout');

        // O finally liberou o assento: a próxima monitoração não leva 429.
        const metricsRes = await isolatedSrv.request('GET', '/metrics.json', {
          headers: { 'X-Indexer-Test-Token': 'tok-diagnostico-race' },
        });
        assert.equal(metricsRes.status, 200);
      } finally {
        debrid.accountStatus = originalAccountStatus;
      }
    });
  } finally {
    config.debrid.dashboardAccountTimeoutMs = originalTimeout;
    config.jackett.testToken = '';
    await isolatedSrv.close();
  }
});

test('/resolve: BlockedError devolve 451 legal sem gravar bad ou alive', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashBlocked = '3'.repeat(40);
  const sig = hmacSig('fake-key', hashBlocked);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  // A lista pronta é a única "prova" que sobrevive quando o bloqueio só
  // aparece no play: sem invalidar o namespace, o card [RD⚡] morto
  // continuaria sendo servido até o fim do TTL.
  cache.set('streams:v9:teste-bloqueio-451', { streams: [{ name: 'x', infoHash: hashBlocked }] }, 900);
  assert.ok(cache.get('streams:v9:teste-bloqueio-451'), 'precondição: entrada de streams existe');

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new BlockedError('HTTP 451 — infringing_file'); };
    const res = await server.request('GET', `/${cfg}/resolve/${hashBlocked}?sig=${sig}`);
    assert.equal(res.status, 451);
    assert.equal(res.text, 'o debrid bloqueou este conteúdo por motivo legal');
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashBlocked), false, '451 não prova ausência de vídeo');
    assert.equal(magnetdb.isAlive('fakebrid', 'fake-key', hashBlocked), false, '451 nunca é play resolvido');
    assert.equal(cache.get('streams:v9:teste-bloqueio-451'), null, 'o play bloqueado invalidou a lista pronta');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('router do protocolo preserva CORS e responde preflight sem chegar à busca', async () => {
  const manifest = await server.request('GET', '/manifest.json');
  assert.equal(manifest.headers.get('access-control-allow-origin'), '*');

  const preflight = await server.request('OPTIONS', '/stream/movie/tt1254207.json', {
    headers: { 'Access-Control-Request-Headers': 'X-Stremio-Test' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(String(preflight.headers.get('access-control-allow-methods')), /GET/);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'X-Stremio-Test');
});

test('rotas globais não caem sob o overlay', async () => {
  const manifest = await server.request('GET', '/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.id, config.addonId);

  // Se o decode do overlay viesse antes desta rota, "resolve" seria tratado
  // como config inválida e responderia 404, não a validação do infoHash.
  const resolve = await server.request('GET', '/resolve/nao-eh-hash');
  assert.equal(resolve.status, 400);
  assert.equal(resolve.text, 'infoHash inválido');
});

test('segmento inválido não vira overlay válido', async () => {
  const res = await server.request('GET', '/nao-e-config/manifest.json');
  assert.equal(res.status, 404);
});

test('overlay válido preserva manifest e resolve configurados', async () => {
  const userConfig = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const manifest = await server.request('GET', `/${userConfig}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.id, config.addonId);

  const resolve = await server.request('GET', `/${userConfig}/resolve/nao-eh-hash`);
  assert.equal(resolve.status, 400);
  assert.equal(resolve.text, 'infoHash inválido');
});

test('/resolve: DubLieError destrava a proteção durável da conta/adapter do play', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashLie = '4'.repeat(40);
  const account = accountScope('fake-key');
  const markerKey = `${prefix('adprot')}fakebrid:${account}:${hashLie}`;
  const sig = hmacSig('fake-key', hashLie);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    // Pré-condição: registro durável retido (o que o autofetch do AllDebrid
    // deixaria). A rota destrava pelo adapter/conta EFETIVOS do play — aqui,
    // o adaptador fake registrado no registry real.
    cache.set(markerKey, { acceptedAt: Date.now(), readyAt: null }, 3600);
    assert.ok(cache.peek(markerKey), 'precondição: retenção durável de pé');

    FAKE_ADAPTER.resolveLink = async () => {
      throw new DubLieError({ videoCount: 1, matchedGroup: 'WEB', sample: 'Movie.2024.1080p.WEB.mkv' });
    };
    const res = await server.request('GET', `/${cfg}/resolve/${hashLie}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'o torrent anunciado como dublado contém conteúdo em inglês');
    assert.equal(cache.get(markerKey), null, 'a prova de release EN destrava a retenção no play');
    assert.equal(magnetdb.isLie('fakebrid', 'fake-key', hashLie), true, 'a mentira também vai para o banco de magnets');

    // Sem registro, a rota segue respondendo igual (idempotente: nada a limpar).
    const res2 = await server.request('GET', `/${cfg}/resolve/${hashLie}?sig=${sig}`);
    assert.equal(res2.status, 404);
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
    cache.forget(markerKey);
  }
});
