// Etapa 5 — superfície HTTP das ações do banco vivo no /dashboard-action.json
// (`magnet-bank-summary` / `magnet-bank-search`), do bloco `magnetBank` do
// /dashboard-status.json e do indicador `fallbackServed` por indexer.
//
// Sem rede: o catálogo de indexers é alimentado pelo fallback do .env (apiKey
// vazio) e a conta não é tocada. O banco vivo é aberto em MEMÓRIA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';
import { resetCatalogCache } from '../src/providers/jackett-catalog.js';
import { safeMetricId, indexerFallbackMetricKey } from '../src/utils/metric-id.js';
import { DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
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

test('bloco indexers normaliza o mesmo balde que o produtor (id que muda)', async () => {
  // Id CRU com espaço e barra: a normalização NÃO é no-op.
  assert.equal(safeMetricId('Bank Test/ID'), 'bank_test_id');
  assert.equal(indexerFallbackMetricKey('Bank Test/ID'), 'fallback.indexer.bank_test_id');

  config.jackett.apiKey = '';
  // O catálogo entrega o id JÁ normalizado; o produtor escreve pelo id cru.
  config.jackett.indexers = ['bank_test_id'];
  config.jackett.ptBrIndexers = [];
  config.jackett.slowIndexers = [];
  resetCatalogCache();
  metrics.count(indexerFallbackMetricKey('Bank Test/ID'), 5);

  const res = await get('?blocos=indexers');
  assert.equal(res.status, 200);
  const row = res.json.indexers.find((indexer: any) => indexer.id === 'bank_test_id');
  assert.ok(row, 'o indexer semeado aparece no catálogo de fallback');
  assert.equal(row.fallbackServed, 5, 'o consumidor lê o balde normalizado do produtor');

  // A leitura é HISTÓRICO, não o estado online: o campo é separado de `status`.
  assert.equal('status' in row, true, 'o status de saúde continua no próprio campo');
});
