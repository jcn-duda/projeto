// Vitals por site (Fase 4.1 ritmo real/429; Fase 2.1 "link expirado") são
// computados sobre a FOTO que o engine guarda — o Node não abre o `crawl.db`.
// O stub abaixo imita só o verbo que o vitals usa (`listByStatus`); o resto do
// engine é irrelevante aqui, e a ausência de `snapshotAt` prova o fail-open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSiteVitals,
  isExpiredLink,
  isHttp429,
  HOUR_MS,
  VITALS_LIST_LIMIT,
  type SiteVitals,
} from '../src/providers/crawl-vitals.js';
import type { CrawlReadEngine } from '../src/providers/crawl-read-engine.js';
import type { CrawlUrlRow, CrawlUrlStatus } from '../src/providers/crawl-types.js';

const NOW = 1_700_000_000_000;

function row(over: Partial<CrawlUrlRow> = {}): CrawlUrlRow {
  return {
    site: 'bludv-cardigann',
    url: 'https://x/a',
    lastmod: '',
    kind: 'movie',
    status: 'done',
    imdb: null,
    tries: 0,
    nextAt: 0,
    checkedAt: NOW,
    releases: 0,
    error: '',
    progress: '',
    addedAt: 0,
    ...over,
  };
}

/** Engine falso: cada status devolve a lista gravada. A foto real corta cada
 * lista no `limit` do pedido — o stub entrega o que o teste montar. */
function fakeEngine(byStatus: Partial<Record<CrawlUrlStatus, CrawlUrlRow[]>>): CrawlReadEngine {
  return {
    listByStatus: (site: string, status: CrawlUrlStatus) => byStatus[status] ?? [],
  } as unknown as CrawlReadEngine;
}

test('ritmo real: checkedAt na última hora, somando as listas que a foto expõe', () => {
  const engine = fakeEngine({
    done: [row({ url: 'a', checkedAt: NOW - 60_000 }), row({ url: 'b', checkedAt: NOW - 2 * HOUR_MS })],
    'no-work': [row({ url: 'c', status: 'no-work', checkedAt: NOW - 30_000 })],
    partial: [row({ url: 'd', status: 'partial', checkedAt: 0 })],
    error: [row({ url: 'e', status: 'error', error: 'timeout' })],
  });
  const vitals = buildSiteVitals(engine, 'bludv-cardigann', NOW);
  assert.equal(vitals.pagesLastHour, 3, 'página checada é atividade em qualquer lista; velha e nunca-checada não contam');
  assert.equal(vitals.pagesSample, 5);
  assert.equal(vitals.pagesSaturated, false, 'amostra pequena não satura');
});

test('429 conta pelo CAMPO error com detalhe livre, total e última hora', () => {
  const engine = fakeEngine({
    done: [row({ url: 'a', error: 'http_429' })],
    error: [
      row({ url: 'b', status: 'error', error: 'http_429_backoff_15s', checkedAt: NOW - 60_000 }),
      row({ url: 'c', status: 'error', error: 'HTTP_429 retry', checkedAt: NOW - 2 * HOUR_MS }),
      row({ url: 'd', status: 'error', error: 'timeout' }),
    ],
  });
  const vitals = buildSiteVitals(engine, 'bludv-cardigann', NOW);
  assert.deepEqual(vitals.http429, { total: 3, lastHour: 2 }, "LIKE 'http_429%' por error, case-insensível, janela de 1h");
  assert.equal(vitals.expired.total, 0);
});

test('taxa de "link expirado" é substring no error (o texto do portão varia)', () => {
  assert.equal(isHttp429('http_429'), true);
  assert.equal(isHttp429('timeout'), false);
  assert.equal(isExpiredLink('link expirado no portão'), true);
  assert.equal(isExpiredLink('expirado: retry'), true);
  assert.equal(isExpiredLink('timeout'), false);

  const engine = fakeEngine({
    error: [
      row({ url: 'a', status: 'error', error: 'link expirado no portão', checkedAt: NOW - 60_000 }),
      row({ url: 'b', status: 'error', error: 'link expirado no portão', checkedAt: NOW - 2 * HOUR_MS }),
    ],
  });
  const vitals = buildSiteVitals(engine, 'bludv-cardigann', NOW);
  assert.deepEqual(vitals.expired, { total: 2, lastHour: 1 });
});

test('amostra inteira na janela: o ritmo é um piso (o cliente mostra "≥")', () => {
  const pages = (n: number, checkedAt: number) =>
    Array.from({ length: n }, (_, i) => row({ url: `p${i}`, checkedAt }));

  const saturado = buildSiteVitals(fakeEngine({ done: pages(VITALS_LIST_LIMIT, NOW - 60_000) }), 's', NOW);
  assert.equal(saturado.pagesSaturated, true, 'amostra no teto e toda na janela');

  const velho = buildSiteVitals(fakeEngine({ done: pages(VITALS_LIST_LIMIT, NOW - 2 * HOUR_MS) }), 's', NOW);
  assert.equal(velho.pagesSaturated, false, 'amostra cheia mas velha: medição fechada');

  const curto = buildSiteVitals(fakeEngine({ done: pages(VITALS_LIST_LIMIT - 1, NOW - 60_000) }), 's', NOW);
  assert.equal(curto.pagesSaturated, false, 'amostra menor que o corte não satura');
});

test('site sem foto volta zerado e o engine mínimo (sem snapshotAt) não quebra', () => {
  const vitals = buildSiteVitals(fakeEngine({}), 'nunca', NOW);
  assert.deepEqual(vitals, {
    pagesLastHour: 0,
    pagesSample: 0,
    pagesSaturated: false,
    http429: { total: 0, lastHour: 0 },
    expired: { total: 0, lastHour: 0 },
  } satisfies SiteVitals);
});
