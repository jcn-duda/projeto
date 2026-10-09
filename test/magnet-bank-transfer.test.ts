// Exportar/importar o banco de magnets vivo (aba Magnets do painel): o formato
// NDJSON com cabeçalho, a validação por registro, a MESCLA (nunca substitui) e
// as duas rotas HTTP com o token. Sem rede; o banco abre em memória (e no
// SQLite, quando o runtime tem `node:sqlite`, para o keyset do export).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import { engine } from '../src/utils/magnet-bank-rows.js';
import type { MagnetRow, SourceRow, WorkRow } from '../src/utils/magnet-bank-rows.js';
import {
  TRANSFER_FORMAT, exportLines, importLines, mergeMagnetRows, mergeWorkRows, readMagnet, readWork,
} from '../src/utils/magnet-bank-transfer.js';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';

const DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bank-xfer-'));
const H = (c: string) => c.repeat(40);
const TOKEN = 'tok-bank-transfer';

const magnet = (hash: string, over: Partial<MagnetRow> = {}): MagnetRow => ({
  hash, uri: `magnet:?xt=urn:btih:${hash}`, title: `T ${hash.slice(0, 4)}`, size: 100, isBr: 0, dubbed: 0,
  quality: '1080p', seedersMax: 5, seedersLast: 5, firstSeen: 1000, lastSeen: 2000, lied: 0, ...over,
});
const source = (hash: string, indexer: string, over: Partial<SourceRow> = {}): SourceRow => ({
  hash, indexer, tracker: indexer.toUpperCase(), firstSeen: 1000, lastSeen: 2000, seedersLast: 5, ...over,
});
const work = (hash: string, imdb: string, over: Partial<WorkRow> = {}): WorkRow => ({
  hash, imdb, season: -1, episode: -1, firstSeen: 1000, lastSeen: 2000, passedFilter: 1, ...over,
});

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split('\n')) yield line;
}

function freshBank(sql = false): void {
  bank.resetForTests();
  bank.open(DIR(), { forceMemory: !sql });
  config.magnetBank.enabled = true;
}

function dump(): string {
  return [...exportLines(engine(), 42)].join('');
}

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
    assert.equal(readWork({ hash: H('a'), imdb: 'nm123' }), null);
    assert.equal(readWork({ hash: H('a'), imdb: 'tt0903747', season: 2, episode: 3 })?.season, 2);
  });
});

