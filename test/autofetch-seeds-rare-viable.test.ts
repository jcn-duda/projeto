// --- Título raro: contagem de VIÁVEIS e interação com a fila (queueDepth) ---
//
// Regressão do review do commit 22680a2: o universo raro cortava
// `threshold+1` ANTES de aplicar `viableOnce`. Com inviáveis no topo, viáveis
// abaixo do corte desapareciam da contagem — título comum virava raro por
// subcontagem e o limite imediato subia à toa. O corte agora junta
// threshold+1 VIÁVEIS antes de decidir.
//
// Testes unitários diretos de pickSeedsPool (array em memória, sem rede):
// a métrica `autofetch.seed-floor-skipped` é contada dentro do `viable` do
// runner, então o memo é provado contando chamadas por hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as metrics from '../src/utils/metrics.js';
import { pickSeedsPool } from '../src/providers/autofetch-seeds-pool.js';
import type { Stream } from '../types/domain.js';

const counter = (key: string) => metrics.snapshot().counters[key] || 0;

const mk = (p: string, seeders: number) => ({
  infoHash: p.repeat(40),
  name: `Rare Viable 1988 Rip ${p.toUpperCase()}`,
  title: `Rare Viable 1988 Rip ${p.toUpperCase()}`,
  _seeders: seeders,
});

const LIVE = { autoFetchMinSeeders: 3, autoFetchTopSeedsMax: 2, autoFetchSeedsPtFirst: true };

test('raro: viáveis abaixo de inviáveis no topo contam no limiar (não ativa raro por subcontagem)', () => {
  // threshold=3: 2 inviáveis no topo + 4 viáveis = universo viável 4 > 3 —
  // NÃO é raro. O corte antigo em threshold+1=4 devolvia [inv1, inv2, v1, v2]
  // e, filtrado, via só 2 viáveis: disparava raro errado.
  const inv1 = mk('a', 8);
  const inv2 = mk('b', 7);
  const v1 = mk('c', 6);
  const v2 = mk('d', 5);
  const v3 = mk('e', 4);
  const v4 = mk('f', 2);
  const inviaveis = new Set([inv1.infoHash, inv2.infoHash]);
  const calls = new Map<string, number>();
  const viable = (s: Stream) => {
    const h = String((s as any).infoHash);
    calls.set(h, (calls.get(h) || 0) + 1);
    return !inviaveis.has(h);
  };
  const dRare = counter('autofetch.seeds.rare');
  const { candidates, immediateLimit } = pickSeedsPool(
    [inv1, inv2, v1, v2, v3, v4] as any[],
    LIVE,
    { queueDepth: 0, viable, rare: { max: 4, threshold: 3, maxSeeders: 10 } },
  );
  assert.equal(immediateLimit, 2, 'universo viável (4) passa do limiar (3): limite segue TOP_SEEDS_MAX');
  assert.equal(counter('autofetch.seeds.rare'), dRare, 'regime raro NÃO dispara');
  assert.deepEqual(
    candidates.map((s) => s.infoHash),
    [v1.infoHash, v2.infoHash],
    'sem raro: TOP_SEEDS_MAX=2 leva os dois melhores VIÁVEIS (os inviáveis do topo não escondem ninguém)',
  );
  assert.equal(new Set(candidates.map((s) => s.infoHash)).size, candidates.length, 'sem hash duplicado');
  assert.equal(calls.size, 6, 'todos os 6 streams foram avaliados uma vez');
  for (const n of calls.values()) assert.equal(n, 1, 'memo: nenhum stream avaliado duas vezes (seed-floor-skipped não duplica)');
});

