// Testes da rota /internal/crawl-result quando a página NÃO traz IMDb mas TEM
// releases a gravar: a rota espelha a semântica do motor Node (crawl-page.ts,
// "done sem IMDb ancorado → identifyWork") — identifyWork no TMDB resolve a
// obra; 'unavailable' (TMDB fora) → 500, que o sidecar reentrega com backoff
// (motor/types.rs from_work: delivered=false); veredicto negativo
// (unidentified/ambiguous) → 200 terminal, nunca retentativa de veredito;
// página sem NADA a gravar mantém a nota 'no-imdb' sem gastar TMDB.
//
// identifyWork e o recorder são dublês injetados no registro (mesma via do
// motor Node, createPageProcessor — módulos ESM são namespaces congelados).
// NUNCA se importa src/addon.ts: o mini-app é montado à mão.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalCrawlResult } from '../src/routes/internal-crawl-result.js';
import type { CrawlObra, CrawlObraLocation, RecordReport } from '../src/providers/crawl-recorder.js';
import type { IdentifyInput, IdentifyResult } from '../src/providers/crawl-identify.js';
import type { RawItem } from '../types/domain.js';

const TOKEN = 'tok-internal-identify';

let server: any;
let savedToken: string = '';

/** Captura de UMA gravação do recorder (o dublê acumula). */
interface RecordCall {
  siteId: string;
  obra: CrawlObra;
  releases: RawItem[];
  location: CrawlObraLocation;
}

// Estado do dublê: cada teste configura o resultado e zera as capturas.
let identifyResult: IdentifyResult = { outcome: 'unidentified', imdb: null, reason: 'duble-nao-configurado' };
let recordReport: RecordReport = { kept: 1, added: 1, transition: 'none', cleared: 0 };
let identifyCalls: IdentifyInput[] = [];
let recordCalls: RecordCall[] = [];

/** Configura o dublê do identifyWork e zera só a captura dele. */
function setIdentify(result: IdentifyResult): IdentifyInput[] {
  identifyResult = result;
  identifyCalls = [];
  return identifyCalls;
}

/** Configura o relatório do dublê do recorder e zera só a captura dele. */
function setRecorder(report: Partial<RecordReport> = {}): RecordCall[] {
  recordReport = { kept: 1, added: 1, transition: 'none', cleared: 0, ...report };
  recordCalls = [];
  return recordCalls;
}

/** Hash de teste (40 hex) — o mesmo formato que o sidecar envia no magnet. */
const HASH1 = 'ab12'.repeat(10);
const HASH2 = 'cd34'.repeat(10);

/** Corpo padrão de uma página done SEM IMDb com uma release (CrawlWorkResult). */
function body(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://nerdfilmes.com/filme/obra-teste',
    url_key: 'filme/obra-teste',
    site: 'nerdfilmes',
    status: 'done',
    imdb: null,
    title: 'Obra Teste',
    year: 2024,
    kind: 'movie',
    releases: [{
      title: 'Obra Teste 2024 1080p WEB-DL DUBLADO',
      magnet: `magnet:?xt=urn:btih:${HASH1}`,
      link: null,
      size: '1.5 GB',
      seeders: 3,
      tracker: null,
      is_br: true,
    }],
    groups: [],
    unlocated: [],
    progress: null,
    request_cost: 1,
    error: '',
    ...overrides,
  };
}

before(async () => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;

  // Mini-app com só a rota interna (sem overlay /:userConfig), como no irmão.
  // Os dublês entram pelo registro — mesma injeção do createPageProcessor.
  const app = express();
  const services = buildServices();
  registerInternalCrawlResult(app as unknown as express.Router, services, {
    identify: async (input: IdentifyInput) => {
      identifyCalls.push({ ...input });
      return identifyResult;
    },
    record: async (
      siteId: string,
      obra: CrawlObra,
      releases: RawItem[],
      location: CrawlObraLocation = {},
    ): Promise<RecordReport> => {
      recordCalls.push({ siteId, obra, releases, location });
      return recordReport;
    },
  });
  server = await createTestServer(app);
});

after(async () => {
  config.jackett.testToken = savedToken;
  await server.close();
});

