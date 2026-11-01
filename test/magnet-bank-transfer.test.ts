// Exportar/importar o banco de magnets vivo (aba Magnets do painel): as rotas
// HTTP com o EXPORT como PROXY da admin do gateway e o IMPORT spoolando para
// ela (dublê `withMockFetch`). A MESCLA e a validação por registro são régua
// do oráculo (test/helpers/pipeline-oracle/magnet-bank-import.ts) — quem
// mescla/grava em produção é o gateway. Sem rede externa e sem banco local: o
// Node nem abre o SQLite do acervo (a prova é o dbPath fantasma).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { TRANSFER_FORMAT } from '../src/utils/magnet-bank-transfer.js';
import {
  mergeMagnetRows, mergeWorkRows, readMagnet, readSource, readWork,
  type MagnetRow, type WorkRow,
} from './helpers/pipeline-oracle/magnet-bank-import.js';
import { createTestServer, encodeConfig, withMockFetch } from './e2e/e2e-harness.js';

const DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bank-xfer-'));
const H = (c: string) => c.repeat(40);
const TOKEN = 'tok-bank-transfer';

const magnet = (hash: string, over: Partial<MagnetRow> = {}): MagnetRow => ({
  hash, uri: `magnet:?xt=urn:btih:${hash}`, title: `T ${hash.slice(0, 4)}`, size: 100, isBr: 0, dubbed: 0,
  quality: '1080p', seedersMax: 5, seedersLast: 5, firstSeen: 1000, lastSeen: 2000, lied: 0, ...over,
});
const work = (hash: string, imdb: string, over: Partial<WorkRow> = {}): WorkRow => ({
  hash, imdb, season: -1, episode: -1, firstSeen: 1000, lastSeen: 2000, passedFilter: 1, ...over,
});

describe('magnet-bank-transfer: mescla linha × linha', () => {
  test('datas nas pontas, seeders máximos, flags só sobem, URI só se enriquece', () => {
    const local = magnet(H('a'), { firstSeen: 500, lastSeen: 900, seedersMax: 9, seedersLast: 2, uri: `magnet:?xt=urn:btih:${H('a')}&dn=Local` });
    const vinda = magnet(H('a'), { firstSeen: 300, lastSeen: 1500, seedersMax: 4, seedersLast: 7, isBr: 1, lied: 1, title: 'Outro' });
    const m = mergeMagnetRows(local, vinda);
    assert.equal(m.firstSeen, 300);
    assert.equal(m.lastSeen, 1500);
    assert.equal(m.seedersMax, 9);
    assert.equal(m.seedersLast, 7, 'a observação mais NOVA dá o seeders_last');
    assert.equal(m.isBr, 1);
    assert.equal(m.lied, 1);
    assert.equal(m.title, 'T aaaa', 'título local não é trocado');
    assert.match(m.uri, /dn=Local/, 'URI sem dn não rebaixa a URI com dn');
  });

  test('passed_filter segue a última observação da obra; empate preserva o local', () => {
    assert.equal(mergeWorkRows(work(H('a'), 'tt1', { lastSeen: 10, passedFilter: 1 }), work(H('a'), 'tt1', { lastSeen: 20, passedFilter: 0 })).passedFilter, 0);
    assert.equal(mergeWorkRows(work(H('a'), 'tt1', { lastSeen: 20, passedFilter: 1 }), work(H('a'), 'tt1', { lastSeen: 20, passedFilter: 0 })).passedFilter, 1);
  });

  test('registro inválido do arquivo é recusado; URI que não é magnet vira vazia', () => {
    assert.equal(readMagnet({ hash: 'xyz' }), null);
    assert.equal(readMagnet({ hash: H('a'), uri: 'javascript:alert(1)' })?.uri, '');
    assert.equal(readSource({ hash: H('a'), indexer: '' }), null, 'fonte sem indexer é recusada');
    assert.equal(readSource({ hash: H('a'), indexer: 'bludv' })?.indexer, 'bludv');
    assert.equal(readWork({ hash: H('a'), imdb: 'nm123' }), null);
    assert.equal(readWork({ hash: H('a'), imdb: 'tt0903747', season: 2, episode: 3 })?.season, 2);
  });
});

