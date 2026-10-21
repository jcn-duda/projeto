// Testes da rota interna de leitura do índice/instantâneo
// (POST /internal/search/index). O foco aqui é a correção do caminho de
// resposta: ele anexa SÓ a prova de arquivo (`applyFileEvidence`) e não
// consulta `getTitles`/TMDB — o ptTitleDual é decisão in-process do build Rust,
// que recebe os títulos pelo `/internal/search/meta`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig, withMockFetch } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearchIndex } from '../src/routes/internal-search-index.js';
import { record, markFileEvidence } from '../src/utils/release-index.js';
import { recordFileSizes } from '../src/debrid/file-sizes.js';

const TOKEN = 'tok-internal-index';
const encoded = encodeConfig({});

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.tmdbKey = config.tmdb.apiKey;
  saved.releaseEnabled = config.releaseIndex.enabled;
  saved.releaseTtl = config.releaseIndex.ttl;
  saved.accountFastPath = config.accountFastPath.enabled;
  config.jackett.testToken = TOKEN;
  // Se alguma regressão voltar a chamar `getTitles`, o TMDB tem chave e o mock
  // de fetch registra a tentativa; nada de rede real.
  config.tmdb.apiKey = 'chave-de-teste';
  config.releaseIndex.enabled = true;
  config.releaseIndex.ttl = 3600;
  // A conta não participa deste teste; desligar evita qualquer leitura de rede.
  config.accountFastPath.enabled = false;

  const app = express();
  registerInternalSearchIndex(app as unknown as express.Router, buildServices());
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
  config.tmdb.apiKey = saved.tmdbKey;
  config.releaseIndex.enabled = saved.releaseEnabled;
  config.releaseIndex.ttl = saved.releaseTtl;
  config.accountFastPath.enabled = saved.accountFastPath;
});

function indexBody(imdb: string) {
  return { encoded, type: 'movie', imdb };
}

test('index: não toca getTitles e anexa a prova de arquivo', async () => {
  const hash = 'a'.repeat(40);
  await withMockFetch([], async (mockFetch) => {
    // `withMockFetch` limpa o cache: semeia o índice e a prova DENTRO dele.
    record('tt9900001', {}, [{
      title: 'Filme Teste 2024 1080p', infoHash: hash, seeders: 12,
      size: 1024 * 1024 * 1024, indexer: 'bludv',
    }]);
    markFileEvidence(hash, { a: 'Dual', q: '720p', n: 'Filme.Teste.2024.720p.DUAL.mkv' });

    const res = await server.request('POST', '/internal/search/index', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: indexBody('tt9900001'),
    });
    assert.equal(res.status, 200);
    assert.equal(mockFetch.calls.length, 0, 'a rota não pode consultar TMDB/getTitles');
    assert.equal(res.json.index_items.length, 1);
    const item = res.json.index_items[0];
    assert.equal(item.fromSnapshot, true);
    assert.equal(item.provenAudio, 'Dual', 'applyFileEvidence segue intacto');
    assert.equal(item.provenQuality, '720p');
    assert.equal(item.provenName, 'Filme.Teste.2024.720p.DUAL.mkv');
    assert.equal(item.ptTitleDual, undefined, 'ptTitleDual é decisão do build Rust');
  });
});

test('index: prova de QUALIDADE do arquivo (fsz) vira provenQuality do item', async () => {
  // Interestelar do corte nativo (2026-10-20): o post não diz resolução, o
  // arquivo do hash diz 2160p. Sem este campo o Rust classifica o release no
  // balde "sem resolução" e a cota de qualidade troca o BR por um 4K global.
  const hash = 'f'.repeat(40);
  await withMockFetch([], async () => {
    record('tt9900003', {}, [{
      title: 'Interestelar [DUAL]', infoHash: hash, seeders: 1,
      size: 30 * 1024 ** 3, indexer: 'apachetorrent-cardigann', isBr: true,
    }]);
    recordFileSizes(hash, [
      { path: 'Interestelar 2014 4K Dual Audio/Interstellar.2014.2160p.UHD.Bluray.Dual.mkv', size: 30 * 1024 ** 3 },
    ]);
    const res = await server.request('POST', '/internal/search/index', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: indexBody('tt9900003'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.index_items.length, 1);
    assert.equal(res.json.index_items[0].provenQuality, '2160p', 'a prova do arquivo chega ao consumidor nativo');
  });
});

test('index: getTitles que lança não afeta a resposta', async () => {
  let calls = 0;
  await withMockFetch((async () => {
    calls += 1;
    throw new Error('fetch inesperado: a rota não deve consultar títulos');
  }) as any, async () => {
    const res = await server.request('POST', '/internal/search/index', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: indexBody('tt9900002'),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 0, 'nem getTitles nem qualquer fetch no caminho de índice');
    // Índice vazio: o follow-up reportado é o `miss` do colhedor.
    assert.deepEqual(res.json.effects, [{ kind: 'harvester_enqueue', reason: 'miss' }]);
  });
});
