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
import jackett from '../src/providers/jackett.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { idxPoolCovered, poolCovered } from '../src/providers/index.js';
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

function userCfg(apiKey: string, overrides: Record<string, any> = {}) {
  return encodeConfig({
    p: ['jackett'],
    q: ['2160p', '1080p', '720p', '480p'],
    ds: 'premiumize',
    dk: apiKey,
    ...overrides,
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

test('Fase 3: índice não esconde a primeira fonte BR viva dentro da janela crítica', async () => {
  const key = 'idx-br-vivo';
  const indexedHash = '91'.repeat(20);
  const liveBrHash = '92'.repeat(20);
  const originalSearch = jackett.search;
  let priorityCalls = 0;

  jackett.search = async (_query, _type, indexers) => {
    if (!indexers?.includes('torrentdosfilmesv2')) return [];
    priorityCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return [{
      title: 'Zumbilândia 2009 720p DUBLADO',
      infoHash: liveBrHash,
      seeders: 1,
      tracker: 'torrentdosfilmesv2',
      indexer: 'torrentdosfilmesv2',
      isBr: true,
    }];
  };

  try {
    await withMockFetch([
      {
        match: 'cinemeta.strem.io',
        handler: () => ({ meta: { name: 'Zombieland', year: '2009', type: 'movie' } }),
      },
      {
        match: 'themoviedb.org',
        handler: () => ({ movie_results: [{ title: 'Zumbilândia', original_title: 'Zombieland', release_date: '2009-09-25' }] }),
      },
    ], async () => {
      // O harness limpa o cache no início da requisição simulada; o índice
      // precisa ser semeado depois disso, como no cenário de Jackett fora do ar.
      releaseIndex.record('tt9000110', {}, [{
        title: 'Zumbilândia 2009 720p DUBLADO',
        infoHash: indexedHash,
        seeders: 1,
        indexer: 'indice',
        isBr: true,
      }]);
      const res = await server.request('GET', `/${userCfg(key, { ji: ['torrentdosfilmesv2'], b: 2 })}/stream/movie/tt9000110.json`);

      assert.equal(res.status, 200);
      const dump = JSON.stringify(res.json.streams || []).toLowerCase();
      assert.ok(dump.includes(indexedHash), 'mantém a release que já estava no índice');
      assert.ok(dump.includes(liveBrHash), 'inclui a fonte BR viva na primeira resposta');
      assert.equal(priorityCalls, 1, 'não repete a consulta BR no enriquecimento tardio');
    });
  } finally {
    jackett.search = originalSearch;
  }
});

test('Fase 3: tail do índice reconcilia BR tardio antes da única promoção', async () => {
  const key = 'idx-br-tail-unico';
  const indexedHash = '93'.repeat(20);
  const lateBrHash = '94'.repeat(20);
  const globalHash = '95'.repeat(20);
  let releasePriority!: () => void;
  let releaseGlobal!: () => void;
  let notifyGlobalStarted!: () => void;
  const priority = new Promise<void>((resolve) => { releasePriority = resolve; });
  const global = new Promise<void>((resolve) => { releaseGlobal = resolve; });
  const globalStarted = new Promise<void>((resolve) => { notifyGlobalStarted = resolve; });
  const originalSearch = jackett.search;
  const savedDeadline = config.replyDeadline;
  const savedReserve = config.debridReserve;
  const savedFloor = config.debridCheckFloor;
  const cfg = userCfg(key, { ji: ['torrentdosfilmesv2', 'thepiratebay'], b: 2 });

  // Encurta só a janela do teste: o BR fica pendente quando a resposta do
  // índice sai, enquanto o global do tail continua fechado de forma determinística.
  config.replyDeadline = 800;
  config.debridReserve = 200;
  config.debridCheckFloor = 100;
  jackett.search = async (_query, _type, indexers) => {
    if (indexers?.includes('torrentdosfilmesv2')) {
      await priority;
      return [{ title: 'Zumbilândia 2009 720p DUBLADO', infoHash: lateBrHash, seeders: 1, indexer: 'torrentdosfilmesv2', isBr: true }];
    }
    notifyGlobalStarted();
    await global;
    return [{ title: 'Zombieland 2009 1080p', infoHash: globalHash, seeders: 10, indexer: 'thepiratebay' }];
  };

  try {
    await withMockFetch([
      { match: 'cinemeta.strem.io', handler: () => ({ meta: { name: 'Zombieland', year: '2009', type: 'movie' } }) },
      { match: 'themoviedb.org', handler: () => ({ movie_results: [{ title: 'Zumbilândia', original_title: 'Zombieland', release_date: '2009-09-25' }] }) },
    ], async () => {
      releaseIndex.record('tt9000111', {}, [{
        title: 'Zumbilândia 2009 720p DUBLADO', infoHash: indexedHash, seeders: 1, indexer: 'indice', isBr: true,
      }]);
      const res = await server.request('GET', `/${cfg}/stream/movie/tt9000111.json`);
      assert.equal(res.status, 200);

      releasePriority();
      await globalStarted;
      const beforeGlobal = await server.request('GET', `/${cfg}/stream/movie/tt9000111.json`);
      const beforeDump = JSON.stringify(beforeGlobal.json.streams || []).toLowerCase();
      assert.ok(beforeDump.includes(indexedHash), 'o writer prioritário não substitui o índice');
      assert.equal(beforeDump.includes(lateBrHash), false, 'BR tardio não promove antes do global');

      releaseGlobal();
      let promoted: any;
      for (let turn = 0; turn < 20; turn += 1) {
        const hit = await server.request('GET', `/${cfg}/stream/movie/tt9000111.json`);
        const dump = JSON.stringify(hit.json.streams || []).toLowerCase();
        if (dump.includes(indexedHash) && dump.includes(lateBrHash) && dump.includes(globalHash)) {
          promoted = hit.json;
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(promoted, 'o tail promove depois de reconciliar as duas coletas');
      const dump = JSON.stringify(promoted.streams || []).toLowerCase();
      assert.ok(dump.includes(indexedHash), 'a promoção preserva o índice');
      assert.ok(dump.includes(lateBrHash), 'a promoção preserva o BR tardio');
      assert.ok(dump.includes(globalHash), 'a promoção inclui o enriquecimento global');
    });
  } finally {
    releasePriority();
    releaseGlobal();
    jackett.search = originalSearch;
    config.replyDeadline = savedDeadline;
    config.debridReserve = savedReserve;
    config.debridCheckFloor = savedFloor;
  }
});

test('poolCovered: valida requireDubbed e swarms', () => {
  const legendadoFraco = [{
    hash: '77'.repeat(20),
    title: 'Test Title 2024 1080p LEGENDADO',
    seeders: 1,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(poolCovered(legendadoFraco as any, { requireDubbed: false }), false, 'sem seeders suficientes não cobre swarm');
  assert.equal(poolCovered(legendadoFraco as any, { requireDubbed: true }), false, 'legendado não cobre com requireDubbed');

  const legendadoForte = [{
    hash: '78'.repeat(20),
    title: 'Test Title 2024 1080p EN',
    seeders: 100,
    quality: '1080p',
  }];
  assert.equal(poolCovered(legendadoForte as any, { requireDubbed: false }), true, 'swarm forte cobre se requireDubbed=false');
  assert.equal(poolCovered(legendadoForte as any, { requireDubbed: true }), false, 'swarm forte NÃO cobre se requireDubbed=true');

  const brDublado = [{
    hash: '88'.repeat(20),
    title: 'Test Title 2024 1080p DUBLADO',
    seeders: 4,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(poolCovered(brDublado as any, { requireDubbed: true }), true, 'BR dublado cobre com requireDubbed');
  assert.equal(idxPoolCovered(brDublado as any), true, 'idxPoolCovered cobre BR dublado');
});

// --- Pack de temporada não decide cobertura de EPISÓDIO ----------------------
//
// Caso medido (True Detective S02E01): o índice tinha dois packs do NerdFilmes
// de 22,41 GB e 13,70 GB anunciados "[1080p DUBLADO]". Eles sustentavam a
// cobertura, a busca era servida do índice, o Jackett ia para o tail — e o
// dublado DO EPISÓDIO que a coleta ao vivo traria nunca aparecia. O pack promete
// a temporada, não a faixa de áudio daquele episódio; quem descobria a diferença
// era o usuário, no play.
const pack = (hash: string) => ({
  hash,
  title: 'True Detective 2ª Temporada (2015) [1080p DUBLADO 22.41 GB]',
  seeders: 40,
  quality: '1080p',
  isBr: true,
  dubbed: true,
});

const doEpisodio = (hash: string) => ({
  hash,
  title: 'True Detective 2ª Temporada – (2015) E01 [720p DUBLADO opção 2]',
  seeders: 1,
  quality: '720p',
  isBr: true,
  dubbed: true,
});

test('idxPoolCovered: só packs NÃO cobrem uma busca de episódio', () => {
  assert.equal(
    idxPoolCovered([pack('a1'.repeat(20))] as any, { season: 2, episode: 1 }),
    false,
    'pack não decide que o Jackett pode ficar de fora',
  );
});

test('idxPoolCovered: basta UMA release que nomeie o episódio', () => {
  assert.equal(
    idxPoolCovered([pack('a2'.repeat(20)), doEpisodio('b2'.repeat(20))] as any, { season: 2, episode: 1 }),
    true,
    'com release do episódio no índice, servir dele é honesto',
  );
});

test('idxPoolCovered: o episódio precisa ser o PEDIDO, não outro qualquer', () => {
  assert.equal(
    idxPoolCovered([doEpisodio('c3'.repeat(20))] as any, { season: 2, episode: 7 }),
    false,
    'E01 no índice não cobre E07',
  );
});

test('idxPoolCovered: filme e temporada inteira seguem cobertos por pack', () => {
  // Sem episódio pedido não há promessa fina a quebrar: o pack É a obra.
  assert.equal(idxPoolCovered([pack('d4'.repeat(20))] as any, {}), true, 'filme/obra continua coberto');
  assert.equal(
    idxPoolCovered([pack('e5'.repeat(20))] as any, { season: 2, episode: null }),
    true,
    'busca de temporada continua coberta',
  );
});

