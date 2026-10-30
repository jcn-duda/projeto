// P5 Fatia B — live read-only: TorBox/Premiumize via método CRU do adaptador.
//
// Regras duras da auditoria adversarial:
// - AllDebrid/Debrid-Link/Real-Debrid NUNCA participam (checar na AD é upload
//   e escreve na conta; DL não tem cacheCheck; RD escreve ledger/rdt e pode
//   enviar a chave a terceiro) — recusados SEM rede, com motivo honesto.
// - O live chama o adaptador direto (BY_ID), NUNCA debridCheck.checkCached() — a
//   camada orquestrada grava davail/magnetdb/métricas/notify.
// - Nada é gravado em lugar nenhum; hash some do payload (id+name+verdict).
//
// Desde o F4.2(c) a entrada do `/stream-trace.json` vive no `streams.db` do
// gateway: o seed é a PONTE dublada (`createStreamsBridge`), não o L1 do Node
// (que recusa escrita de `streams` por contrato). O debrid continua com o seu
// próprio dublê, passado como `onOther`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { liveCapability, liveCheck } from '../src/debrid/live-check.js';
import { createTestServer, withMockFetch, fakeResponse, encodeConfig } from './e2e/e2e-harness.js';
import { createStreamsBridge } from './helpers/streams-bridge.js';
import debridCheck from './helpers/pipeline-oracle/debrid-check.js';

const HASH = 'd'.repeat(40);
const PM_HOST = 'https://www.premiumize.me';

let server: any;
const saved: Record<string, unknown> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.live = config.search.streamTraceLive;
  config.jackett.testToken = '';
  config.search.streamTraceLive = [];
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken as string;
  config.search.streamTraceLive = saved.live as string[];
});

test('liveCapability: allowlist fechada, denylist estrutural, knob e conta', () => {
  assert.deepEqual(liveCapability('torbox', 'k', true), { allowed: true, reason: 'ok', service: 'torbox' });
  assert.deepEqual(liveCapability('premiumize', 'k', true), { allowed: true, reason: 'ok', service: 'premiumize' });
  assert.equal(liveCapability('alldebrid', 'k', true).reason, 'ad-hard-blocked');
  assert.equal(liveCapability('realdebrid', 'k', true).reason, 'rd-live-refused');
  assert.equal(liveCapability('debridlink', 'k', true).reason, 'no-cachecheck');
  assert.equal(liveCapability('torbox', '', true).reason, 'no-account');
  assert.equal(liveCapability('torbox', 'k', false).reason, 'knob-off');
  assert.equal(liveCapability('outroservico', 'k', true).reason, 'no-cachecheck');
});

test('liveCheck torbox: GET cru no host certo, veredito hit, hash não vaza', async () => {
  const item = { id: 'd1', name: 'Filme 2024', hash: HASH };
  await withMockFetch([
    {
      // TorBox checkcached devolve envelope com data = lista de {hash}.
      match: 'torrents/checkcached',
      handler: async () => fakeResponse({ status: 'success', data: [{ hash: HASH }] }),
    },
  ], async (mockFetch) => {
    const out = await liveCheck('torbox', 'k', [item], { timeoutMs: 1500, maxHashes: 100 });
    assert.equal(out.allowed, true);
    assert.equal(out.results[0].verdict, 'hit');
    assert.doesNotMatch(JSON.stringify(out), /[a-f0-9]{40}/, 'hash some do payload');
    assert.equal(mockFetch.calls.length, 1);
    assert.match(String(mockFetch.calls[0].url), /torrents\/checkcached/);
  });
});

test('liveCheck premiumize: GET cru no host certo, veredito miss', async () => {
  const item = { id: 'd1', name: 'Filme', hash: HASH };
  await withMockFetch([
    {
      match: `${PM_HOST}/cache/check`,
      handler: async () => fakeResponse({ status: 'success', data: { response: [false] } }),
    },
  ], async () => {
    const out = await liveCheck('premiumize', 'k', [item], { timeoutMs: 1500, maxHashes: 100 });
    assert.equal(out.results[0].verdict, 'miss');
  });
});

test('liveCheck alldebrid/debridlink/realdebrid: recusados SEM rede', async () => {
  await withMockFetch([], async (mockFetch) => {
    const ad = await liveCheck('alldebrid', 'k', [{ id: 'd1', name: 'x', hash: HASH }], { timeoutMs: 100, maxHashes: 10 });
    assert.equal(ad.allowed, false);
    assert.equal(ad.reason, 'ad-hard-blocked');
    const dl = await liveCheck('debridlink', 'k', [{ id: 'd1', name: 'x', hash: HASH }], { timeoutMs: 100, maxHashes: 10 });
    assert.equal(dl.reason, 'no-cachecheck');
    const rd = await liveCheck('realdebrid', 'k', [{ id: 'd1', name: 'x', hash: HASH }], { timeoutMs: 100, maxHashes: 10 });
    assert.equal(rd.reason, 'rd-live-refused');
    assert.equal(mockFetch.calls.length, 0, 'nenhuma chamada à rede nos recusados');
  });
});

