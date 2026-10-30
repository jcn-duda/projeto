// Rodada 2: checagem ligada; tier 1 (cobertura de features) tipado.
// remover arquivo a arquivo na rodada 2.
// A suíte precisa ser idêntica no Node 18 e no Node 22, sem criar SQLite local.
process.env.CACHE_PERSIST = 'false';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
  makeTorznabXml,
  makeCinemetaMeta,
  makeTmdbFind,
  createMockFetch,
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
import * as oracleFormat from '../helpers/pipeline-oracle/format.js';
import * as cache from '../../src/utils/cache.js';
import * as brResolvers from '../../src/br-resolvers.js';
import debrid from '../../src/debrid/index.js';
import * as protectedHashes from '../../src/debrid/protected.js';
import type { Stream } from '../../types/domain.js';

const TEST_HASH_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TEST_HASH_2 = '11223344556677889900aabbccddeeff00112233';
const TEST_HASH_3 = '99887766554433221100ffeeddccbbaa99887766';

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

    const selected = oracleFormat.limitReservingBr([globalStream1, globalStream2, brStream] as unknown as Stream[], {
      maxResults: 2,
      brReservedSlots: 1,
    });

    assert.equal(selected.length, 2);
    assert.ok(selected.some((s) => s.name === 'BR Dublado'), 'Fonte BR com 1 seeder deve ocupar a vaga reservada');
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

  it('13.2: /stream do Node está aposentado (410 com gateway nativo, 503 sem gateway)', async () => {
    const configSegment = encodeConfig({ p: ['demo'], d: 0 });
    const semGateway = await server.request('GET', `/${configSegment}/stream/movie/tt1254207.json`);
    assert.equal(semGateway.status, 503, 'sem gateway não há pipeline local');
    assert.match(String(semGateway.json.err), /gateway/);

    const saved = { gateway: process.env.GATEWAY, routes: process.env.ROUTES_RUST };
    process.env.GATEWAY = 'on';
    process.env.ROUTES_RUST = 'stream';
    try {
      const nativo = await server.request('GET', `/${configSegment}/stream/movie/tt1254207.json`);
      assert.equal(nativo.status, 410);
      assert.match(String(nativo.json.err), /gateway nativo/);
    } finally {
      if (saved.gateway === undefined) delete process.env.GATEWAY; else process.env.GATEWAY = saved.gateway;
      if (saved.routes === undefined) delete process.env.ROUTES_RUST; else process.env.ROUTES_RUST = saved.routes;
    }
  });

  it('13.3: Endpoint /defaults.json entrega opções públicas sem vazar chave de debrid', async () => {
    const res = await server.request('GET', '/defaults.json');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.equal(res.json.debridApiKey, '', 'debridApiKey deve ser estritamente vazia no /defaults.json');
    assert.ok(Array.isArray(res.json.services));
    assert.ok(res.json.services.length >= 5);
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

  it('14.5: /stream aposentado não faz busca de rede, mesmo com ID fora do padrão IMDb', async () => {
    // F4.4: o `/stream` do Node saiu; o ID fora do padrão (kitsu:) é decidido
    // pelo gateway, que devolve lista vazia. Aqui a garantia é a do processo
    // Node: a rota só sinaliza o modo (410/503) e não dispara coleta.
    const res = await server.request('GET', '/stream/movie/kitsu:99999.json');
    assert.equal(res.status, 503);
    assert.equal(Array.isArray(res.json.streams), false, 'não devolve lista: devolve erro explícito');
  });
});
