// Identidade ESTRUTURAL da varredura pt-BR inline (follow-up).
//
// Bug corrigido: `collectRaw` decidia `inlineSweep` por texto
// (`planned.query === sweepQuery`), e a task BR ISOLADA cuja query coincide com
// a raiz da varredura (filme sem ano: `ptQuery === sweepQuery`) era tratada
// como varredura — perdia `recordStatus`/`onQueryResult` e não alimentava o
// fallback do banco vivo. A marca agora é o campo `sweep` do plano.
//
// Sem rede: `jackett.search` é dublê; a consulta principal FALHA de propósito
// para provar que só ela alimenta o estado vivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import { planJackettQueries } from '../src/providers/search-plan.js';
import { collectRaw } from '../src/providers/collect-orchestrator.js';
import * as runtime from '../src/runtime.js';
import { patch, testOpts } from './helpers/stub.js';

const matchContext = () => ({
  names: ['The Crow'], year: null, isSeries: false, season: null, episode: null,
});

test('plano: BR isolada com ptQuery === sweepQuery NÃO é marcada como sweep', () => {
  const plan = planJackettQueries(
    'The Crow',
    'O Corvo',
    ['thepiratebay', 'bludv-cardigann'],
    ['bludv-cardigann'],
    [],
    'O Corvo',
  );

  const br = plan.find((t) => t.indexers.includes('bludv-cardigann'));
  const sweep = plan.find((t) => t.sweep === true);
  assert.ok(br, 'a BR isolada existe no plano');
  assert.ok(sweep, 'a varredura agrupada existe e é rotulada');
  assert.equal(br.query, 'O Corvo');
  assert.equal(sweep.query, 'O Corvo', 'as duas pedem a MESMA query — o texto não distingue');
  assert.equal('sweep' in br, false, 'a BR isolada NÃO carrega a marca de varredura');
  assert.deepEqual(sweep.indexers, ['thepiratebay'], 'a varredura é só dos globais agrupados');
});

// Grouped vazio (tudo BR/isolado): não existe task AGRUPADA para anexar a
// varredura. Nenhuma task pode carregar a marca — e a BR continua principal.
test('plano: grouped vazio (todas as selecionadas BR) não cria varredura', () => {
  const plan = planJackettQueries(
    'The Crow',
    'O Corvo',
    ['bludv-cardigann', 'nerdfilmes'],
    ['bludv-cardigann', 'nerdfilmes'],
    [],
    'O Corvo',
  );
  assert.equal(plan.length, 2, 'só as duas isoladas');
  assert.equal(plan.some((t) => t.sweep === true), false, 'sem globais não há varredura agrupada');
  assert.ok(plan.every((t) => t.indexers.length === 1 && !('sweep' in t)), 'nenhuma isolada é varredura');
  assert.ok(plan.every((t) => t.query === 'O Corvo'));
});

test('collectRaw: BR principal alimenta status/fallback; varredura inline não contamina', async () => {
  const savedPtBr = config.jackett.ptBrIndexers;
  const savedIndexers = config.jackett.indexers;
  config.jackett.ptBrIndexers = ['bludv-cardigann'];
  config.jackett.indexers = ['thepiratebay', 'bludv-cardigann'];

  const calls: Array<{ query: string; indexers: string[]; recordStatus: unknown; hasOnResult: boolean }> = [];
  const userOpts = testOpts({
    providers: ['jackett'],
    jackettIndexers: ['thepiratebay', 'bludv-cardigann'],
    debridService: '',
    debridApiKey: '',
  });
  const restore = patch(jackett, 'search', async (query: string, _type: string, indexers: string[] | null, options: any) => {
    const ids = indexers || [];
    calls.push({
      query,
      indexers: ids,
      recordStatus: options?.recordStatus,
      hasOnResult: typeof options?.onQueryResult === 'function',
    });
    // Toda consulta falha: só a principal pode marcar o indexer como falho.
    options?.onQueryResult?.({ indexer: ids[0], responded: false, reason: 'error' });
    return [];
  });
  try {
    const raw: any = await runtime.run({ opts: userOpts, encoded: 'cfg-sweep-id' }, () => collectRaw(
      'The Crow', 'movie', 'tt123', 'O Corvo', matchContext() as any,
      null, 'O Corvo', null,
    ));

    const br = calls.find((c) => c.indexers.includes('bludv-cardigann'));
    const sweep = calls.find((c) => c.query === 'O Corvo' && c.indexers.includes('thepiratebay'));
    assert.ok(br, 'a BR isolada foi consultada');
    assert.equal(br.recordStatus, undefined, 'BR principal mantém o status default');
    assert.equal(br.hasOnResult, true, 'BR principal alimenta o estado vivo');
    assert.ok(sweep, 'a varredura agrupada foi consultada');
    assert.equal(sweep.recordStatus, false, 'varredura inline não registra status');
    assert.equal(sweep.hasOnResult, false, 'varredura inline não contamina o estado vivo');
    // A falha da BR principal dispara o fallback mesmo com a query idêntica à
    // da varredura: era exatamente isso que a inferência por texto escondia.
    assert.equal(raw.live.failedIndexers().has('bludv-cardigann'), true, 'falha da BR vira candidato do fallback');
    assert.equal(raw.sweepInline, true, 'a varredura agrupada foi anexada e liga sweepInline');
  } finally {
    restore();
    config.jackett.ptBrIndexers = savedPtBr;
    config.jackett.indexers = savedIndexers;
  }
});

test('collectRaw: grouped vazio (só BR) não liga sweepInline e não perde a principal', async () => {
  const savedPtBr = config.jackett.ptBrIndexers;
  const savedIndexers = config.jackett.indexers;
  config.jackett.ptBrIndexers = ['bludv-cardigann'];
  config.jackett.indexers = ['bludv-cardigann'];

  const calls: Array<{ query: string; indexers: string[]; recordStatus: unknown; hasOnResult: boolean }> = [];
  const userOpts = testOpts({
    providers: ['jackett'],
    jackettIndexers: ['bludv-cardigann'],
    debridService: '',
    debridApiKey: '',
  });
  const restore = patch(jackett, 'search', async (query: string, _type: string, indexers: string[] | null, options: any) => {
    const ids = indexers || [];
    calls.push({
      query,
      indexers: ids,
      recordStatus: options?.recordStatus,
      hasOnResult: typeof options?.onQueryResult === 'function',
    });
    options?.onQueryResult?.({ indexer: ids[0], responded: false, reason: 'error' });
    return [];
  });
  try {
    const raw: any = await runtime.run({ opts: userOpts, encoded: 'cfg-sweep-all-br' }, () => collectRaw(
      'The Crow', 'movie', 'tt124', 'O Corvo', matchContext() as any,
      null, 'O Corvo', null,
    ));
    assert.equal(raw.sweepInline, false, 'sem globais a varredura inline não rodou');
    assert.equal(calls.length, 1, 'só a BR principal é consultada');
    assert.deepEqual(calls[0].indexers, ['bludv-cardigann']);
    assert.equal(calls[0].recordStatus, undefined, 'principal mantém o status default');
    assert.equal(calls[0].hasOnResult, true, 'principal alimenta o estado vivo');
    assert.equal(raw.live.failedIndexers().has('bludv-cardigann'), true, 'e o fallback');
  } finally {
    restore();
    config.jackett.ptBrIndexers = savedPtBr;
    config.jackett.indexers = savedIndexers;
  }
});
