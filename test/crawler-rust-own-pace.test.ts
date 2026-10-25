// Contrato da fachada do raspador depois que o loop TS saiu: os NOVE sites da
// tabela são do sidecar Rust (o Mico pela lane de ritmo próprio,
// `adom-crawl::motor::mico_lane`) e o Node não move fila nenhuma. O `start()`
// só PEDE ao sidecar (`POST /crawl/requeue-simulated`, um por site habilitado e
// não-dry) que devolva à fila o `simulated` do dry-run antigo do motor TS; a
// retomada de `inflight` é do sidecar no boot
// (`motor::requeue_inflight_on_boot`, que percorre `all_site_ids`, Mico
// incluído). Pedido recusado/fora do ar não derruba o boot: fire-and-forget.
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const registry = await import('../src/providers/crawl-sites/registry.js');
const { stubFetch } = await import('./helpers/stub.js');

const TOKEN = 'tok-requeue';
const savedCrawl = { ...config.crawl };
const savedToken = config.jackett.testToken;
let restoreStub: (() => void) | null = null;

interface SidecarCall { url: string; body: Record<string, unknown>; token?: string }

/** Dublê do sidecar Rust: registra URL/corpo/token e responde com `status`. */
function stubSidecar(status = 200): SidecarCall[] {
  const calls: SidecarCall[] = [];
  const stub = stubFetch((url, options) => {
    calls.push({
      url,
      body: JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>,
      token: (options?.headers as Record<string, string> | undefined)?.['X-Indexer-Test-Token'],
    });
    return { ok: status < 400, status, json: async () => ({ ok: status < 400 }) };
  });
  restoreStub = stub.restore;
  return calls;
}

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  config.jackett.testToken = TOKEN;
  Object.assign(config.crawl, { enabled: true, dryRun: false, sites: ['mico'] });
});

afterEach(() => {
  restoreStub?.();
  restoreStub = null;
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  config.jackett.testToken = savedToken;
  Object.assign(config.crawl, savedCrawl);
});

const movie = (url: string, lastmod = '2026-01-01') => ({ url, lastmod, kind: 'movie' as const });

describe('fachada do raspador: os nove sites são do sidecar Rust', () => {
  test('registro: todo site da tabela é rust e o Mico tem ritmo próprio', () => {
    for (const id of registry.tableIds()) {
      assert.equal(registry.isRustSite(id), true, `${id} é do sidecar`);
      assert.equal(registry.siteInfo(id).adapter, true, `${id} tem adaptador (no sidecar)`);
    }
    assert.equal(registry.isOwnPace('mico'), true, 'ritmo próprio continua declarado (lane do Rust)');
    assert.deepEqual(registry.adapterIds(), registry.tableIds(), 'o painel pode ligar qualquer site da tabela');
  });

  test('start() não mexe na inflight: a retomada é do sidecar', () => {
    stubSidecar();
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt2000000/')], 1);
    assert.equal(store.engine().takeNext('mico', 2)?.status, 'inflight', 'claim em voo do sidecar');
    crawler.start();
    assert.equal(store.engine().getUrl('mico', '/crawl/movie/tt2000000/')?.status, 'inflight',
      'o Node não devolve à fila uma página que o sidecar pode estar processando');
  });

  test('start() pede ao sidecar o requeue do simulated de cada site habilitado', () => {
    const calls = stubSidecar();
    store.engine().upsertUrls('mico', [movie('/crawl/movie/tt3000000/')], 1);
    const row = store.engine().takeNext('mico', 2);
    assert.ok(row);
    store.engine().markResult('mico', row.url, { status: 'simulated', imdb: 'tt3000000', releases: 1 }, 3);
    crawler.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `http://127.0.0.1:${config.crawl.sidecarPort}/crawl/requeue-simulated`);
    assert.deepEqual(calls[0]?.body, { site: 'mico' }, 'corpo exato: só o site (sem action/confirm)');
    assert.equal(calls[0]?.token, TOKEN, 'o token interno vai no header');
    assert.equal(store.engine().getUrl('mico', row.url)?.status, 'simulated',
      'quem devolve à fila é o sidecar: o Node não escreve no crawl.db');
  });

  test('start() não chama o sidecar com o dry-run ligado nem sem site habilitado', () => {
    const calls = stubSidecar();
    Object.assign(config.crawl, { dryRun: true });
    crawler.start();
    crawler._resetForTest();
    Object.assign(config.crawl, { dryRun: false, sites: [] });
    crawler.start();
    assert.equal(calls.length, 0);
  });

  test('sidecar fora do ar não derruba o boot (fire-and-forget)', async () => {
    const stub = stubFetch(() => { throw new Error('ECONNREFUSED 127.0.0.1'); });
    restoreStub = stub.restore;
    crawler.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.calls.length, 1, 'o pedido saiu e a falha foi engolida');
  });
});
