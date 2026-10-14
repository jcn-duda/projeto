import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const store = await import('../src/utils/crawl-store.js');
const { createCrawlStepper } = await import('../src/providers/crawl-step.js');
const { createSiteRuntime } = await import('../src/providers/crawl-site-runtime.js');
const { requestCostOf } = await import('../src/providers/crawl-page.js');
const { siteConfigOf } = await import('../src/utils/crawler-live-site.js');
const { envDefaults } = await import('../src/utils/crawler-live-schema.js');

const config = siteConfigOf({ ...envDefaults(), enabled: true, sites: ['fake'] }, 'fake');

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
});

after(() => store.resetForTests());

function stepper(onCost: (cost: number) => void, discoveryCost: () => number) {
  return createCrawlStepper({ markRequest: () => {}, onCost, discoveryCost });
}

function site(discover: () => Promise<any>) {
  return { id: 'fake', label: 'Fake', discover, fetchWork: async () => { throw new Error('not used'); } };
}

test('requestCostOf aceita somente inteiros finitos positivos', () => {
  assert.equal(requestCostOf({ requestCost: 4 }), 4);
  for (const value of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
    assert.equal(requestCostOf({ requestCost: value }), undefined, `valor inválido: ${String(value)}`);
  }
  assert.equal(requestCostOf(new Error('sem custo')), undefined);
});

test('descoberta que lança cobra requestCost medido uma vez e não avança cursor', async () => {
  const rt = createSiteRuntime('fake');
  const costs: number[] = [];
  const boom = Object.assign(new Error('sitemap ALLUNKNOWN'), { requestCost: 4 });
  await stepper((cost) => costs.push(cost), () => 3).step(rt, site(async () => { throw boom; }), config);
  assert.equal(rt.hourPages.current(), 4);
  assert.deepEqual(costs, [4]);
  assert.deepEqual(rt.cursors, { movie: '', tv_show: '' });
});

test('erro sem custo medido usa a estimativa uma vez', async () => {
  const rt = createSiteRuntime('fake');
  const costs: number[] = [];
  let estimates = 0;
  await stepper((cost) => costs.push(cost), () => { estimates += 1; return 3; })
    .step(rt, site(async () => { throw new Error('falha pura'); }), config);
  assert.equal(estimates, 1);
  assert.equal(rt.hourPages.current(), 3);
  assert.deepEqual(costs, [3]);
});

test('requestCost zero ou fracionário cai no custo estimado da descoberta', async () => {
  for (const invalid of [0, 1.5]) {
    const rt = createSiteRuntime('fake');
    const costs: number[] = [];
    const boom = Object.assign(new Error('falha sem medição válida'), { requestCost: invalid });
    await stepper((cost) => costs.push(cost), () => 2).step(rt, site(async () => { throw boom; }), config);
    assert.equal(rt.hourPages.current(), 2);
    assert.deepEqual(costs, [2]);
  }
});

test('falha no upsert após charge de descoberta bem-sucedida não cobra de novo', async () => {
  const rt = createSiteRuntime('fake');
  const costs: number[] = [];
  const engine = store.engine();
  const upsert = engine.upsertUrls;
  engine.upsertUrls = () => { throw new Error('store indisponível'); };
  try {
    await stepper((cost) => costs.push(cost), () => 3).step(rt, site(async () => ({
      urls: [{ url: '/obra', lastmod: '2026-01-01', kind: 'movie' }],
      complete: true,
      failures: [],
      requestCost: 4,
    })), config);
  } finally {
    engine.upsertUrls = upsert;
  }
  assert.equal(rt.hourPages.current(), 4);
  assert.deepEqual(costs, [4]);
  assert.equal(rt.cursors.movie, '');
});

test('onCost que lança é tentado uma vez e não repete a cobrança', async () => {
  const rt = createSiteRuntime('fake');
  const attempts: number[] = [];
  await stepper((cost) => { attempts.push(cost); throw new Error('telemetria indisponível'); }, () => 3)
    .step(rt, site(async () => ({ urls: [], complete: true, failures: [], requestCost: 4 })), config);
  assert.equal(rt.hourPages.current(), 4);
  assert.deepEqual(attempts, [4]);
});

test('descoberta parcial e completa mantêm o custo declarado sem duplicação', async () => {
  const costs: number[] = [];
  const partial = createSiteRuntime('fake');
  await stepper((cost) => costs.push(cost), () => 9).step(partial, site(async () => ({
    urls: [{ url: '/parcial', lastmod: '2026-02-01', kind: 'movie' }],
    complete: false,
    failures: ['um sitemap falhou'],
    requestCost: 3,
  })), config);
  assert.equal(partial.hourPages.current(), 3);
  assert.equal(partial.cursors.movie, '');

  const complete = createSiteRuntime('fake');
  await stepper((cost) => costs.push(cost), () => 9).step(complete, site(async () => ({
    urls: [{ url: '/completa', lastmod: '2026-03-01', kind: 'movie' }],
    complete: true,
    failures: [],
    requestCost: 2,
  })), config);
  assert.equal(complete.hourPages.current(), 2);
  assert.equal(complete.cursors.movie, '2026-03-01');
  assert.deepEqual(costs, [3, 2]);
});
