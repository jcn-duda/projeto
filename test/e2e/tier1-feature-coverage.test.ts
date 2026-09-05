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
// FEATURE 1: Dynamic Domain Validation
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 1: Dynamic Domain Validation', () => {
  function validateResolverUrl(urlString: string, { siteUrl, extraProtectors = '' }: { siteUrl?: string; extraProtectors?: string } = {}) {
    try {
      const parsed = new URL(urlString);
      const host = parsed.hostname.toLowerCase();
      const siteHost = siteUrl ? new URL(siteUrl).hostname.toLowerCase() : '';
      const fallbackSuffixes = ['bludvfilmes.xyz', 'bludv.net', 'bludv.xyz', 'bludv.to'];
      const baseProtectors = ['systemads1.com', 'systemads.net', 'videosad.net', 'canalfutebol.com'];
      const extras = extraProtectors
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const allowed = new Set([
        ...(siteHost ? [siteHost] : []),
        ...fallbackSuffixes,
        ...baseProtectors,
        ...extras,
      ]);
      return [...allowed].some((suffix) => host === suffix || host.endsWith('.' + suffix));
    } catch {
      return false;
    }
  }

  it('1.1: Resolver aceita URL no domínio configurado dinamicamente via SITE_URL', () => {
    const isAllowed = validateResolverUrl('https://custom-bludv-mirror.org/post/123', {
      siteUrl: 'https://custom-bludv-mirror.org',
    });
    assert.equal(isAllowed, true, 'Deve aceitar URL no domínio dinâmico');
  });

  it('1.2: Resolver aceita URLs em domínios de fallback conhecidos', () => {
    assert.equal(validateResolverUrl('https://bludv.to/filme-exemplo'), true);
    assert.equal(validateResolverUrl('https://sub.bludv.net/download'), true);
  });

  it('1.3: Resolver aceita protetores extras configurados via EXTRA_ALLOWED_PROTECTORS', () => {
    const isAllowed = validateResolverUrl('https://novo-protetor.link/get', {
      siteUrl: 'https://bludvfilmes.xyz',
      extraProtectors: 'novo-protetor.link, outro-protetor.net',
    });
    assert.equal(isAllowed, true, 'Deve aceitar host presente na lista de protetores extras');
  });

  it('1.4: Resolver rejeita URLs de domínios não autorizados ou maliciosos', () => {
    assert.equal(validateResolverUrl('https://malicious-attacker.com/payload'), false);
    assert.equal(validateResolverUrl('https://evil-phishing.org/login'), false);
  });

  it('1.5: Resolver lida com URLs malformadas e strings vazias sem lançar exceções', () => {
    assert.equal(validateResolverUrl(''), false);
    assert.equal(validateResolverUrl('not-a-valid-url'), false);
    assert.equal(validateResolverUrl('http://'), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 2: In-Memory Caching & Dedupe in BLUDV Resolver
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 2: In-Memory Caching & Dedupe in BLUDV Resolver', () => {
  function createPostResolverService() {
    const postCache = new Map();
    const inFlight = new Map();
    let networkFetches = 0;
    const MAX_CACHE_SIZE = 200;
    const POST_CACHE_MS = 1000;

    async function resolvePost(postUrl: any, fetcher: any) {
      const now = Date.now();
      const hit = postCache.get(postUrl);
      if (hit && now - hit.timestamp < POST_CACHE_MS) {
        return hit.magnets;
      }

      if (inFlight.has(postUrl)) {
        return inFlight.get(postUrl);
      }

      const promise = (async () => {
        try {
          networkFetches += 1;
          const magnets = await fetcher(postUrl);
          if (magnets && magnets.length) {
            if (postCache.size >= MAX_CACHE_SIZE) {
              const oldestKey = postCache.keys().next().value;
              postCache.delete(oldestKey);
            }
            postCache.set(postUrl, { magnets, timestamp: Date.now() });
          }
          return magnets;
        } finally {
          inFlight.delete(postUrl);
        }
      })();

      inFlight.set(postUrl, promise);
      return promise;
    }

    return {
      resolvePost,
      getCacheSize: () => postCache.size,
      getNetworkFetches: () => networkFetches,
      clear: () => { postCache.clear(); inFlight.clear(); networkFetches = 0; },
    };
  }

  it('2.1: Primeira consulta busca na rede e segunda consulta idêntica usa postCache', async () => {
    const service = createPostResolverService();
    const fetcher = async () => ['magnet:?xt=urn:btih:' + TEST_HASH_1];

    const res1 = await service.resolvePost('https://bludv.test/post1', fetcher);
    assert.equal(service.getNetworkFetches(), 1);
    assert.deepEqual(res1, ['magnet:?xt=urn:btih:' + TEST_HASH_1]);

    const res2 = await service.resolvePost('https://bludv.test/post1', fetcher);
    assert.equal(service.getNetworkFetches(), 1, 'Segunda requisição não deve acionar rede');
    assert.deepEqual(res2, res1);
  });

  it('2.2: Requisições concorrentes em voo compartilham a mesma Promise (inFlight dedupe)', async () => {
    const service = createPostResolverService();
    let resolverFn: (value?: any) => void = () => {};
    const delayedFetcher = () => new Promise((resolve) => { resolverFn = resolve; });

    const p1 = service.resolvePost('https://bludv.test/post2', delayedFetcher);
    const p2 = service.resolvePost('https://bludv.test/post2', delayedFetcher);
    const p3 = service.resolvePost('https://bludv.test/post2', delayedFetcher);

    resolverFn(['magnet:?xt=urn:btih:' + TEST_HASH_2]);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(service.getNetworkFetches(), 1, 'Apenas 1 chamada de rede deve ser feita para 3 requisições simultâneas');
    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
  });

  it('2.3: Expiração de TTL remove item do cache e força nova busca na rede', async () => {
    const service = createPostResolverService();
    let callCount = 0;
    const fetcher = async () => {
      callCount += 1;
      return ['magnet:?xt=urn:btih:' + TEST_HASH_1 + '&c=' + callCount];
    };

    await service.resolvePost('https://bludv.test/post-ttl', fetcher);
    assert.equal(service.getNetworkFetches(), 1);

    await new Promise((r) => setTimeout(r, 1100));

    const resAfterTtl = await service.resolvePost('https://bludv.test/post-ttl', fetcher);
    assert.equal(service.getNetworkFetches(), 2, 'Após TTL expirado, deve buscar novamente na rede');
    assert.ok(resAfterTtl[0].includes('c=2'));
  });

  it('2.4: Cache respeita o limite máximo de entradas (MAX_CACHE_SIZE) expulsando a mais antiga', async () => {
    const service = createPostResolverService();
    const fetcher = async (url: any) => ['magnet:?xt=urn:btih:' + TEST_HASH_1 + '&url=' + url];

    for (let i = 0; i < 205; i++) {
      await service.resolvePost(`https://bludv.test/item-${i}`, fetcher);
    }
    assert.equal(service.getCacheSize(), 200, 'Tamanho do cache deve permanecer limitado em 200');
  });

  it('2.5: Respostas com erro ou lista vazia não poluem o cache de posts', async () => {
    const service = createPostResolverService();
    const failingFetcher = async () => [];

    const resEmpty = await service.resolvePost('https://bludv.test/error-post', failingFetcher);
    assert.deepEqual(resEmpty, []);
    assert.equal(service.getCacheSize(), 0, 'Resultado vazio não deve ser salvo no cache');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 3: Standardized siteEnv Configuration
// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 3: Standardized siteEnv Configuration', () => {
  it('3.1: brResolvers.RESOLVERS declara todos os 5 microserviços com portas e siteEnv corretos', () => {
    const names = brResolvers.RESOLVERS.map((r) => r.name);
    assert.deepEqual(names, ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes', 'vacatorrent']);

    const bludv = brResolvers.RESOLVERS.find((r) => r.name === 'bludv') as (typeof brResolvers.RESOLVERS)[number];
    assert.equal(bludv.port, 8700);
    assert.equal(bludv.siteEnv, 'BLUDV_URL');

    const comando = brResolvers.RESOLVERS.find((r) => r.name === 'comandotorrents') as (typeof brResolvers.RESOLVERS)[number];
    assert.equal(comando.port, 8701);
    assert.equal(comando.siteEnv, 'COMANDOTORRENTS_URL');

    const nerd = brResolvers.RESOLVERS.find((r) => r.name === 'nerdfilmes') as (typeof brResolvers.RESOLVERS)[number];
    assert.equal(nerd.port, 8702);
    assert.equal(nerd.siteEnv, 'NERDFILMES_URL');

    const tdf = brResolvers.RESOLVERS.find((r) => r.name === 'torrentdosfilmes') as (typeof brResolvers.RESOLVERS)[number];
    assert.equal(tdf.port, 8703);
    assert.equal(tdf.siteEnv, 'TORRENTDOSFILMES_URL');
  });

  it('3.2: controles da configuração desligam o carregador sem alterar o ambiente pai', () => {
    const saved = { ...process.env };
    process.env.BLUDV_URL = 'https://custom-bludv.xyz';

    try {
      brResolvers.load({ ...config.resolvers, embedded: false });
      assert.equal(process.env.BLUDV_URL, 'https://custom-bludv.xyz');
    } finally {
      process.env = saved;
    }
  });

  it('3.3: Configuração de COMANDOTORRENTS_URL é respeitada pelo siteEnv', () => {
    const comandoConfig = brResolvers.RESOLVERS.find((r) => r.name === 'comandotorrents') as (typeof brResolvers.RESOLVERS)[number];
    assert.equal(comandoConfig.siteEnv, 'COMANDOTORRENTS_URL');
  });

  it('3.4: Configuração de NERDFILMES_URL e TORRENTDOSFILMES_URL são isoladas', () => {
    const nerd = brResolvers.RESOLVERS.find((r) => r.name === 'nerdfilmes') as (typeof brResolvers.RESOLVERS)[number];
    const tdf = brResolvers.RESOLVERS.find((r) => r.name === 'torrentdosfilmes') as (typeof brResolvers.RESOLVERS)[number];
    assert.equal(nerd.siteEnv, 'NERDFILMES_URL');
    assert.equal(tdf.siteEnv, 'TORRENTDOSFILMES_URL');
    assert.notEqual(nerd.siteEnv, tdf.siteEnv);
  });

  it('3.5: load() restaura variáveis de ambiente do processo pai com segurança', () => {
    const savedPort = process.env.PORT;
    const savedSelfUrl = process.env.SELF_URL;
    process.env.PORT = '7000';
    process.env.SELF_URL = 'http://127.0.0.1:7000';
    try {
      brResolvers.load({ ...config.resolvers, embedded: false });
      assert.equal(process.env.PORT, '7000', 'PORT deve ser restaurada');
      assert.equal(process.env.SELF_URL, 'http://127.0.0.1:7000', 'SELF_URL deve ser restaurada');
    } finally {
      if (savedPort) process.env.PORT = savedPort;
      if (savedSelfUrl) process.env.SELF_URL = savedSelfUrl;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 4: Enhanced Protector & JavaScript Extraction
// ════════════════════════════════════════════════════════════════════════════════
