// Extensão C4 (commit 3): a aba cache do painel lê a foto nativa do gateway —
// hit-rate do `streams.db` quando medido; '—' sem fonte (nunca 0% falso); card
// nativo com o staleServed de verdade; cards locais rotulados "local (Node)".
//
// Puro render: `cacheSummary`/`cacheCards` são funções puras sobre o payload do
// `/dashboard-status.json`, então este teste não sobe servidor — a rota com a
// ponte real da 8711 é coberta em `dashboard-cache-block.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cacheSummary, cacheCards } from '../src/client/painel/view-cache.js';
import { vnodeText } from './helpers/vnode-text.js';

test('cacheSummary: hit-rate do gateway vence; sem consultas é null (nunca 0)', () => {
  // O gateway mediu: mesmo com contadores locais zerados, o rate vem de lá.
  const nativo = cacheSummary({ hits: 0, misses: 0, native: { source: 'gateway', hitRate: 0.82 } });
  assert.ok(Math.abs(nativo.hitRate! - 0.82) < 1e-9);
  assert.equal(nativo.hitRateSource, 'gateway');
  assert.equal(nativo.native?.source, 'gateway');

  // Sem gateway e sem consultas: null — '—' no card, nunca 0% falso.
  const semFonte = cacheSummary({ entries: 5, maxEntries: 1000 });
  assert.equal(semFonte.hitRate, null);
  assert.equal(semFonte.hitRateSource, null);

  // Consultas locais reais continuam sendo medida honesta (não é o 0% falso):
  // só perdem para o gateway.
  const local = cacheSummary({ hits: 450, misses: 50 });
  assert.ok(Math.abs(local.hitRate! - 0.9) < 1e-9);
  assert.equal(local.hitRateSource, 'local');
});

test('ViewCache render: sem fonte nativa o hit-rate é "—" e o card do gateway não existe', () => {
  const text = vnodeText(cacheCards({ entries: 5, maxEntries: 1000, hits: 0, misses: 0 }));
  assert.match(text, /—/, 'sem medição o card mostra traço, não zero');
  assert.doesNotMatch(text, /0% HIT/, 'nunca 0% falso');
  assert.doesNotMatch(text, /Store nativo/, 'sem ponte, o card nativo é omitido');
  assert.match(text, /local \(Node\)/, 'os cards locais ficam rotulados');
});

test('ViewCache render: com a foto nativa, hit-rate do gateway e staleServed no card', () => {
  const text = vnodeText(cacheCards({
    entries: 5, maxEntries: 1000, hits: 0, misses: 0,
    native: {
      source: 'gateway', entries: 12, quota: 5000, hit: 40,
      staleServed: 3, miss: 9, writes: 77, hitRate: 0.82, degraded: false,
    },
  }));
  assert.match(text, /82% HIT \(gateway\)/, 'o badge traz o hit-rate do gateway com a nota');
  assert.match(text, /Store nativo \(gateway\)/);
  assert.match(text, /SWR servido stale:\s+3/, 'o staleServed é o SWR de verdade');
  assert.match(text, /escritas:\s+77/);
  assert.doesNotMatch(text, /degradado/, 'gateway saudável não acende o aviso');
});

test('ViewCache render: gateway degradado acende o aviso e o badge warn', () => {
  const text = vnodeText(cacheCards({
    native: { source: 'gateway', degraded: true, staleServed: 9, writes: 2 },
  }));
  assert.match(text, /degradado/);
  assert.match(text, /SWR servido stale:\s+9/);
});
