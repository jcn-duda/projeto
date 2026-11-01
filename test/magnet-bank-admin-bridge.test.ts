// Ponte de LEITURA do banco de magnets vivo com a admin do gateway
// (`bankStatusNative`/`bankSearchNative`) e as ações do painel que a consomem
// (magnet-bank-summary / magnet-bank-search no /dashboard-action.json).
//
// O painel não abre o `data/magnets.db` no processo Node: quem responde é a
// admin 8711, com as MESMAS guardas destrutivas do import (`x-indexer-test-
// token` com o token destrutivo), e as ações ecoam o JSON dela — 503
// `magnet-bank-admin` quando a admin não responde. Sem rede real: o `fetch`
// é o dublê de `withMockFetch` (as requisições de teste usam http.request e
// não passam pelo fetch).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { bankStatusNative, bankSearchNative } from '../src/utils/magnet-bank-native.js';
import { createTestServer, withMockFetch } from './e2e/e2e-harness.js';

const ADMIN = 'http://127.0.0.1:8711';
const TOKEN = 'tok-destrutivo';
const DASH_TOKEN = 'tok-painel';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/** Shape que a admin devolve para `GET /magnet-bank/status` (o do painel). */
const STATUS_OK = {
  ok: true,
  enabled: true,
  engine: 'sql',
  magnets: 3,
  sources: 4,
  works: 5,
  lastSeen: 1_793_220_000_000,
  byIndexer: [{ indexer: 'bludv', hashes: 3, sources: 4, lastSeen: 1_793_220_000_000 }],
  memoryMax: null,
  memoryEvictions: 0,
  queue: 0,
  queueMax: 500,
};

