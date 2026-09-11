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
describe('Feature 4: Enhanced Protector & JavaScript Extraction', () => {
  function extractDestinationFromHtml(html: any) {
    if (!html) return null;
    const magnetMatch = html.match(/href=["'](magnet:\?[^"']+)["']/i);
    if (magnetMatch) return magnetMatch[1];

    const destMatch = html.match(/(?:var|const|let)\s+(?:DEST_URL|DOWNLOAD_URL)\s*=\s*["']([^"']+)["']/i);
    if (destMatch) return destMatch[1];

    const locMatch =
      html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
      html.match(/window\.location\.replace\(["']([^"']+)["']\)/i);
    if (locMatch) return locMatch[1];

    const metaMatch = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^;]*;\s*url=([^"']+)["']/i);
    if (metaMatch) return metaMatch[1];

    return null;
  }

  it('4.1: Extrai link magnet direto de tag HTML <a>', () => {
    const html = `<div class="btn"><a href="magnet:?xt=urn:btih:${TEST_HASH_1}&dn=Movie">Baixar</a></div>`;
    const target = extractDestinationFromHtml(html);
    assert.equal(target, `magnet:?xt=urn:btih:${TEST_HASH_1}&dn=Movie`);
  });

  it('4.2: Extrai destino de variável JavaScript var DEST_URL ou DOWNLOAD_URL', () => {
    const html1 = `<script>var DEST_URL = "magnet:?xt=urn:btih:${TEST_HASH_2}";</script>`;
    assert.equal(extractDestinationFromHtml(html1), `magnet:?xt=urn:btih:${TEST_HASH_2}`);

    const html2 = `<script>const DOWNLOAD_URL = "https://systemads.net/link/123";</script>`;
    assert.equal(extractDestinationFromHtml(html2), 'https://systemads.net/link/123');
  });

  it('4.3: Extrai destino de atribuição window.location no script da página', () => {
    const html = `<script>setTimeout(function() { window.location.href = "magnet:?xt=urn:btih:${TEST_HASH_3}"; }, 5000);</script>`;
    assert.equal(extractDestinationFromHtml(html), `magnet:?xt=urn:btih:${TEST_HASH_3}`);
  });

  it('4.4: Extrai destino de redirecionamento via tag <meta http-equiv="refresh">', () => {
    const html = `<meta http-equiv="refresh" content="3; url=https://systemads1.com/hop2">`;
    assert.equal(extractDestinationFromHtml(html), 'https://systemads1.com/hop2');
  });

  it('4.5: Simulador de saltos aborta de forma limpa ao atingir MAX_HOPS sem lançar exceção', async () => {
    const MAX_HOPS = 6;
    let hops = 0;
    const hopFetcher = async (url: any) => {
      hops += 1;
      return `<meta http-equiv="refresh" content="0; url=https://protector.test/hop-${hops}">`;
    };

    let currentUrl = 'https://protector.test/start';
    let finalMagnet = null;

    for (let i = 0; i < MAX_HOPS; i++) {
      const html = await hopFetcher(currentUrl);
      const next = extractDestinationFromHtml(html);
      if (!next || next.startsWith('magnet:')) {
        finalMagnet = next;
        break;
      }
      currentUrl = next;
    }

    assert.equal(hops, MAX_HOPS, 'Deve parar estritamente em MAX_HOPS');
    assert.equal(finalMagnet, null, 'Não deve resolver magnet em loop infinito');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 5: Title Matching & Deduplication Verification
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 5: Title Matching & Deduplication Verification', () => {
  it('5.1: matchesBrTitle aceita release legítima de filme compatível com título pt-BR dentro de ±2 anos', () => {
    const isMatch = format.matchesBrTitle(
      'Coringa (2019) 1080p DUAL 5.1 BluRay',
      'Coringa',
      2019,
      { isSeries: false, allNames: ['Coringa', 'Joker'] }
    );
    assert.equal(isMatch, true, 'Deve aceitar filme com ano exato');

    const isMatchTolerance = format.matchesBrTitle(
      'Coringa (2020) 1080p DUAL 5.1 BluRay',
      'Coringa',
      2019,
      { isSeries: false, allNames: ['Coringa', 'Joker'] }
    );
    assert.equal(isMatchTolerance, true, 'Deve aceitar dentro da tolerância de ±2 anos');
  });

  it('5.2: matchesBrTitle rejeita obras parecidas mas incorretas (falsos positivos)', () => {
    const isFalloutMovie = format.matchesBrTitle(
      'Missao Impossivel Efeito Fallout 2018 1080p DUAL',
      'Fallout',
      2024,
      { isSeries: true, allNames: ['Fallout'] }
    );
    assert.equal(isFalloutMovie, false, 'Deve rejeitar Missão Impossível Efeito Fallout');

    const isSequel = format.matchesBrTitle(
      'Deadpool 2 2018 1080p DUAL',
      'Deadpool',
      2016,
      { isSeries: false, allNames: ['Deadpool'] }
    );
    assert.equal(isSequel, false, 'Deve rejeitar sequência (Deadpool 2 para busca de Deadpool 1)');
  });

  it('5.3: matchesBrTitle para séries aceita anos de temporadas posteriores à estreia', () => {
    const isSeason2 = format.matchesBrTitle(
      'Fallout 2a Temporada (2025) 1080p DUAL',
      'Fallout',
      2024,
      { isSeries: true, allNames: ['Fallout'] }
    );
    assert.equal(isSeason2, true, 'Deve aceitar temporada posterior de série');
  });

  it('5.4: matchesEpisode filtra episódios específicos e aceita packs completos de temporada', () => {
    assert.equal(format.matchesEpisode('Serie S01E01 1080p', { season: 1, episode: 1 }), true);
    assert.equal(format.matchesEpisode('Serie S01E02 1080p', { season: 1, episode: 1 }), false);
    assert.equal(format.matchesEpisode('Serie 1a ate 8a Temporada Completa DUAL', { season: 1, episode: 1 }), true);
    assert.equal(format.matchesEpisode('Serie Todas as Temporadas DUAL', { season: 2, episode: 5 }), true);
  });

  it('5.5: dedupeByHash preserva a melhor contagem e as tags do post vencedor', () => {
    const streamGlobal = {
      infoHash: TEST_HASH_1,
      title: 'Movie 1080p',
      name: 'Movie\n1080p · 👤 100',
      _seeders: 100,
      _quality: '1080p',
      _br: false,
      _dubbed: false,
    };
    const streamBr = {
      infoHash: TEST_HASH_1,
      title: 'Movie 1080p Dublado',
      name: 'Movie\n1080p DUB BR · 👤 1',
      _seeders: 1,
      _quality: '1080p',
      _br: true,
      _dubbed: true,
    };

    const deduped = format.dedupeByHash([streamGlobal, streamBr]);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0]._seeders, 100, 'Deve manter o maior número de seeders');
    assert.equal(deduped[0]._br, false, 'Origem do perdedor não prova a do magnet global');
    assert.equal(deduped[0]._dubbed, false, 'Áudio do perdedor não pode contaminar o autofetch');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 6: Cache Statement Pre-Compilation
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 6: Cache Statement Pre-Compilation', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('6.1: Operações cache.set e cache.get persistem e recuperam dados com integridade', () => {
    cache.set('test-key-1', { data: 'sample-payload' }, 60);
    const val = cache.get('test-key-1');
    assert.deepEqual(val, { data: 'sample-payload' });
  });

  it('6.2: cache.forget remove chave da memória e dispara exclusão de disco', () => {
    cache.set('test-key-2', { foo: 'bar' }, 60);
    assert.ok(cache.get('test-key-2'));

    cache.forget('test-key-2');
    assert.equal(cache.get('test-key-2'), null);
  });

  it('6.3: cache.forgetMany remove lotes de chaves de forma segura', () => {
    cache.set('batch-1', 1, 60);
    cache.set('batch-2', 2, 60);
    cache.set('batch-3', 3, 60);

    cache.forget('batch-1');
    cache.forget('batch-2');

    assert.equal(cache.get('batch-1'), null);
    assert.equal(cache.get('batch-2'), null);
    assert.equal(cache.get('batch-3'), 3);
  });

  it('6.4: Chaves com TTL expirado retornam null e são expurgadas', async () => {
    cache.set('expiring-key', 'data', 1);
    assert.equal(cache.get('expiring-key'), 'data');

    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(cache.get('expiring-key'), null, 'Chave expirada deve retornar null');
  });

  it('6.5: cache.clear zera completamente o armazenamento', () => {
    cache.set('k1', 'v1', 60);
    cache.set('k2', 'v2', 60);
    assert.ok(cache.size() >= 2);

    cache.clear();
    assert.equal(cache.size(), 0);
    assert.equal(cache.get('k1'), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 7: Resilient Deserialization in Cache Load
// ════════════════════════════════════════════════════════════════════════════════