test('done sem IMDb + identify resolve → grava pelo recorder com o IMDb do TMDB', async () => {
  const idCalls = setIdentify({ outcome: 'identified', imdb: 'tt1112223', reason: 'casamento-unico' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.kept, 1);
  assert.equal(res.json.added, 1);
  assert.equal(res.json.note, undefined);
  // Fio do identify: o que a página traz (title/year/kind), igual ao motor.
  assert.deepEqual(idCalls, [{ type: 'movie', title: 'Obra Teste', year: 2024 }]);
  // Fio do recorder: obra identificada, lote único na raiz (filme).
  assert.equal(recCalls.length, 1);
  assert.equal(recCalls[0].siteId, 'nerdfilmes');
  assert.deepEqual(recCalls[0].obra, {
    imdb: 'tt1112223', title: 'Obra Teste', year: 2024, kind: 'movie',
  });
  assert.deepEqual(recCalls[0].location, {});
  assert.equal(recCalls[0].releases.length, 1);
  assert.equal(recCalls[0].releases[0].infoHash, HASH1);
  assert.equal(recCalls[0].releases[0].isBr, true);
});

test('identify indisponível (TMDB fora/timeout) → 500 para o sidecar reentregar', async () => {
  // 'unavailable' é o fail-open do identifyWork para rede quebrada: retentável,
  // não veredicto (crawl-page.ts trata como erro de página).
  const idCalls = setIdentify({ outcome: 'unavailable', imdb: null, reason: 'tmdb-indisponivel' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body(),
  });
  assert.equal(res.status, 500);
  assert.equal(res.json.ok, false);
  assert.match(String(res.json.error), /identify-indisponivel/);
  assert.equal(idCalls.length, 1);
  assert.equal(recCalls.length, 0);
});

test('identify sem candidato (unidentified) → 200 terminal, nada gravado', async () => {
  // Veredicto negativo do TMDB: obra errada é pior que nenhuma — 500 aqui
  // viraria retentativa infinita de uma resposta definitiva.
  setIdentify({ outcome: 'unidentified', imdb: null, reason: 'nome-sem-casamento' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.note, 'no-work:nome-sem-casamento');
  assert.equal(res.json.kept, 0);
  assert.equal(res.json.added, 0);
  assert.equal(recCalls.length, 0);
});

test('identify ambíguo (homonímia) → 200 terminal, nada gravado', async () => {
  setIdentify({ outcome: 'ambiguous', imdb: null, reason: 'homonimo-ambiguo' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.note, 'no-work:homonimo-ambiguo');
  assert.equal(recCalls.length, 0);
});

test('no-torrent sem IMDb → nota no-imdb sem gastar TMDB nem recorder', async () => {
  // Página sem nada a gravar mantém o comportamento anterior: no motor,
  // no-torrent não gasta identificação (crawl-page.ts).
  const idCalls = setIdentify({ outcome: 'identified', imdb: 'tt9999999', reason: 'casamento-unico' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body({ status: 'no-torrent', releases: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.note, 'no-imdb');
  assert.equal(idCalls.length, 0);
  assert.equal(recCalls.length, 0);
});

test('body.title null + releases → identify recebe título vazio e vira terminal', async () => {
  // O sidecar pode mandar title null: o motor passa String(title || '') e o
  // identifyWork responde 'pagina-sem-titulo' sem rede — a rota espelha.
  const idCalls = setIdentify({ outcome: 'unidentified', imdb: null, reason: 'pagina-sem-titulo' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body({ title: null }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.note, 'no-work:pagina-sem-titulo');
  assert.deepEqual(idCalls, [{ type: 'movie', title: '', year: 2024 }]);
  assert.equal(recCalls.length, 0);
});

test('partial de série com groups sem IMDb → identify resolve → grava por locação', async () => {
  const idCalls = setIdentify({ outcome: 'identified', imdb: 'tt4445556', reason: 'casamento-unico' });
  const recCalls = setRecorder();
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: body({
      status: 'partial',
      kind: 'series',
      title: 'Série Teste',
      year: 2023,
      releases: [],
      groups: [
        {
          season: 2,
          episode: 5,
          releases: [{
            title: 'Série Teste S02E05 1080p DUBLADO',
            magnet: `magnet:?xt=urn:btih:${HASH1}`,
            link: null, size: '900 MB', seeders: 1, tracker: null, is_br: true,
          }],
        },
        {
          season: 2,
          episode: null,
          releases: [{
            title: 'Série Teste S02 Completa 1080p DUBLADO',
            magnet: `magnet:?xt=urn:btih:${HASH2}`,
            link: null, size: '8 GB', seeders: 1, tracker: null, is_br: true,
          }],
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.kept, 2);
  assert.equal(res.json.added, 2);
  assert.deepEqual(idCalls, [{ type: 'series', title: 'Série Teste', year: 2023 }]);
  // UMA gravação por grupo, com a locação declarada e a obra identificada.
  assert.equal(recCalls.length, 2);
  assert.deepEqual(recCalls[0].location, { season: 2, episode: 5 });
  assert.deepEqual(recCalls[1].location, { season: 2, episode: null });
  assert.equal(recCalls[0].obra.kind, 'tv_show');
  assert.equal(recCalls[0].obra.imdb, 'tt4445556');
});
