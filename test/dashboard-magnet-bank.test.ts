// Etapa 5 — superfície HTTP das ações do banco vivo no /dashboard-action.json
// (`magnet-bank-summary` / `magnet-bank-search`), do bloco `magnetBank` do
// /dashboard-status.json e do `fallbackServed` declarado NÃO MEDIDO por indexer.
// Fase 0.7 — o mesmo /dashboard-status.json expõe `metrics.native` (leitura das
// duas superfícies do gateway Rust) e o card I0 se declara NÃO MEDIDO.
//
// Sem rede: o catálogo de indexers é alimentado pelo fallback do .env (apiKey
// vazio) e a conta não é tocada. O banco vivo é aberto em MEMÓRIA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';
import { resetCatalogCache } from '../src/providers/jackett-catalog.js';
import { DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
import { pullNativeMetrics } from '../src/utils/native-metrics.js';
import { createTestServer } from './e2e/e2e-harness.js';

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-bank-'));
const TOKEN = 'tok-magnet-bank';
const HEX = (c: string, tail = '0') => c.repeat(39) + tail;
const H1 = HEX('a', '1');
const H2 = HEX('b', '2');
const H3 = HEX('c', '3');

let server: any;
const saved: Record<string, any> = {};

function seed() {
  bank.resetForTests();
  bank.open(FRESH_DIR(), { forceMemory: true });
  config.magnetBank.enabled = true;
  bank.captureItems([
    {
      title: 'Filme Um Dublado 1080p', infoHash: H1,
      magnet: `magnet:?xt=urn:btih:${H1}&dn=Filme%20Um`,
      size: 111, seeders: 9, isBr: true, dubbed: true, quality: '1080p',
    },
  ], 'nerdfilmes', { imdbId: 'tt111', season: null, episode: null });
  bank.captureItems([
    { title: 'Serie Dois S01E02 Dublada', infoHash: H2, magnet: `magnet:?xt=urn:btih:${H2}`, size: 222, seeders: 4 },
  ], 'bludv', { imdbId: 'tt222', season: 1, episode: 2 });
  bank.flushNow();
}

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.bankEnabled = config.magnetBank.enabled;
  saved.indexers = config.jackett.indexers;
  saved.ptBrIndexers = config.jackett.ptBrIndexers;
  saved.slowIndexers = config.jackett.slowIndexers;
  saved.apiKey = config.jackett.apiKey;

  config.jackett.testToken = TOKEN;
  seed();
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  bank.resetForTests();
  resetCatalogCache();
  config.jackett.testToken = saved.testToken;
  config.magnetBank.enabled = saved.bankEnabled;
  config.jackett.indexers = saved.indexers;
  config.jackett.ptBrIndexers = saved.ptBrIndexers;
  config.jackett.slowIndexers = saved.slowIndexers;
  config.jackett.apiKey = saved.apiKey;
});

function post(body: any) {
  return server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body,
  });
}

function get(query: string) {
  return server.request('GET', `/dashboard-status.json${query}`, {
    headers: { 'X-Indexer-Test-Token': TOKEN },
  });
}

/**
 * Dublê das superfícies `/metrics` do Rust (7000 sem token, 8710 com token).
 * Porta efêmera em loopback: o teste vê o corpo e o header que chegou de fato.
 */
function metricsStub(body: () => Record<string, number>, sink?: { headers?: http.IncomingHttpHeaders }) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (sink) sink.headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body()));
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => srv.close(() => done())),
      });
    });
  });
}

