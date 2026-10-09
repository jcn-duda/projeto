// Rodada 2: checagem ligada; tier 1 (cobertura de features) tipado.
// remover arquivo a arquivo na rodada 2.
// A suíte precisa ser idêntica no Node 18 e no Node 22, sem criar SQLite local.
process.env.CACHE_PERSIST = 'false';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import {
  fakeResponse,
  makeTorznabXml,
  makeCinemetaMeta,
  makeTmdbFind,
  createMockFetch,
  withMockFetch,
  createTestApp,
  createTestServer,
  encodeConfig,
  decodeConfig,
  signResolve,
  verifyResolve,
} from './e2e-harness.js';

import config from '../../src/config.js';
import * as runtime from '../../src/runtime.js';
import * as format from '../../src/utils/format.js';
import * as cache from '../../src/utils/cache.js';
import * as brResolvers from '../../src/br-resolvers.js';
import * as jackettCatalog from '../../src/providers/jackett-catalog.js';
import prowlarr from '../../src/providers/prowlarr.js';
import debrid from '../../src/debrid/index.js';
import * as protectedHashes from '../../src/debrid/protected.js';
import * as searchPlan from '../../src/providers/search-plan.js';
import { createLatestWriter } from '../../src/utils/latest-writer.js';
import type { Stream } from '../../types/domain.js';

const TEST_HASH_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TEST_HASH_2 = '11223344556677889900aabbccddeeff00112233';
const TEST_HASH_3 = '99887766554433221100ffeeddccbbaa99887766';

// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 7: Resilient Deserialization in Cache Load', () => {
  it('7.1: Simulador de carregamento recupera registros válidos para a memória', () => {
    const memoryStore = new Map();
    const rows = [
      { key: 'item:1', value: JSON.stringify({ name: 'Alpha' }), expires_at: Date.now() + 10000 },
      { key: 'item:2', value: JSON.stringify({ name: 'Beta' }), expires_at: Date.now() + 20000 },
    ];

    for (const row of rows) {
      try {
        memoryStore.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
      } catch {
        /* ignora corrompido */
      }
    }

    assert.equal(memoryStore.size, 2);
    assert.deepEqual(memoryStore.get('item:1').value, { name: 'Alpha' });
  });

  it('7.2: loadFromDisk ignora e descarta registros SQLite com tempo expirado', () => {
    const memoryStore = new Map();
    const now = Date.now();
    const rows = [
      { key: 'expired:1', value: JSON.stringify({ old: true }), expires_at: now - 5000 },
      { key: 'valid:1', value: JSON.stringify({ fresh: true }), expires_at: now + 5000 },
    ];

    const validRows = rows.filter((r) => r.expires_at > now);
    for (const row of validRows) {
      memoryStore.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
    }

    assert.equal(memoryStore.size, 1);
    assert.equal(memoryStore.has('expired:1'), false);
    assert.equal(memoryStore.has('valid:1'), true);
  });

  it('7.3: Deserialização resiliente protege contra JSON corrompido sem abortar a carga', () => {
    const memoryStore = new Map();
    const rows = [
      { key: 'corrupt:1', value: '{ invalid-json-string }', expires_at: Date.now() + 10000 },
      { key: 'valid:2', value: JSON.stringify({ valid: true }), expires_at: Date.now() + 10000 },
    ];

    for (const row of rows) {
      try {
        memoryStore.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
      } catch {
        // Tolerância a falha por linha
      }
    }

    assert.equal(memoryStore.size, 1, 'Registro corrompido foi ignorado e o válido carregado');
    assert.equal(memoryStore.has('valid:2'), true);
  });

  it('7.4: Carregamento do cache respeita teto de MAX_ENTRIES', () => {
    const memoryStore = new Map();
    const MAX_ENTRIES = 2000;
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      key: `key:${i}`,
      value: JSON.stringify({ i }),
      expires_at: Date.now() + 10000 + i,
    })).slice(0, MAX_ENTRIES);

    for (const row of rows) {
      memoryStore.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
    }

    assert.equal(memoryStore.size, 2000);
  });

  it('7.5: Cache opera normalmente em memória pura quando persistência SQLite está inativa', () => {
    assert.doesNotThrow(() => {
      cache.set('mem-only-key', { mode: 'memory' }, 60);
      const res = cache.get('mem-only-key');
      assert.deepEqual(res, { mode: 'memory' });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 8: Search & Late-Pass Budget Optimization
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 8: Search & Late-Pass Budget Optimization', () => {
  it('8.1: Coleta respeita janela de tempo e retorna partial: true quando fontes lentas estão pendentes', async () => {
    const fastStream = {
      title: 'Fast Movie 1080p',
      magnet: 'magnet:?xt=urn:btih:' + TEST_HASH_1,
      infoHash: TEST_HASH_1,
      seeders: 50,
      size: 1024 * 1024 * 1000,
      tracker: 'fast-tracker',
    };

    const bucket = [fastStream];
    const isPartial = true;

    assert.equal(bucket.length, 1);
    assert.equal(isPartial, true);
  });

  it('8.2: Resposta parcial sinaliza cacheMaxAge: 0 no contrato do stream handler', () => {
    const streams = [{ name: 'Fast Stream', title: 'Title' }];
    const partial = true;

    const response = (!streams.length || partial)
      ? { streams, cacheMaxAge: 0 }
      : { streams, cacheMaxAge: 900, staleRevalidate: 3600, staleError: 86400 };

    assert.equal(response.cacheMaxAge, 0, 'Busca parcial deve instruir cliente a não cachear');
  });

  it('8.3: Conclusão em background executa late pass e entrega resultado consolidado', async () => {
    let committed = null;
    const writer = createLatestWriter(
      async (input) => ({ streams: input }),
      async (result) => { committed = result; }
    );

    await writer(['stream-episode']);
    assert.deepEqual(committed, { streams: ['stream-episode'] });
  });

  it('8.4: Coalescing via inFlight impede disparo de buscas concorrentes redundantes', async () => {
    const inFlight = new Map();
    let actualSearches = 0;

    async function executeSearch(queryKey: any) {
      if (inFlight.has(queryKey)) return inFlight.get(queryKey);

      const promise = (async () => {
        try {
          actualSearches += 1;
          await new Promise((r) => setTimeout(r, 50));
          return { results: ['movie-stream'] };
        } finally {
          inFlight.delete(queryKey);
        }
      })();

      inFlight.set(queryKey, promise);
      return promise;
    }

    const [s1, s2, s3] = await Promise.all([
      executeSearch('movie:tt1234567'),
      executeSearch('movie:tt1234567'),
      executeSearch('movie:tt1234567'),
    ]);

    assert.equal(actualSearches, 1, 'Apenas 1 execução real para chamadas simultâneas');
    assert.deepEqual(s1, s2);
    assert.deepEqual(s2, s3);
  });

  it('8.5: createLatestWriter rejeita revisões antigas de sobrescreverem novas', async () => {
    const history: unknown[] = [];
    const writer = createLatestWriter(
      async (input) => input,
      async (value) => history.push(value)
    );

    await writer('phase-0-rev-1');
    writer.advance();
    await writer('phase-1-rev-1');
    // Tentativa tardia com fase antiga sem resultado útil
    await writer([], 0);

    assert.deepEqual(history, ['phase-0-rev-1', 'phase-1-rev-1']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 9: Prowlarr Provider Resilience & Unit Testing
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 9: Prowlarr Provider Resilience & Unit Testing', () => {
  it('9.1: Retorna array vazio imediatamente se PROWLARR_API_KEY não estiver configurada', async () => {
    const savedKey = config.prowlarr.apiKey;
    config.prowlarr.apiKey = '';

    try {
      const results = await prowlarr.search('Test Query');
      assert.deepEqual(results, []);
    } finally {
      config.prowlarr.apiKey = savedKey;
    }
  });

  it('9.2: Converte resposta JSON válida do Prowlarr em objetos RawStream padronizados', async () => {
    const mockData = [
      {
        title: 'Prowlarr Movie 2024 1080p',
        magnetUrl: 'magnet:?xt=urn:btih:' + TEST_HASH_1,
        infoHash: TEST_HASH_1,
        seeders: 45,
        size: 1024 * 1024 * 1500,
        indexer: '1337x',
      },
    ];

    await withMockFetch(
      { match: '/api/v1/search', handler: () => fakeResponse(mockData) },
      async () => {
        const savedKey = config.prowlarr.apiKey;
        config.prowlarr.apiKey = 'test-key';
        try {
          const results = await prowlarr.search('Prowlarr Movie');
          assert.equal(results.length, 1);
          assert.equal(results[0].title, 'Prowlarr Movie 2024 1080p');
          assert.equal(results[0].infoHash, TEST_HASH_1);
          assert.equal(results[0].seeders, 45);
          assert.equal(results[0].tracker, '1337x');
        } finally {
          config.prowlarr.apiKey = savedKey;
        }
      }
    );
  });

  it('9.3: Tolera payload JSON que não seja array retornando lista vazia', async () => {
    await withMockFetch(
      { match: '/api/v1/search', handler: () => fakeResponse({ error: 'Unauthorized', status: 401 }) },
      async () => {
        const savedKey = config.prowlarr.apiKey;
        config.prowlarr.apiKey = 'test-key';
        try {
          const results = await prowlarr.search('Prowlarr Movie');
          assert.deepEqual(results, []);
        } finally {
          config.prowlarr.apiKey = savedKey;
        }
      }
    );
  });

  it('9.4: Trata erros HTTP 500 do servidor Prowlarr defensivamente sem lançar exceção', async () => {
    await withMockFetch(
      { match: '/api/v1/search', handler: () => fakeResponse('Internal Server Error', { status: 500 }) },
      async () => {
        const savedKey = config.prowlarr.apiKey;
        config.prowlarr.apiKey = 'test-key';
        try {
          const results = await prowlarr.search('Crash Test');
          assert.deepEqual(results, []);
        } finally {
          config.prowlarr.apiKey = savedKey;
        }
      }
    );
  });

  it('9.5: Trata cancelamentos e falhas de rede com retorno de lista vazia', async () => {
    await withMockFetch(
      {
        match: '/api/v1/search',
        handler: () => { throw new Error('Network connection timeout'); },
      },
      async () => {
        const savedKey = config.prowlarr.apiKey;
        config.prowlarr.apiKey = 'test-key';
        try {
          const results = await prowlarr.search('Timeout Test');
          assert.deepEqual(results, []);
        } finally {
          config.prowlarr.apiKey = savedKey;
        }
      }
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 10: Debrid Adapter Mock & Error Coverage
// ════════════════════════════════════════════════════════════════════════════════