/** Shape que a admin devolve para `GET /magnet-bank/search` (o do painel). */
const SEARCH_OK = {
  ok: true,
  mode: 'title',
  query: 'battle',
  limit: 50,
  matched: 1,
  returned: 1,
  truncated: false,
  items: [{
    hash: 'a'.repeat(40),
    uri: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=battle`,
    title: 'Battle Royale',
    size: 1024,
    isBr: true,
    dubbed: true,
    quality: '1080p',
    seedersMax: 9,
    seedersLast: 7,
    firstSeen: 1,
    lastSeen: 2,
    lied: false,
    sources: [{ indexer: 'bludv', tracker: 'BLUDV', firstSeen: 1, lastSeen: 2, seedersLast: 7 }],
    works: [{ imdb: 'tt0266697', season: -1, episode: -1, firstSeen: 1, lastSeen: 2, passedFilter: true }],
  }],
};

describe('magnet-bank-admin-bridge: leituras na admin 8711', () => {
  const saved: Record<string, any> = {};
  before(() => {
    saved.url = config.streamStore.url;
    saved.token = config.streamStore.token;
    config.streamStore.url = ADMIN;
  });
  after(() => {
    config.streamStore.url = saved.url;
    config.streamStore.token = saved.token;
  });

  test('sem credencial destrutiva devolve null sem abrir conexão (status e busca)', async () => {
    config.streamStore.token = '';
    await withMockFetch([
      { match: /./, handler: () => json(200, { ok: true }) },
    ], async (mock) => {
      assert.equal(await bankStatusNative(), null, 'status sem token é null');
      assert.equal(await bankSearchNative('battle'), null, 'busca sem token é null');
      assert.equal(mock.calls.length, 0, 'sem token NÃO há requisição nenhuma');
    });
  });

  test('GET /magnet-bank/status na admin com o token destrutivo; resposta repassada', async () => {
    config.streamStore.token = TOKEN;
    await withMockFetch([{
      match: /\/magnet-bank\/status$/,
      handler: (url: string, init?: RequestInit) => {
        assert.equal(url, `${ADMIN}/magnet-bank/status`);
        assert.equal((init?.headers as Record<string, string>)?.['x-indexer-test-token'], TOKEN);
        return json(200, { ...STATUS_OK });
      },
    }], async () => {
      assert.deepEqual(await bankStatusNative(), { status: 200, body: { ...STATUS_OK } });
    });
  });

  test('GET /magnet-bank/search encoda a query e manda o limit', async () => {
    config.streamStore.token = TOKEN;
    await withMockFetch([{
      match: /\/magnet-bank\/search/,
      handler: (url: string) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/magnet-bank/search');
        assert.equal(parsed.searchParams.get('q'), 'Battle Star', 'query encodada e decodada intacta');
        assert.equal(parsed.searchParams.get('limit'), '7');
        return json(200, { ...SEARCH_OK });
      },
    }], async () => {
      const result = await bankSearchNative('Battle Star', 7);
      assert.equal(result?.status, 200);
      assert.equal(result?.body.ok, true);
    });
  });

  test('rede fora → null; erro HTTP da admin repassa status e corpo, não null', async () => {
    config.streamStore.token = TOKEN;
    await withMockFetch([{
      match: /\/magnet-bank\//,
      handler: () => { throw new Error('ECONNREFUSED'); },
    }], async () => {
      assert.equal(await bankStatusNative(), null, 'falha de rede não lança');
      assert.equal(await bankSearchNative('battle'), null);
    });
    await withMockFetch([{
      match: /\/magnet-bank\/status$/,
      handler: () => json(500, { ok: false, error: 'boom' }),
    }], async () => {
      assert.deepEqual(await bankStatusNative(), { status: 500, body: { ok: false, error: 'boom' } });
    });
  });
});

describe('magnet-bank-admin-bridge: ações do painel ecos da admin', () => {
  const saved: Record<string, any> = {};
  let server: any;

  before(async () => {
    saved.url = config.streamStore.url;
    saved.token = config.streamStore.token;
    saved.testToken = config.jackett.testToken;
    config.streamStore.url = ADMIN;
    config.streamStore.token = TOKEN;
    config.jackett.testToken = DASH_TOKEN;
    server = await createTestServer(createApp().app);
  });

  after(async () => {
    await server.close();
    config.streamStore.url = saved.url;
    config.streamStore.token = saved.token;
    config.jackett.testToken = saved.testToken;
  });

  function post(body: any) {
    return server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': DASH_TOKEN },
      body,
    });
  }

  test('magnet-bank-summary ecoa o shape da admin (só o action é acrescentado)', async () => {
    await withMockFetch([{
      match: /\/magnet-bank\/status$/,
      handler: () => json(200, { ...STATUS_OK }),
    }], async () => {
      const res = await post({ action: 'magnet-bank-summary' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ...STATUS_OK, action: 'magnet-bank-summary' });
    });
  });

  test('kill-switch propagado: enabled:false da admin viaja, não é inventado', async () => {
    await withMockFetch([{
      match: /\/magnet-bank\/status$/,
      handler: () => json(200, {
        ok: true, enabled: false, engine: 'disabled', magnets: 0, sources: 0, works: 0,
        lastSeen: 0, byIndexer: [], memoryMax: null, memoryEvictions: 0, queue: 0, queueMax: 500,
      }),
    }], async () => {
      const res = await post({ action: 'magnet-bank-summary' });
      assert.equal(res.status, 200);
      assert.equal(res.json.enabled, false, 'kill-switch do gateway vence');
      assert.equal(res.json.engine, 'disabled');
      assert.equal(res.json.magnets, 0);
    });
  });

  test('magnet-bank-search ecoa o shape da admin e manda q/limit', async () => {
    await withMockFetch([{
      match: /\/magnet-bank\/search/,
      handler: (url: string) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('q'), 'battle');
        assert.equal(parsed.searchParams.get('limit'), '50', 'sem max no corpo, o default vai à admin');
        return json(200, { ...SEARCH_OK });
      },
    }], async () => {
      const res = await post({ action: 'magnet-bank-search', query: 'battle' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ...SEARCH_OK, action: 'magnet-bank-search' });
      assert.equal(res.json.items[0].uri.includes('dn=battle'), true);
    });
  });

  test('max do corpo vira o limit da admin com a mesma régua de antes', async () => {
    const urls: string[] = [];
    await withMockFetch([{
      match: /\/magnet-bank\/search/,
      handler: (url: string) => {
        urls.push(url);
        return json(200, { ok: true, mode: 'recent', query: '', limit: 1, matched: 0, returned: 0, truncated: false, items: [] });
      },
    }], async () => {
      await post({ action: 'magnet-bank-search', query: '', max: 7 });
      await post({ action: 'magnet-bank-search', query: '', max: 100000 });
      await post({ action: 'magnet-bank-search', query: '', max: 'abc' });
    });
    const limits = urls.map((u) => new URL(u).searchParams.get('limit'));
    assert.deepEqual(limits, ['7', '100', '50'], 'positivo vai; acima do teto é cortado; lixo cai no default');
  });

  test('admin fora: 503 magnet-bank-admin nas duas ações', async () => {
    await withMockFetch([{
      match: /\/magnet-bank\//,
      handler: () => { throw new Error('ECONNREFUSED'); },
    }], async () => {
      const summary = await post({ action: 'magnet-bank-summary' });
      assert.equal(summary.status, 503);
      assert.deepEqual(summary.json, { ok: false, error: 'magnet-bank-admin' });

      const search = await post({ action: 'magnet-bank-search', query: 'battle' });
      assert.equal(search.status, 503);
      assert.deepEqual(search.json, { ok: false, error: 'magnet-bank-admin' });
    });
  });

  test('query não-string é 400 local, sem tocar a admin', async () => {
    await withMockFetch([{
      match: /./,
      handler: () => { throw new Error('não deveria ter saído chamada'); },
    }], async (mock) => {
      const res = await post({ action: 'magnet-bank-search', query: 123 });
      assert.equal(res.status, 400);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.action, 'magnet-bank-search');
      assert.equal(mock.calls.length, 0, 'payload malformado não justifica rede');
    });
  });
});