test('magnet-bank-summary é leitura e devolve totais/byIndexer sem confirm', () => {
  assert.ok(DASHBOARD_ACTIONS.has('magnet-bank-summary'));
  assert.equal(DESTRUCTIVE_ACTIONS.has('magnet-bank-summary'), false);
  return post({ action: 'magnet-bank-summary' }).then((res: any) => {
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.enabled, true);
    assert.equal(res.json.engine, 'memory');
    assert.equal(res.json.magnets, 2);
    assert.equal(res.json.sources, 2);
    assert.equal(res.json.works, 2);
    assert.ok(res.json.lastSeen > 0);
    assert.equal(res.json.byIndexer.length, 2);
    const byId = new Map<string, any>(res.json.byIndexer.map((row: any) => [row.indexer, row]));
    assert.equal(byId.get('bludv').hashes, 1);
    assert.equal(byId.get('nerdfilmes').hashes, 1);
    assert.equal(typeof res.json.queue, 'number');
    // Engine de memória (forceMemory): o teto e os despejos viajam no payload.
    assert.equal(res.json.memoryMax, config.magnetBank.memoryMax);
    assert.equal(res.json.memoryEvictions, 0);
  });
});

test('magnet-bank-search por hash devolve URI/fontes/obras sem credencial', async () => {
  assert.ok(DASHBOARD_ACTIONS.has('magnet-bank-search'));
  assert.equal(DESTRUCTIVE_ACTIONS.has('magnet-bank-search'), false, 'busca é read-only');

  const res = await post({ action: 'magnet-bank-search', query: H1.toUpperCase() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.mode, 'hash');
  assert.equal(res.json.returned, 1);
  const item = res.json.items[0];
  assert.equal(item.hash, H1);
  assert.match(item.uri, /dn=Filme/);
  assert.equal(item.isBr, true);
  assert.equal(item.dubbed, true);
  assert.equal(item.sources.length, 1);
  assert.equal(item.sources[0].indexer, 'nerdfilmes');
  assert.equal(item.works.length, 1);
  assert.equal(item.works[0].imdb, 'tt111');

  const raw = JSON.stringify(res.json);
  assert.ok(!raw.includes('accountScope'), 'sem digest de conta no payload');
  assert.ok(!raw.toLowerCase().includes('apikey'), 'sem credencial no payload');
});

test('magnet-bank-search por título, vazio, validação e teto', async () => {
  const titulo = await post({ action: 'magnet-bank-search', query: 'serie dois' });
  assert.equal(titulo.json.mode, 'title');
  assert.equal(titulo.json.matched, 1);
  assert.equal(titulo.json.items[0].hash, H2);

  const vazio = await post({ action: 'magnet-bank-search', query: '' });
  assert.equal(vazio.status, 200);
  assert.equal(vazio.json.mode, 'recent');
  assert.equal(vazio.json.matched, 2);

  const semQuery = await post({ action: 'magnet-bank-search' });
  assert.equal(semQuery.status, 200);
  assert.equal(semQuery.json.mode, 'recent', 'sem query cai nos recentes');

  const curta = await post({ action: 'magnet-bank-search', query: 'a' });
  assert.equal(curta.status, 400);
  assert.match(curta.json.error, /ao menos 2 caracteres/);

  const tipoErrado = await post({ action: 'magnet-bank-search', query: 123 });
  assert.equal(tipoErrado.status, 400);

  const limitada = await post({ action: 'magnet-bank-search', max: 9999 });
  assert.equal(limitada.json.limit, 100);
});

test('dashboard-status.json entrega o bloco magnetBank sem quebrar o magnetdb', async () => {
  const res = await get('?blocos=magnetBank');
  assert.equal(res.status, 200);
  assert.equal(res.json.magnetBank.magnets, 2);
  assert.equal(res.json.magnetBank.sources, 2);
  assert.equal(res.json.magnetBank.works, 2);
  assert.equal(res.json.magnetBank.engine, 'memory');
  assert.equal(res.json.magnetBank.byIndexer.length, 2);
  assert.equal(res.json.magnetBank.memoryMax, config.magnetBank.memoryMax, 'bloco expõe o teto da memória');
  assert.equal(res.json.magnetBank.memoryEvictions, 0);

  const ambos = await get('?blocos=magnetdb,magnetBank');
  assert.equal(ambos.status, 200);
  assert.ok(ambos.json.magnetdb, 'bloco magnetdb existente continua presente');
  assert.ok(ambos.json.magnetBank, 'magnetBank convive com o magnetdb');
});

test('magnet-bank-summary é memoizado e o flush derruba o memo', async () => {
  // Baseline conhecido: a ação passa pelo MESMO `status()` memoizado do bloco.
  seed();
  const antes = await post({ action: 'magnet-bank-summary' });
  assert.equal(antes.json.magnets, 2);

  bank.captureItems([
    { title: 'Extra Novo', infoHash: H3, magnet: `magnet:?xt=urn:btih:${H3}` },
  ], 'bludv', {});
  bank.flushNow();

  const depois = await post({ action: 'magnet-bank-summary' });
  assert.equal(depois.json.magnets, 3, 'a escrita efetiva invalida o memo do status');

  // Duas leituras seguidas sem escrita devolvem a MESMA foto.
  const a = await post({ action: 'magnet-bank-summary' });
  const b = await post({ action: 'magnet-bank-summary' });
  assert.deepEqual(a.json, b.json);
});

test('bloco indexers declara fallbackServed NÃO MEDIDO (sem produtor do contador)', async () => {
  // A chave `fallback.indexer.<id>` é do `adom_core::metric_id` (o golden
  // `metric-id` mede a normalização contra o oráculo do esm).

  config.jackett.apiKey = '';
  config.jackett.indexers = ['bank_test_id'];
  config.jackett.ptBrIndexers = [];
  config.jackett.slowIndexers = [];
  resetCatalogCache();
  // Nem com um valor no balde o bloco pode publicar medida: sem produtor, a
  // contagem é resíduo — publicar 5 afirmaria um histórico que ninguém escreve.
  metrics.count('fallback.indexer.bank_test_id', 5);

  const res = await get('?blocos=indexers');
  assert.equal(res.status, 200);
  const row = res.json.indexers.find((indexer: any) => indexer.id === 'bank_test_id');
  assert.ok(row, 'o indexer semeado aparece no catálogo');
  assert.equal(row.fallbackServed, null, 'sem produtor: não medido, nunca 0');

  // A leitura seria HISTÓRICO, não o estado online: o campo é separado de `status`.
  assert.equal('status' in row, true, 'o status de saúde continua no próprio campo');
});

test('painel: gateway fora não inventa metrics.native e o KPI I0 se declara não medido', async () => {
  const savedNative = config.nativeMetrics;
  config.nativeMetrics = {
    gatewayUrl: 'http://127.0.0.1:1',
    debridUrl: 'http://127.0.0.1:1',
    token: 'tok-fantasma',
    timeoutMs: 120,
  };
  try {
    const res = await get('?blocos=metrics,searchFirst,releaseIndex');
    assert.equal(res.status, 200, 'painel fail-open com o gateway fora');
    assert.equal('native' in res.json.metrics, false, 'sem fonte: `native` ausente, nunca zero');
    // Contrato antigo intacto (só recebeu campo novo quando há fonte).
    assert.equal(typeof res.json.metrics.counters, 'object');
    assert.equal(typeof res.json.metrics.uptimeS, 'number');
    assert.equal('hits' in res.json.releaseIndex, true);
    assert.equal(res.json.releaseIndex.source, 'node');
    // I0: campos antigos continuam, mas o card sabe que não há medição.
    assert.equal(res.json.searchFirst.available, false);
    assert.equal(res.json.searchFirst.source, 'nativo-ausente');
    assert.equal(typeof res.json.searchFirst.responses, 'number');
  } finally {
    config.nativeMetrics = savedNative;
  }
});

test('painel: metrics.native lê as DUAS fontes e releaseIndex prefere o nativo', async () => {
  const gatewaySeen: { headers?: http.IncomingHttpHeaders } = {};
  const debridSeen: { headers?: http.IncomingHttpHeaders } = {};
  const gateway = await metricsStub(() => ({
    'account.rust.ok': 1,
    'index.rust.hit': 42,
    'index.rust.miss': 7,
    'index.rust.served': 3,
  }), gatewaySeen);
  const debridStub = await metricsStub(() => ({
    'rust.debrid.check.hit': 9,
    'debrid.al.cleanup': 2,
  }), debridSeen);
  const savedNative = config.nativeMetrics;
  config.nativeMetrics = {
    gatewayUrl: gateway.url,
    debridUrl: debridStub.url,
    token: 'tok-native-8710',
    timeoutMs: 500,
  };
  try {
    const res = await get('?blocos=metrics,releaseIndex,searchFirst');
    assert.equal(res.status, 200);
    const native = res.json.metrics.native;
    assert.ok(native, 'native presente quando alguma fonte respondeu');
    assert.deepEqual(native.sources, { gateway: true, debrid: true });
    assert.equal(native.counters['index.rust.hit'], 42);
    assert.equal(native.counters['account.rust.ok'], 1);
    assert.equal(native.counters['rust.debrid.check.hit'], 9);
    assert.equal(native.counters['debrid.al.cleanup'], 2);
    assert.equal(typeof native.pulledAt, 'string');
    // O contrato antigo continua no mesmo lugar, agora com `native` ao lado.
    assert.equal(typeof res.json.metrics.counters, 'object');
    // Token só na 8710; a 7000 é pública.
    assert.equal(gatewaySeen.headers?.['x-indexer-test-token'], undefined);
    assert.equal(debridSeen.headers?.['x-indexer-test-token'], 'tok-native-8710');
    // releaseIndex: o nativo vence o contador do Node (que está congelado).
    assert.equal(res.json.releaseIndex.hits, 42);
    assert.equal(res.json.releaseIndex.misses, 7);
    assert.equal(res.json.releaseIndex.servedReleases, 3);
    assert.equal(res.json.releaseIndex.source, 'nativo');
    assert.equal(typeof res.json.releaseIndex.wouldHit, 'number', 'campo sem fonte nativa segue do Node');
    // I0 continua não medido mesmo com o gateway vivo: o Rust não o porta.
    assert.equal(res.json.searchFirst.available, false);
  } finally {
    config.nativeMetrics = savedNative;
    await gateway.close();
    await debridStub.close();
  }
});

// O header da 8710 é credencial de rota INTERNA: `DEBRID_INTERNAL_URL` só vira
// canal quando o destino é loopback (a MESMA régua do `ensure_loopback` do
// Rust). Env trocada para host externo desliga a fonte — nada de token viajando.
test('pullNativeMetrics: destino fora do loopback não recebe o token (fonte pulada)', async () => {
  const savedNative = config.nativeMetrics;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers || {} });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    // Host externo: nenhuma requisição, nenhum header.
    config.nativeMetrics = {
      gatewayUrl: '', debridUrl: 'http://example.com:8710', token: 'tok-segredo', timeoutMs: 100,
    };
    assert.equal(await pullNativeMetrics({ fetchImpl }), null, 'sem fonte: `null`, nunca zero inventado');
    assert.equal(calls.length, 0, 'host externo não é tentado');

    // Loopback: o header sai como sempre (a 7000 nem entra nesta leitura).
    config.nativeMetrics = {
      gatewayUrl: '', debridUrl: 'http://127.0.0.1:8710', token: 'tok-segredo', timeoutMs: 100,
    };
    const native = await pullNativeMetrics({ fetchImpl });
    assert.ok(native, '8710 em loopback respondeu');
    assert.deepEqual(native.sources, { gateway: false, debrid: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8710/metrics');
    assert.equal(calls[0].headers['X-Indexer-Test-Token'], 'tok-segredo');

    // A 7000 é pública e NÃO passa pela régua: host externo segue sem token.
    config.nativeMetrics = {
      gatewayUrl: 'http://example.com:7000', debridUrl: '', token: 'tok-segredo', timeoutMs: 100,
    };
    const publicNative = await pullNativeMetrics({ fetchImpl });
    assert.equal(publicNative?.sources.gateway, true, 'a 7000 não depende de loopback');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'http://example.com:7000/metrics');
    assert.equal(calls[1].headers['X-Indexer-Test-Token'], undefined, 'a 7000 nunca leva token');
  } finally {
    config.nativeMetrics = savedNative;
  }
});