describe('magnet-bank-transfer: arquivo', () => {
  after(() => bank.resetForTests());

  test('ida e volta: exporta, importa num banco vazio e o acervo é o MESMO', async () => {
    freshBank();
    engine().writeBatch({
      magnets: [magnet(H('a')), magnet(H('b'), { isBr: 1, dubbed: 1 })],
      sources: [source(H('a'), 'nerdfilmes'), source(H('b'), 'bludv-cardigann'), source(H('b'), 'comandotorrents')],
      works: [work(H('a'), 'tt0000001'), work(H('b'), 'tt0000002', { season: 1, episode: 2 })],
    });
    const file = dump();
    const header = JSON.parse(file.split('\n')[0]);
    assert.equal(header.format, TRANSFER_FORMAT);
    assert.deepEqual(header.counts, { magnets: 2, sources: 3, works: 2 });

    freshBank();
    const report = await importLines(engine(), linesOf(file));
    assert.equal(report.ok, true);
    assert.deepEqual(report.magnets, { read: 2, inserted: 2, merged: 0 });
    assert.equal(report.rejected, 0);
    assert.equal(dump(), file, 'reexportar dá o mesmo arquivo byte a byte');

    // Idempotente: o mesmo arquivo de novo não muda nada.
    const again = await importLines(engine(), linesOf(file));
    assert.deepEqual(again.magnets, { read: 2, inserted: 0, merged: 2 });
    assert.equal(dump(), file);
  });

  test('MESCLA com o que já existe: nada local é apagado', async () => {
    freshBank();
    engine().writeBatch({ magnets: [magnet(H('a')), magnet(H('b'))], sources: [source(H('a'), 'x')], works: [] });
    const file = dump();
    freshBank();
    engine().writeBatch({ magnets: [magnet(H('c'))], sources: [source(H('c'), 'y')], works: [] });
    const report = await importLines(engine(), linesOf(file));
    assert.equal(report.ok, true);
    assert.equal(engine().countMagnets(), 3, 'o que era só local continua');
    assert.equal(engine().countSources(), 2);
  });

  test('sem cabeçalho, com versão desconhecida ou vazio: recusa sem gravar', async () => {
    freshBank();
    const semHeader = await importLines(engine(), linesOf(JSON.stringify({ t: 'm', ...magnet(H('a')) })));
    assert.equal(semHeader.ok, false);
    const versao = await importLines(engine(), linesOf(JSON.stringify({ t: 'meta', format: TRANSFER_FORMAT, v: 99 })));
    assert.match(String(versao.error), /versão/);
    assert.equal((await importLines(engine(), linesOf(''))).ok, false);
    assert.equal(engine().countMagnets(), 0);
  });

  test('fonte/obra sem magnet (nem no arquivo, nem no banco) é rejeitada, não vira órfã', async () => {
    freshBank();
    const file = [
      JSON.stringify({ t: 'meta', format: TRANSFER_FORMAT, v: 1 }),
      JSON.stringify({ t: 's', ...source(H('d'), 'x') }),
      JSON.stringify({ t: 'w', ...work(H('d'), 'tt1') }),
      'isto não é json',
    ].join('\n');
    const report = await importLines(engine(), linesOf(file));
    assert.equal(report.ok, true);
    assert.equal(report.rejected, 3);
    assert.equal(engine().countSources(), 0);
    assert.equal(engine().countWorks(), 0);
  });

  test('export pagina por hash (mais de uma página) sem repetir nem pular', () => {
    freshBank(true);
    const hashes = Array.from({ length: 1203 }, (_, i) => i.toString(16).padStart(40, '0'));
    engine().writeBatch({ magnets: hashes.map((h) => magnet(h)), sources: [], works: [] });
    const lines = dump().trim().split('\n').slice(1).map((l) => JSON.parse(l).hash);
    assert.equal(lines.length, 1203);
    assert.equal(new Set(lines).size, 1203);
    assert.deepEqual(lines, [...hashes].sort());
  });
});

describe('magnet-bank-transfer: rotas HTTP', () => {
  let server: any;
  const saved: Record<string, any> = {};

  before(async () => {
    saved.token = config.jackett.testToken;
    config.jackett.testToken = TOKEN;
    freshBank();
    engine().writeBatch({ magnets: [magnet(H('e'))], sources: [source(H('e'), 'nerdfilmes')], works: [work(H('e'), 'tt0000009')] });
    server = await createTestServer(createApp().app);
  });
  after(async () => {
    await server.close();
    config.jackett.testToken = saved.token;
    bank.resetForTests();
  });

  test('sem token é 401 nas duas rotas', async () => {
    assert.equal((await fetch(`${server.baseUrl}/magnet-bank-export`)).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/magnet-bank-import`, { method: 'POST', body: 'x' })).status, 401);
  });

  test('export devolve o arquivo gzip; import dele de volta mescla', async () => {
    const res = await fetch(`${server.baseUrl}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-disposition')), /adom-magnets-\d{8}-\d{4}\.ndjson\.gz/);
    const gz = Buffer.from(await res.arrayBuffer());
    const text = zlib.gunzipSync(gz).toString('utf8');
    assert.match(text.split('\n')[0], /"format":"adom-magnet-bank"/);

    const imp = await fetch(`${server.baseUrl}/magnet-bank-import`, {
      method: 'POST',
      headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/gzip' },
      body: gz,
    });
    const report = await imp.json();
    assert.equal(imp.status, 200);
    assert.deepEqual(report.magnets, { read: 1, inserted: 0, merged: 1 });
  });

  test('arquivo que não é export é 400, com o motivo', async () => {
    const imp = await fetch(`${server.baseUrl}/magnet-bank-import`, {
      method: 'POST',
      headers: { 'X-Indexer-Test-Token': TOKEN, 'Content-Type': 'application/x-ndjson' },
      body: '{"qualquer":"coisa"}\n',
    });
    assert.equal(imp.status, 400);
    assert.match(String((await imp.json()).error), /cabeçalho/);
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
    const res = await fetch(`${server.baseUrl}/${prefix}/magnet-bank-export`, { headers: { 'X-Indexer-Test-Token': TOKEN } });
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
