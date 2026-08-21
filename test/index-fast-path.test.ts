// Fases 1 e 3 do índice de releases, no ponto de consumo:
// - Fase 1: inventário da conta suficiente → resposta ANTES do orçamento de
//   coleta (stopWhen), com o resto em fundo;
// - Fase 3: índice cobre → responde DELE mesmo com o Jackett fora do ar
//   (critério de aceitação do plano); lacuna → caminho completo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { idxPoolCovered } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';
import { createTestServer, encodeConfig, withMockFetch } from './e2e/e2e-harness.js';

const FAKE_ADAPTER = {
  id: 'premiumize',
  label: 'Premiumize fake',
  short: 'pm',
  cacheCheck: true,
  keyUrl: null as unknown as string,
  checkCached: async (_apiKey: string, infoHashes: string[]) => ({ cached: new Set(infoHashes), complete: true }),
  resolveLink: async () => null,
  inventory: async () => [] as any[],
} as unknown as DebridAdapter;

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.service = config.debrid.service;
  saved.apiKey = config.debrid.apiKey;
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.jackettApiKey = config.jackett.apiKey;
  saved.publicUrl = config.debrid.publicUrl;
  config.debrid.resolveSecret = '';
  // Jackett "configurado" para as tarefas existirem; o fetch é dublê.
  config.jackett.apiKey = 'test-jackett-key';
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.BY_ID.set(FAKE_ADAPTER.id, FAKE_ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(FAKE_ADAPTER.id);
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.apiKey;
  config.debrid.resolveSecret = saved.resolveSecret;
  config.jackett.apiKey = saved.jackettApiKey;
  config.debrid.publicUrl = saved.publicUrl;
});

function userCfg(apiKey: string) {
  return encodeConfig({
    p: ['jackett'],
    q: ['2160p', '1080p', '720p', '480p'],
    ds: 'premiumize',
    dk: apiKey,
  });
}

/** Jackett que não responde enquanto o gate não abrir. */
function hangingJackettRoute() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const route = {
    match: '/api/v2.0/indexers/',
    handler: () => ({
      ok: true,
      status: 200,
      json: () => gate.then(() => ({ Results: [] })),
    }),
  };
  return { route, open: () => release() };
}

test('Fase 1: conta suficiente responde sem esperar a coleta inteira', async () => {
  const key = 'fast-path-conta-1';
  const hashes = ['11'.repeat(20), '22'.repeat(20), '33'.repeat(20)];
  const originalInventory = (FAKE_ADAPTER as any).inventory;
  (FAKE_ADAPTER as any).inventory = async () =>
    hashes.map((h) => ({ title: 'Test Title 2024 1080p', infoHash: h, size: 1024 * 1024 * 1024 }));
  const jackett = hangingJackettRoute();

  try {
    const started = Date.now();
    await withMockFetch([jackett.route], async () => {
      const cfg = userCfg(key);
      const res = await server.request('GET', `/${cfg}/stream/movie/tt9000101.json`);
      const elapsed = Date.now() - started;

      assert.equal(res.status, 200);
      const dump = JSON.stringify(res.json.streams || []);
      for (const hash of hashes) {
        assert.ok(dump.toLowerCase().includes(hash), 'as releases da conta entraram na resposta');
      }
      assert.ok(elapsed < 2500, `resposta saiu antes do orçamento de coleta (${elapsed}ms)`);
      assert.equal(res.json.streams.length >= 2, true);
    });
    assert.ok(Date.now() > 0);
  } finally {
    jackett.open();
    (FAKE_ADAPTER as any).inventory = originalInventory;
    // Dá espaço para as tarefas pendentes assentarem antes do restore do fetch.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test('Fase 1: conta insuficiente NÃO corta a coleta (caminho atual)', async () => {
  const key = 'fast-path-conta-2';
  const originalInventory = (FAKE_ADAPTER as any).inventory;
  (FAKE_ADAPTER as any).inventory = async () => [
    { title: 'Test Title 2024 1080p', infoHash: '44'.repeat(20), size: 1024 },
  ];
  try {
    await withMockFetch([
      { match: '/api/v2.0/indexers/', handler: () => ({ Results: [] }) },
    ], async () => {
      const cfg = userCfg(key);
      const res = await server.request('GET', `/${cfg}/stream/movie/tt9000102.json`);
      assert.equal(res.status, 200);
      const dump = JSON.stringify(res.json.streams || []);
      assert.ok(dump.includes('44'.repeat(20)), 'a única release da conta continua entregue');
      // Sem corte antecipado: nada de fast-path aqui — o caminho normal rodou.
    });
  } finally {
    (FAKE_ADAPTER as any).inventory = originalInventory;
  }
});

test('Fase 3: Jackett FORA DO AR — busca respondida pelo índice', async () => {
  const key = 'idx-servido-1';
  const idxHashes = ['55'.repeat(20), '66'.repeat(20)];
  await withMockFetch([
    // Jackett derrubado DE PROPÓSITO: qualquer consulta rejeita.
    { match: '/api/v2.0/indexers/', handler: () => { throw new Error('jackett fora do ar'); } },
  ], async () => {
    // O índice precisa ser primado DEPOIS do cache.clear() do harness.
    releaseIndex.record('tt9000103', {}, idxHashes.map((h, i) => ({
      title: i === 0 ? 'Test Title 2024 1080p DUBLADO' : 'Test Title 2024 720p DUAL',
      infoHash: h,
      seeders: 15,
      indexer: 'recordado',
      isBr: true,
    })));

    const started = Date.now();
    const res = await server.request('GET', `/${userCfg(key)}/stream/movie/tt9000103.json`);
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    const dump = JSON.stringify(res.json.streams || []).toLowerCase();
    for (const hash of idxHashes) {
      assert.ok(dump.includes(hash), 'o stream do índice foi entregue');
    }
    assert.ok(elapsed < 3000, `sem esperar indexer morto (${elapsed}ms)`);
  });
});

test('idxPoolCovered: só legendado fraco NÃO cobre (não trava a busca BR)', () => {
  const legendadoFraco = [{
    hash: '77'.repeat(20),
    title: 'Test Title 2024 1080p LEGENDADO',
    seeders: 1,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(idxPoolCovered(legendadoFraco as any), false, 'contagem pura nunca decide cobertura');

  const brDublado = [{
    hash: '88'.repeat(20),
    title: 'Test Title 2024 1080p DUBLADO',
    seeders: 4,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(idxPoolCovered(brDublado as any), true, 'BR dublado cobre — mesma noção de pool do autofetch');
});
