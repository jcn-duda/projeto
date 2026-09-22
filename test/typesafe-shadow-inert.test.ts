/**
 * Prova de INÉRCIA do runtime TypeSafe shadow — o contrato mais importante do
 * slice: com o runtime LIGADO e a API RESPONDENDO, o resultado da busca é
 * IDÊNTICO ao do runtime desligado. Nem `_br`, nem `_dubbed`, nem
 * `_dubClaim`, nem `_lied` mudam; nenhum RawItem de entrada é mutado; e a
 * comparação shadow acontece (métrica disagree/agree sobe) — ou seja, o teste
 * prova "mede tudo, altera nada".
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';
import {
  resetTypesafeForTests,
  flushTypesafeForTests,
} from '../src/ai/index.js';

const SAVED = { ...config.typesafe };
const META = { name: 'Interstellar', year: 2014 };
const TITLES = { original: 'Interstellar', pt: 'Interestelar' };

const hex = (c: string) => c.repeat(40);

// Três famílias de título: marca PT explícita, EN puro e Dual ambíguo.
function rawSet(): any[] {
  return [
    { title: 'Interestelar 2014 Dublado 1080p', infoHash: hex('1'), seeders: 30, indexer: 'tracker-x' },
    { title: 'Interstellar 2014 1080p BluRay x264', infoHash: hex('2'), seeders: 120, indexer: 'tracker-y' },
    { title: 'Interestelar Dual Áudio 2014 1080p', infoHash: hex('3'), seeders: 10, indexer: 'tracker-z' },
    { title: 'Interstellar 2014 720p WEB-DL', infoHash: hex('4'), seeders: 7, indexer: 'tracker-y' },
  ];
}

const snapshotOf = (streams: any[]) =>
  JSON.stringify(
    streams.map((s: any) => ({
      name: s.name,
      title: s.title,
      infoHash: s.infoHash,
      _seeders: s._seeders,
      _quality: s._quality,
      _size: s._size,
      _br: s._br,
      _dubbed: s._dubbed,
      _dubClaim: s._dubClaim,
      _lied: s._lied,
      _multiWork: s._multiWork,
      _indexer: s._indexer,
      _tracker: s._tracker,
    })),
  );

function cfgOn(over: Record<string, unknown> = {}) {
  Object.assign(config.typesafe, {
    enabled: true,
    apiKey: 'k-test',
    endpoint: 'https://ts.test/v1/systemone',
    model: 'jev-test',
    threshold: 0.55,
    timeoutMs: 3000,
    queueMax: 64,
    concurrency: 2,
    hourlyCap: 120,
    dailyCap: 600,
    cooldownMs: 60000,
    judgmentTtlS: 1209600,
    ...over,
  });
}

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);

beforeEach(() => {
  resetTypesafeForTests();
  cache.clearNamespace('tsj');
  metrics.reset();
  Object.assign(config.typesafe, SAVED); // baseline = desligado
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('shadow LIGADO com API viva: resultado idêntico ao desligado', async () => {
  // Run 1 — runtime desligado (estado de produção atual).
  const baseline = prepareCandidateStreams(rawSet(), { meta: META, titles: TITLES });

  // Run 2 — runtime ligado, API viva respondendo noul que CONCORDA com o
  // dublado e DIVERGE do EN (0.9 para tudo): a comparação shadow roda, e
  // ainda assim nada no resultado pode mudar.
  cfgOn();
  let stub: FetchStub | null = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul: 0.9 } } }),
  }));
  try {
    const shadow = prepareCandidateStreams(rawSet(), { meta: META, titles: TITLES });
    await flushTypesafeForTests();

    // O hook realmente rodou: houve chamadas e a comparação produziu métrica.
    assert.ok(stub.calls.length >= 1, 'shadow enfileirou títulos');
    assert.ok(counter('typesafe.shadow.agree') + counter('typesafe.shadow.disagree') >= 1);
    assert.equal(counter('typesafe.call.ok'), stub.calls.length);

    // Contrato central: listas IDÊNTICAS, campo a campo.
    assert.equal(snapshotOf(shadow.streams), snapshotOf(baseline.streams));
    const campos = ['_br', '_dubbed', '_dubClaim', '_lied'];
    for (const campo of campos) {
      assert.deepEqual(
        shadow.streams.map((s: any) => s[campo]),
        baseline.streams.map((s: any) => s[campo]),
        `${campo} idêntico com shadow ligado`,
      );
    }

    // Nenhum RawItem de entrada foi mutado pelo produtor.
    const novo = rawSet();
    const antes = JSON.stringify(novo);
    prepareCandidateStreams(novo, { meta: META, titles: TITLES });
    await flushTypesafeForTests();
    assert.equal(JSON.stringify(novo), antes, 'raw de entrada não mutado');
  } finally {
    stub.restore();
  }
});

test('teto por build: busca grande limita enfileiramento e registra cap', async () => {
  cfgOn();
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul: 0.1 } } }),
  }));
  try {
    // 40 títulos distintos: o teto SHADOW_PER_BUILD_MAX limita o enqueue.
    const muitos = Array.from({ length: 40 }, (_v, i) => ({
      title: `Filme Numero ${i} 2014 1080p x264`,
      infoHash: hex(String(10 + i)),
      seeders: 5,
      indexer: 'tracker-y',
    }));
    prepareCandidateStreams(muitos, { meta: { name: 'Filme Numero', year: 2014 }, titles: { original: 'Filme Numero' } });
    await flushTypesafeForTests();
    assert.ok(counter('typesafe.shadow.build-capped') >= 1, 'excedente registrado como cap');
    assert.ok(stub.calls.length <= 12, 'custo por build limitado');
  } finally {
    stub.restore();
  }
});