test('liveCheck: erro local vira skipped, nunca unusable', async () => {
  await withMockFetch([
    {
      match: 'torrents/checkcached',
      handler: async () => { throw new Error('API fora do ar'); },
    },
  ], async () => {
    const out = await liveCheck('torbox', 'k', [{ id: 'd1', name: 'x', hash: HASH }], { timeoutMs: 100, maxHashes: 10 });
    assert.equal(out.results[0].verdict, 'skipped');
  });
});

test('rota mode=live: sonda de capacidade + execução só no segmento torbox', async () => {
  // O segmento usa as CHAVES CURTAS do SCHEMA (o normalize só lê elas): `ds`
  // é debridService e `dk` a apiKey (texto puro sem RESOLVE_SECRET).
  const segment = encodeConfig({ p: ['jackett'], ds: 'torbox', dk: 'k' });
  const debridCalls: string[] = [];
  // Seed no store NATIVO: lista + searchMeta, SEM trace (o gateway devolve o
  // recompute pronto — o dublê entrega um outcome legítimo de no-material).
  const bridge = createStreamsBridge({
    entries: [{
      type: 'movie',
      id: 'tt222',
      cache: { partial: false, debridKnown: true },
      streams: [{ name: 'Filme 2024\n1080p', infoHash: HASH, url: `https://x/resolve/${HASH}?sig=1` }],
      searchMeta: { names: ['Filme 2024'], year: 2024 },
      recompute: { attempted: true, basis: [], built: false, builtAt: null, note: 'no-material', items: [] },
    }],
    onOther: (url) => {
      debridCalls.push(url);
      return fakeResponse({ status: 'success', data: [{ hash: HASH }] });
    },
  });
  try {
    // Knob vazio: a EXECUÇÃO também é recusada — resposta honesta SEM rede.
    config.search.streamTraceLive = [];
    const liveOff = await server.request('GET', `/${segment}/stream-trace.json?type=movie&id=tt222&mode=live`, {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(liveOff.status, 200);
    assert.equal(liveOff.json.live.allowed, false);
    assert.equal(liveOff.json.live.reason, 'knob-off');
    assert.equal(debridCalls.length, 0, 'knob desligado: NENHUMA chamada ao debrid');
    assert.equal(bridge.count('/streams/trace'), 1, 'mas a leitura do ledger nativo aconteceu');

    // Kill-switch STREAM_TRACE=false também desliga o live.
    const savedTrace = config.search.streamTrace;
    config.search.streamTrace = false;
    config.search.streamTraceLive = ['torbox'];
    try {
      const ks = await server.request('GET', `/${segment}/stream-trace.json?type=movie&id=tt222&mode=live`, {
        headers: { 'X-Indexer-Test-Token': bridge.token },
      });
      assert.equal(ks.json.live.allowed, false);
      assert.equal(ks.json.live.reason, 'knob-off');
      assert.equal(debridCalls.length, 0, 'kill-switch: NENHUMA chamada ao debrid');
    } finally {
      config.search.streamTrace = savedTrace;
    }

    config.search.streamTraceLive = ['torbox'];
    const liveRes = await server.request('GET', `/${segment}/stream-trace.json?type=movie&id=tt222&mode=live`, {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(liveRes.status, 200);
    assert.equal(liveRes.json.live.allowed, true, `reason: ${liveRes.json.live.reason}`);
    assert.equal(liveRes.json.origin, 'recompute', 'o gateway mandou o recompute (found sem trace) também');
    assert.equal(debridCalls.length, 1);
    assert.match(debridCalls[0], /torrents\/checkcached/);
  } finally {
    config.search.streamTraceLive = [];
    bridge.restore();
    cache.clear();
  }
});

test('rota mode=live: name sanitizado/truncado com a MESMA defesa do trace', async () => {
  const segment = encodeConfig({ p: ['jackett'], ds: 'torbox', dk: 'k' });
  config.search.streamTraceLive = ['torbox'];
  const savedTrace = config.search.streamTrace;
  const hash = 'a'.repeat(40);
  const bridge = createStreamsBridge({
    entries: [{
      type: 'movie',
      id: 'tt444',
      cache: { partial: false, debridKnown: true },
      streams: [{
        name: `Filme Sujo ${hash} magnet:?xt=urn:btih:${hash}&dn=F ${'X'.repeat(200)}`,
        infoHash: hash,
        url: `https://x/${hash}`,
      }],
      searchMeta: { names: ['Filme'], year: 2020 },
    }],
    onOther: () => fakeResponse({ status: 'success', data: [] }),
  });
  try {
    const res = await server.request('GET', `/${segment}/stream-trace.json?type=movie&id=tt444&mode=live`, {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    const name = String(res.json.live?.results?.[0]?.name || '');
    assert.ok(name.length <= 60, `name passou do teto: ${name.length}`);
    const body = JSON.stringify(res.json);
    assert.doesNotMatch(body, /magnet:/i, 'magnet não vaza no live');
    assert.doesNotMatch(body, /[a-f0-9]{40}/i, 'hash não vaza no live');
    assert.match(name, /<magnet>/);
    assert.match(name, /<hash>/);
  } finally {
    config.search.streamTraceLive = [];
    config.search.streamTrace = savedTrace;
    bridge.restore();
    cache.clear();
  }
});