test('raro × fila: limite imediato RARE_MAX, capacidade até queueDepth, dedupe e ordem', () => {
  // 3 viáveis (<= threshold 3, melhor 6 < maxSeeders 10): raro → imediato sobe
  // para RARE_MAX=4. Dois estritos (>=3 seeders) + o fraco entra como
  // complemento relaxado na vaga imediata que faltou (capacity = 4 - 2).
  const v1 = mk('c', 6);
  const v2 = mk('d', 5);
  const fraco = mk('f', 2);
  const viable = () => true;
  const dRare = counter('autofetch.seeds.rare');
  const { candidates, immediateLimit } = pickSeedsPool(
    [v1, v2, fraco] as any[],
    LIVE,
    { queueDepth: 3, viable, rare: { max: 4, threshold: 3, maxSeeders: 10 } },
  );
  assert.equal(immediateLimit, 4, 'título raro sobe o limite imediato para RARE_MAX');
  assert.equal(counter('autofetch.seeds.rare'), dRare + 1, 'regime raro fica mensurado');
  // seedsLimit = RARE_MAX 4 + queueDepth 3 = 7 é o teto do pick; com só 3
  // candidatos, tudo entra — no strict PARCIAL a fila não recebe lote fraco.
  assert.equal(candidates.length, 3, 'estritos + relaxado, dentro de seedsLimit');
  assert.deepEqual(
    candidates.map((s) => (s as any)._seeders),
    [6, 5, 2],
    'estritos primeiro (ordem do swarm), depois o relaxado',
  );
  assert.equal(new Set(candidates.map((s) => s.infoHash)).size, candidates.length, 'sem hash duplicado entre estritos e relaxado');
});

test('raro × fila (strict vazio): excedentes EXATOS de queueDepth, com ordem e dedupe', () => {
  // Nenhum estrito (todos 1-2 seeders < minSeeders 3) e 6 viáveis <= threshold
  // 6: raro → imediato = RARE_MAX 4. No strict VAZIO o relaxado preenche a
  // capacidade TOTAL (seedsLimit = 4 + 2 = 6): 6 candidatos entram e o runner
  // dispara 4 imediatos + enfileira EXATAMENTE queueDepth=2 excedentes.
  const ws = [
    mk('h', 2), mk('i', 2), mk('j', 2), mk('k', 1), mk('l', 1), mk('m', 1),
  ];
  const viable = () => true;
  const dRare = counter('autofetch.seeds.rare');
  const { candidates, immediateLimit } = pickSeedsPool(
    ws as any[],
    LIVE,
    { queueDepth: 2, viable, rare: { max: 4, threshold: 6, maxSeeders: 10 } },
  );
  assert.equal(immediateLimit, 4, 'raro mesmo com strict vazio: imediato sobe para RARE_MAX');
  assert.equal(counter('autofetch.seeds.rare'), dRare + 1, 'regime raro fica mensurado');
  assert.equal(candidates.length, 6, 'candidates ultrapassa o limite imediato (4): fila participa');
  assert.equal(candidates.length - immediateLimit, 2, 'exatamente queueDepth excedentes para a fila');
  assert.deepEqual(
    candidates.map((s) => (s as any)._seeders),
    [2, 2, 2, 1, 1, 1],
    'ordem por swarm preservada no fallback',
  );
  assert.equal(new Set(candidates.map((s) => s.infoHash)).size, candidates.length, 'sem duplicado');
});

test('raro: stream SEM _seeders com enxame saudável no nome não é raro (regra 👤 N do pool)', () => {
  // Mesma regra de seeders do topSeededPool: `_seeders` ?? "👤 N" do nome.
  // Sem _seeders e "👤 59" no nome: melhor = 59 >= maxSeeders 10 → NÃO raro.
  const saudavel = {
    infoHash: 'a'.repeat(40),
    name: 'Rare Fallback 1988 BluRay 👤 59',
    title: 'Rare Fallback 1988 BluRay',
  };
  const fraco = {
    infoHash: 'b'.repeat(40),
    name: 'Rare Fallback 1988 VHSRip 👤 1',
    title: 'Rare Fallback 1988 VHSRip',
  };
  const dRare = counter('autofetch.seeds.rare');
  const r = pickSeedsPool(
    [saudavel, fraco] as any[],
    LIVE,
    { queueDepth: 0, viable: () => true, rare: { max: 4, threshold: 3, maxSeeders: 10 } },
  );
  assert.equal(r.immediateLimit, 2, 'enxame saudável no nome termina sozinho: sem regime raro');
  assert.equal(counter('autofetch.seeds.rare'), dRare, 'fallback do nome vence: raro não dispara');
  // Espelho: sem _seeders e "👤 1" no nome, o melhor é fraco → raro dispara.
  const r2 = pickSeedsPool(
    [fraco, { ...saudavel, name: 'Rare Fallback 1988 BluRay 👤 2', infoHash: 'c'.repeat(40) }] as any[],
    LIVE,
    { queueDepth: 0, viable: () => true, rare: { max: 4, threshold: 3, maxSeeders: 10 } },
  );
  assert.equal(r2.immediateLimit, 4, 'fallback 👤 N fraco ativa o regime raro');
});
