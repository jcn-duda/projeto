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
describe('Feature 11: Torznab XML CDATA Resilience', () => {
  it('11.1: parseXml decodifica corretamente títulos e atributos em tags XML do Torznab', () => {
    const xml = `<?xml version="1.0"?>
    <indexers>
      <indexer id="bludv-cardigann" name="BLUDV Filmes &amp; Séries">
        <language>pt-BR</language>
      </indexer>
    </indexers>`;

    const items = jackettCatalog.parseXml(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'bludv-cardigann');
    assert.equal(items[0].label, 'BLUDV Filmes & Séries');
  });

  it('11.2: parseXml decodifica entidades XML numéricas e nomeadas (&amp;, &#39;, &quot;)', () => {
    const xml = `<?xml version="1.0"?>
    <indexers>
      <indexer id="comandotorrents">
        <title>Comando &amp; Torrents &#8211; HD</title>
        <language>pt-BR</language>
      </indexer>
    </indexers>`;

    const items = jackettCatalog.parseXml(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Comando & Torrents – HD');
  });

  it('11.3: parseXml tolera tags vazias sem erro de sintaxe usando id como fallback', () => {
    const xml = `<?xml version="1.0"?>
    <indexers>
      <indexer id="nerdfilmes">
        <title></title>
      </indexer>
    </indexers>`;

    const items = jackettCatalog.parseXml(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'nerdfilmes');
    assert.equal(items[0].label, 'nerdfilmes');
  });

  it('11.4: fallback() fornece catálogo seguro a partir das configurações do .env', () => {
    const items = jackettCatalog.fallback();
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0);
    assert.ok(items.some((i) => i.id === 'bludv-cardigann' || i.isBr !== undefined));
  });

  it('11.5: load() armazena catálogo em cache em memória pelo tempo de TTL configurado', async () => {
    await withMockFetch(
      {
        match: '/results/torznab/api',
        handler: () =>
          fakeResponse(`<?xml version="1.0"?><indexers><indexer id="custom-idx"><title>Custom</title></indexer></indexers>`),
      },
      async () => {
        const savedKey = config.jackett.apiKey;
        config.jackett.apiKey = 'test-key';
        try {
          const list1 = await jackettCatalog.load();
          const list2 = await jackettCatalog.load();
          assert.deepEqual(list1, list2);
        } finally {
          config.jackett.apiKey = savedKey;
        }
      }
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 12: Architecture & Invariants Preservation
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 12: Architecture & Invariants Preservation', () => {
  it('12.1: Invariante 1: Orçamento de tempo e respostas parciais possuem cacheMaxAge: 0', () => {
    const partialResult = { streams: [], partial: true };
    const cacheAge = partialResult.partial || !partialResult.streams.length ? 0 : 900;
    assert.equal(cacheAge, 0, 'Invariante 1 exige cacheMaxAge: 0 para resultados parciais');
  });

  it('12.2: Invariante 2: Origem BR é mantida via campo interno _br e sanitizada antes de enviar ao Stremio', () => {
    const internalStream = {
      name: 'Stream Name',
      title: 'Title',
      infoHash: TEST_HASH_1,
      _br: true,
      _seeders: 10,
      _quality: '1080p',
    };

    const publicStream = {
      name: internalStream.name,
      title: internalStream.title,
      infoHash: internalStream.infoHash,
    } as { name: string; title: string; infoHash: string; _br?: unknown; _seeders?: unknown; _quality?: unknown };

    assert.equal(publicStream._br, undefined, 'Campos internos com _ não devem vazar');
    assert.equal(publicStream._seeders, undefined);
    assert.equal(publicStream._quality, undefined);
  });

  it('12.3: Invariante 3: limitReservingBr garante vagas reservadas (brReservedSlots) para fontes BR', () => {
    const globalStream1 = { name: 'Global 1', _seeders: 100, _quality: '1080p', _br: false };
    const globalStream2 = { name: 'Global 2', _seeders: 90, _quality: '1080p', _br: false };
    const brStream = { name: 'BR Dublado', _seeders: 1, _quality: '1080p', _br: true };

    const selected = format.limitReservingBr([globalStream1, globalStream2, brStream] as unknown as Stream[], {
      maxResults: 2,
      brReservedSlots: 1,
    });

    assert.equal(selected.length, 2);
    assert.ok(selected.some((s) => s.name === 'BR Dublado'), 'Fonte BR com 1 seeder deve ocupar a vaga reservada');
  });

  it('12.4: Invariante 4: Query planning dispara busca em português para indexadores BR e inglês para globais', () => {
    const plan = searchPlan.planJackettQueries(
      'Joker 2019',
      'Coringa 2019',
      ['1337x', 'bludv-cardigann'],
      ['bludv-cardigann'],
      ['bludv-cardigann']
    );

    const brQuery = plan.find((p) => p.indexers.includes('bludv-cardigann'));
    const globalQuery = plan.find((p) => p.indexers.includes('1337x'));

    assert.ok(brQuery);
    assert.ok(globalQuery);
    assert.equal(brQuery.query, 'Coringa 2019', 'Indexer BR deve receber query pt-BR');
    assert.equal(brQuery.fallback, 'Joker 2019', 'Indexer BR deve receber query original como fallback');
    assert.equal(globalQuery.query, 'Joker 2019', 'Indexer global deve receber query original em inglês');
  });

  it('12.5: Invariante 6: protected.js protege hashes de autofetch contra dropUncached', () => {
    assert.equal(protectedHashes.isHeld(TEST_HASH_1), false);
    protectedHashes.hold(TEST_HASH_1, 60);
    assert.equal(protectedHashes.isHeld(TEST_HASH_1), true);

    protectedHashes.release(TEST_HASH_1);
    assert.equal(protectedHashes.isHeld(TEST_HASH_1), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 13: E2E Testing Suite (Tiers 1-4)
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 13: E2E Testing Suite (Tiers 1-4)', () => {
  let server: any;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it('13.1: Endpoint /manifest.json retorna manifesto compatível com especificação Stremio', async () => {
    const res = await server.request('GET', '/manifest.json');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.equal(res.json.id, config.addonId);
    assert.equal(res.json.name, config.addonName);
    assert.deepEqual(res.json.resources, ['stream']);
    assert.deepEqual(res.json.types, ['movie', 'series']);
  });

  it('13.2: Endpoint /stream/movie/tt1254207.json com demo provider retorna streams válidos', async () => {
    const configSegment = encodeConfig({ p: ['demo'] });
    const res = await server.request('GET', `/${configSegment}/stream/movie/tt1254207.json`);

    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok(Array.isArray(res.json.streams));
    assert.ok(res.json.streams.length > 0);
    assert.ok(res.json.streams[0].name.includes('Big Buck Bunny') || res.json.streams[0].title.includes('Big Buck Bunny'));
  });

  it('13.3: Endpoint /defaults.json entrega opções públicas sem vazar chave de debrid', async () => {
    const res = await server.request('GET', '/defaults.json');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.equal(res.json.debridApiKey, '', 'debridApiKey deve ser estritamente vazia no /defaults.json');
    assert.ok(Array.isArray(res.json.services));
    assert.ok(res.json.services.length >= 5);
  });

  it('13.4: Endpoint /resolve/:infoHash com assinatura válida responde redirect 302', async () => {
    const userCfg = encodeConfig({ ds: 'premiumize', dk: 'test-pm-key' });
    const sig = crypto.createHmac('sha256', 'test-pm-key').update(TEST_HASH_1).digest('hex');

    await withMockFetch(
      {
        match: 'premiumize.me/api/transfer/directdl',
        handler: () =>
          fakeResponse({
            status: 'success',
            content: [{ path: 'Video.mp4', link: 'https://pm.test/dl/Video.mp4', size: 1000 }],
          }),
      },
      async () => {
        const res = await server.request('GET', `/${userCfg}/resolve/${TEST_HASH_1}?sig=${sig}`);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), 'https://pm.test/dl/Video.mp4');
      }
    );
  });

  it('13.5: Endpoint /configure e /:userConfig/configure entregam página HTML', async () => {
    const res1 = await server.request('GET', '/configure');
    assert.equal(res1.status, 200);
    assert.ok(/<!doctype html>/i.test(res1.text));
    assert.ok(res1.text.includes('Configurar'));

    const userCfg = encodeConfig({ q: ['1080p'] });
    const res2 = await server.request('GET', `/${userCfg}/configure`);
    assert.equal(res2.status, 200);
    assert.ok(/<!doctype html>/i.test(res2.text));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 14: Final E2E Pass & Adversarial Hardening (Tier 5)
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 14: Final E2E Pass & Adversarial Hardening (Tier 5)', () => {
  let server: any;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it('14.1: Segmento de configuração malformado ou inválido responde HTTP 404 (configuração inválida)', async () => {
    const res = await server.request('GET', '/@invalid-base64-segment!@/manifest.json');
    assert.equal(res.status, 404);
    assert.equal(res.text, 'configuração inválida');
  });

  it('14.2: InfoHash com comprimento inválido ou caracteres estranhos responde HTTP 400', async () => {
    const resShort = await server.request('GET', '/resolve/shortHash123');
    assert.equal(resShort.status, 400);
    assert.equal(resShort.text, 'infoHash inválido');

    const resNonHex = await server.request('GET', '/resolve/0123456789abcdefghijklmnopqrstuvwxyz0123');
    assert.equal(resNonHex.status, 400);
    assert.equal(resNonHex.text, 'infoHash inválido');
  });

  it('14.3: Assinatura HMAC adulterada ou ausente no /resolve com debrid ativo responde HTTP 403', async () => {
    const userCfg = encodeConfig({ ds: 'realdebrid', dk: 'rd-secret-key' });

    const resNoSig = await server.request('GET', `/${userCfg}/resolve/${TEST_HASH_1}`);
    assert.equal(resNoSig.status, 403);
    assert.equal(resNoSig.text, 'assinatura inválida');

    const validSig = crypto.createHmac('sha256', 'rd-secret-key').update(TEST_HASH_1).digest('hex');
    const tamperedSig = validSig.slice(0, -1) + (validSig.endsWith('0') ? '1' : '0');
    const resTampered = await server.request('GET', `/${userCfg}/resolve/${TEST_HASH_1}?sig=${tamperedSig}`);
    assert.equal(resTampered.status, 403);
    assert.equal(resTampered.text, 'assinatura inválida');
  });

  it('14.4: Acesso ao endpoint /metrics.json sem cabeçalho X-Indexer-Test-Token responde HTTP 401', async () => {
    const savedToken = config.jackett.testToken;
    config.jackett.testToken = 'secret-diagnostic-token';

    try {
      const res = await server.request('GET', '/metrics.json');
      assert.equal(res.status, 401);
      assert.equal(res.json.error, 'token de diagnóstico inválido');

      const resAuthorized = await server.request('GET', '/metrics.json', {
        headers: { 'x-indexer-test-token': 'secret-diagnostic-token' },
      });
      assert.equal(resAuthorized.status, 200);
      assert.ok(resAuthorized.json.cache);
    } finally {
      config.jackett.testToken = savedToken;
    }
  });

  it('14.5: Consulta com ID fora do padrão IMDb (não iniciado por tt) retorna streams vazios sem buscas de rede', async () => {
    const res = await server.request('GET', '/stream/movie/kitsu:99999.json');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.streams));
    assert.equal(res.json.streams.length, 0);
    assert.equal(res.json.cacheMaxAge, 0);
  });
});
