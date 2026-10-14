// Fase 0 do índice — atribuição do desperdício. Consulta com matchContext cuja
// resposta INTEIRA morre no filtro conta em balde do CAMINHO DE RESPOSTA quando
// é a busca crítica, e em balde de FUNDO quando é descoberta (colhedor
// alimentando o índice, varredura/enriquecimento de cauda). Sem a separação, o
// aquecimento de fundo pintava "a resposta queimou o que o índice deveria ter
// servido" — medido ao vivo: 137 wastes com ZERO buscas de usuário no processo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as metrics from '../src/utils/metrics.js';
import type { MatchContext } from '../types/domain.js';
import { withMockFetch } from './e2e/e2e-harness.js';

const saved = { apiKey: config.jackett.apiKey };

before(() => {
  config.jackett.apiKey = 'test-jackett-key';
});

after(() => {
  config.jackett.apiKey = saved.apiKey;
});

const CONTEXT: MatchContext = {
  names: ['Test Title'],
  year: 2024,
  isSeries: false,
  season: null,
  episode: null,
};

// Indexer que responde SEM nenhum item da obra: a sonda negativa do colhedor.
// O atraso no json() garante ms > 0 — o contador só aceita tempo medido de
// verdade (fromCache e rejeição ficam de fora por contrato).
function unrelatedRoute() {
  return {
    match: '/api/v2.0/indexers/',
    handler: () => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => setTimeout(() => resolve({
        Results: [{
          Title: 'Completely Unrelated Show 2019 1080p',
          InfoHash: 'ab'.repeat(20),
          Seeders: 5,
        }],
      }), 12)),
    }),
  };
}

function countersOf(snapshot: ReturnType<typeof metrics.snapshot>) {
  return snapshot.counters as Record<string, number>;
}

function delta(counters: Record<string, number>, before: Record<string, number>, name: string) {
  return (counters[name] || 0) - (before[name] || 0);
}

test('resposta inteira filtrada no caminho crítico conta em wastedQueries', async () => {
  const before = countersOf(metrics.snapshot());
  await withMockFetch([unrelatedRoute()], async () => {
    await jackett.search('Test Title 2024', 'movie', ['fake-wasted-critical'], {
      matchContext: CONTEXT,
      recordStatus: false,
      skipResolve: true,
    });
  });
  const counters = countersOf(metrics.snapshot());
  assert.equal(delta(counters, before, 'search.jackett.wastedQueries'), 1);
  assert.ok(delta(counters, before, 'search.jackett.wastedMs') > 0, 'ms medidos entram no balde da resposta');
  assert.equal(delta(counters, before, 'search.jackett.wastedQueries.background'), 0);
  assert.equal(delta(counters, before, 'search.jackett.wastedMs.background'), 0);
});

test('resposta inteira filtrada em consulta de fundo NÃO pinta o balde da resposta', async () => {
  const before = countersOf(metrics.snapshot());
  await withMockFetch([unrelatedRoute()], async () => {
    await jackett.search('Outra Obra 2024', 'movie', ['fake-wasted-background'], {
      matchContext: { ...CONTEXT, names: ['Outra Obra'] },
      recordStatus: false,
      skipResolve: true,
      background: true,
    });
  });
  const counters = countersOf(metrics.snapshot());
  assert.equal(delta(counters, before, 'search.jackett.wastedQueries.background'), 1);
  assert.ok(delta(counters, before, 'search.jackett.wastedMs.background') > 0);
  assert.equal(delta(counters, before, 'search.jackett.wastedQueries'), 0);
  assert.equal(delta(counters, before, 'search.jackett.wastedMs'), 0);
});

test('resposta com sobrevivente não conta desperdício em balde nenhum', async () => {
  const before = countersOf(metrics.snapshot());
  await withMockFetch([{
    match: '/api/v2.0/indexers/',
    handler: () => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => setTimeout(() => resolve({
        Results: [{
          Title: 'Test Title 2024 1080p DUBLADO',
          InfoHash: 'cd'.repeat(20),
          Seeders: 30,
        }],
      }), 12)),
    }),
  }], async () => {
    await jackett.search('Test Title 2024', 'movie', ['fake-wasted-survivor'], {
      matchContext: CONTEXT,
      recordStatus: false,
      skipResolve: true,
    });
  });
  const counters = countersOf(metrics.snapshot());
  assert.equal(delta(counters, before, 'search.jackett.wastedQueries'), 0);
  assert.equal(delta(counters, before, 'search.jackett.wastedQueries.background'), 0);
});