describe('magnet-bank-transfer: rotas HTTP', () => {
  let server: any;
  let ghostDb = '';
  const saved: Record<string, any> = {};
  // As duas mãos falam com a admin do gateway: nos testes ela é um dublê
  // (`withMockFetch`). O `fetch` real fica guardado para deixar passar as
  // chamadas ao próprio servidor.
  const realFetch = globalThis.fetch;
  const STORE_TOKEN = 'tok-admin-destrutivo-teste';
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  // O NDJSON "cru" que a admin devolve (cabeçalho + um magnet).
  const ndjson = [
    JSON.stringify({ t: 'meta', format: TRANSFER_FORMAT, v: 1 }),
    JSON.stringify({ t: 'm', ...magnet(H('e')) }),
  ].join('\n') + '\n';
  // Dublê da rota `GET /magnet-bank/export` da admin: corpo cru ou JSON de recusa.
  const adminExport = (status = 200, body: string | Record<string, unknown> = ndjson): any => [
    {
      match: /\/magnet-bank\/export$/,
      handler: () => typeof body === 'string'
        ? new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } })
        : json(status, body),
    },
    { match: (u: string) => u.startsWith(server.baseUrl), handler: (u: string, init?: RequestInit) => realFetch(u, init) },
  ];

  before(async () => {
    saved.token = config.jackett.testToken;
    saved.storeToken = config.streamStore.token;
    saved.dbPath = config.magnetBank.dbPath;
    config.jackett.testToken = TOKEN;
    config.streamStore.token = STORE_TOKEN;
    config.magnetBank.enabled = true;
    // dbPath FANTASMA: nada no Node abre mais o acervo — a prova é o arquivo
    // nunca existir, nem num import recusado.
    ghostDb = path.join(DIR(), 'nao-deve-existir.db');
    config.magnetBank.dbPath = ghostDb;
    server = await createTestServer(createApp().app);
  });
  after(async () => {
    await server.close();
    config.jackett.testToken = saved.token;
    config.streamStore.token = saved.storeToken;
    config.magnetBank.dbPath = saved.dbPath;
  });

  test('sem token é 401 nas duas rotas', async () => {
    assert.equal((await fetch(`${server.baseUrl}/magnet-bank-export`)).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/magnet-bank-import`, { method: 'POST', body: 'x' })).status, 401);
  });

  test('export é proxy da admin: NDJSON cru entra, gzip sai com os mesmos headers', async () => {
    let asked = '';
    const res = await withMockFetch([
      {
        match: /\/magnet-bank\/export$/,
        handler: (url: string) => {
          asked = url;
          return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
        },
      },
      { match: (u: string) => u.startsWith(server.baseUrl), handler: (u: string, init?: RequestInit) => realFetch(u, init) },
    ], () => fetch(`${server.baseUrl}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } }));
    assert.equal(res.status, 200);
    assert.match(asked, /\/magnet-bank\/export$/, 'o pedido foi à admin, com a credencial destrutiva');
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    assert.match(String(res.headers.get('content-disposition')), /adom-magnets-\d{8}-\d{4}\.ndjson\.gz/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(
      zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'),
      ndjson,
      'o corpo é exatamente o da admin, só gzipado',
    );
  });

  test('export e o import do arquivo de volta: ida e volta pelas duas mãos novas', async () => {
    // Dublê da admin: confere que o spool chegou DESCOMPACTADO (o gzip não é
    // mais problema do gateway) e devolve a mescla que o gateway faria.
    const seen: { path?: string; text?: string } = {};
    const out = await withMockFetch(adminExport(), () =>
      fetch(`${server.baseUrl}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } }));
    assert.equal(out.status, 200);
    const gz = Buffer.from(await out.arrayBuffer());
    const imp = await withMockFetch([
      {
        match: /\/magnet-bank\/import$/,
        handler: (_u: string, init?: RequestInit) => {
          const sent = JSON.parse(String(init?.body));
          seen.path = sent.path;
          seen.text = fs.readFileSync(sent.path, 'utf8');
          return json(200, { ok: true, lines: 2, rejected: 0, magnets: { read: 1, inserted: 0, merged: 1 } });
        },
      },
      { match: (u: string) => u.startsWith(server.baseUrl), handler: (u: string, init?: RequestInit) => realFetch(u, init) },
    ], () => fetch(`${server.baseUrl}/magnet-bank-import`, {
      method: 'POST',
      headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/gzip' },
      body: gz,
    }));
    const report = await imp.json();
    assert.equal(imp.status, 200);
    assert.deepEqual(report.magnets, { read: 1, inserted: 0, merged: 1 });
    assert.match(String(seen.path), /adom-magnets-import-.*\.ndjson$/);
    assert.ok(path.isAbsolute(String(seen.path)));
    assert.match(String(seen.text).split('\n')[0], /"format":"adom-magnet-bank"/);
  });

  test('admin fora: export é 503 magnet-bank-admin, nunca acervo vazio fingido', async () => {
    // Sem credencial destrutiva não há conexão (mesma régua da ponte do import).
    config.streamStore.token = '';
    try {
      const res = await fetch(`${server.baseUrl}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: 'magnet-bank-admin' });
    } finally {
      config.streamStore.token = STORE_TOKEN;
    }
  });

  test('admin que responde erro: status e motivo dela repassados (kill-switch é do gateway)', async () => {
    const res = await withMockFetch(
      adminExport(409, { ok: false, error: 'magnet_bank_disabled' }),
      () => fetch(`${server.baseUrl}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } }),
    );
    assert.equal(res.status, 409);
    assert.match(String((await res.json()).error), /magnet_bank_disabled/);
  });

  test('admin que não responde (rede morta): export é 503 também', async () => {
    const res = await withMockFetch([
      { match: /\/magnet-bank\/export$/, handler: () => { throw new Error('gateway caiu'); } },
      { match: (u: string) => u.startsWith(server.baseUrl), handler: (u: string, init?: RequestInit) => realFetch(u, init) },
    ], () => fetch(`${server.baseUrl}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'magnet-bank-admin' });
  });

  test('arquivo que o gateway recusa volta com o status e o motivo dele', async () => {
    const imp = await withMockFetch([
      { match: /\/magnet-bank\/import$/, handler: () => json(400, { ok: false, error: 'arquivo sem cabeçalho do banco de magnets' }) },
      { match: (u: string) => u.startsWith(server.baseUrl), handler: (u: string, init?: RequestInit) => realFetch(u, init) },
    ], () => fetch(`${server.baseUrl}/magnet-bank-import`, {
      method: 'POST',
      headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/x-ndjson' },
      body: '{"qualquer":"coisa"}\n',
    }));
    assert.equal(imp.status, 400);
    assert.match(String((await imp.json()).error), /cabeçalho/);
  });

  test('admin do gateway fora: import é 503 native-unavailable, sem gravar pelo Node', async () => {
    config.streamStore.token = '';
    try {
      const imp = await fetch(`${server.baseUrl}/magnet-bank-import`, {
        method: 'POST',
        headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/x-ndjson' },
        body: [JSON.stringify({ t: 'meta', format: TRANSFER_FORMAT, v: 1 })].join('\n'),
      });
      const body = await imp.json();
      assert.equal(imp.status, 503);
      assert.equal(body.reason, 'native-unavailable');
      assert.equal(fs.existsSync(ghostDb), false, 'o Node nem abriu o SQLite do acervo');
    } finally {
      config.streamStore.token = STORE_TOKEN;
    }
  });

  test('MAGNET_BANK=false recusa o import antes de chamar a admin', async () => {
    config.magnetBank.enabled = false;
    try {
      const imp = await fetch(`${server.baseUrl}/magnet-bank-import`, {
        method: 'POST',
        headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/x-ndjson' },
        body: JSON.stringify({ t: 'meta', format: TRANSFER_FORMAT, v: 1 }),
      });
      assert.equal(imp.status, 409);
      assert.match(String((await imp.json()).error), /MAGNET_BANK=false/);
    } finally {
      config.magnetBank.enabled = true;
    }
  });

  test('arquivo acima do teto (MAGNET_BANK_IMPORT_MAX_BYTES) é 400 com o motivo', async () => {
    const saved = config.magnetBank.importMaxBytes;
    config.magnetBank.importMaxBytes = 1024;
    try {
      const big = [JSON.stringify({ t: 'meta', format: TRANSFER_FORMAT, v: 1 }),
        ...Array.from({ length: 50 }, (_, i) => JSON.stringify({ t: 'm', ...magnet(i.toString(16).padStart(40, 'f')) }))].join('\n');
      const imp = await fetch(`${server.baseUrl}/magnet-bank-import`, {
        method: 'POST',
        headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/x-ndjson' },
        body: big,
      });
      assert.equal(imp.status, 400);
      assert.match(String((await imp.json()).error), /teto/);
    } finally {
      config.magnetBank.importMaxBytes = saved;
    }
  });

  test('painel aberto pela URL de instalação: a rota com o prefixo de config responde igual', async () => {
    const prefix = encodeConfig({});
    const res = await withMockFetch(
      adminExport(),
      () => fetch(`${server.baseUrl}/${prefix}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } }),
    );
    assert.equal(res.status, 200);
    assert.match(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'), /"t":"m"/);
  });

  test('gzip corrompido é 400, não pendura a requisição', async () => {
    const imp = await fetch(`${server.baseUrl}/magnet-bank-import`, {
      method: 'POST',
      headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/gzip' },
      body: Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5]),
    });
    assert.equal(imp.status, 400);
  });
});
