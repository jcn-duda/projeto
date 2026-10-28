// Regime RARO do pool seeds do Chupim — a régua TS (`autofetch-seeds-pool.ts`)
// saiu na leva B4; a decisão é do lote napi (`adom-core::autofetch_seeds_pick`
// via `decideAutofetch`). O que se prova aqui é o que a BUSCA enxerga:
// quantos imediatos saem, com que `rare`/`slotLimit` e o que sobra na fila.
//
// Oráculo Rust da mesma régua: `cargo test -p adom-core autofetch_seeds_pick`
// (`raro_ativa_com_poucos_viaveis_fracos`, `seleciona_por_swarm_decrescente`).
//
// Captura sintética: streams não-BR e não-dublados, `any` desligado e pt-first
// desligado — o pool vencedor é sempre `seeds`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideAutofetch } from '../src/utils/rust-autofetch.js';
import type { AutofetchCapture, AutofetchRawStream } from '../src/utils/rust-autofetch.js';

const GB = 1024 ** 3;
const hx = (seed: string) => seed.repeat(40).slice(0, 40);

type Opts = {
  live?: Partial<AutofetchCapture['live']>;
  queueDepth?: number;
};

function capture(streams: AutofetchRawStream[], o: Opts = {}): AutofetchCapture & { streams: AutofetchRawStream[] } {
  return {
    streams,
    season: null,
    queueDepth: o.queueDepth ?? 0,
    live: {
      autoFetchMinSeeders: 1,
      autoFetchSeedsPtFirst: false,
      autoFetchMax: 3,
      autoFetchTopSeedsMax: 2,
      autoFetchRareMax: 0,
      autoFetchRareThreshold: 0,
      autoFetchRareMaxSeeders: 0,
      autoFetchAnyDubbed: false,
      autoFetchTopSeeds: true,
      ...o.live,
    },
    policy: { dubbedOnly: false, cachedOnly: false, maxSizeGb: 0, seedsMaxGb: 0, seedsMaxQuality: '1080p' },
    autoFetchBr: true,
    adapter: { cacheCheck: true },
    seedsBlocked: false,
  };
}

function seeds(seed: string, seeders: number | undefined, o: { name?: string; viable?: boolean } = {}): AutofetchRawStream {
  const title = 'Filme 2020 1080p';
  return {
    infoHash: hx(seed),
    title,
    name: o.name ?? title,
    _quality: '1080p',
    ...(seeders != null ? { _seeders: seeders } : {}),
    _size: 2 * GB,
    ...(o.viable === false ? { _seedFloorWaived: true } : {}),
  };
}

const hashes = (items: Array<{ stream: { infoHash?: string } }>) => items.map((i) => String(i.stream.infoHash));

/** Swarm fraco (poucos candidatos, melhor abaixo do teto de seeders). */
const fraco = () => [seeds('a', 4), seeds('b', 3), seeds('c', 2)];

test('raro sobe o limite imediato para rareMax quando há poucos candidatos fracos', () => {
  const pick = decideAutofetch(capture(fraco(), {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 5, autoFetchRareThreshold: 3, autoFetchRareMaxSeeders: 20 },
    queueDepth: 2,
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b'), hx('c')], 'rareMax=5 libera os 3');
  assert.deepEqual(pick.immediate.map((i) => i.rare), [true, true, true], 'a evidência rara acompanha o imediato');
  assert.deepEqual(pick.immediate.map((i) => i.slotLimit), [5, 5, 5], 'slotLimit é o limite elevado');
  assert.deepEqual(pick.queue, [], 'sem excedente: os 3 cabem no limite raro');
});

test('threshold 0 desliga o regime raro', () => {
  const pick = decideAutofetch(capture(fraco(), {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 5, autoFetchRareThreshold: 0, autoFetchRareMaxSeeders: 20 },
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')], 'volta ao teto comum');
  assert.deepEqual(pick.immediate.map((i) => i.rare), [false, false]);
  assert.deepEqual(pick.immediate.map((i) => i.slotLimit), [2, 2]);
});

test('rareMax que não supera topSeedsMax não tem efeito', () => {
  const pick = decideAutofetch(capture(fraco(), {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 2, autoFetchRareThreshold: 3, autoFetchRareMaxSeeders: 20 },
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')]);
  assert.deepEqual(pick.immediate.map((i) => i.rare), [false, false]);
});

test('universo maior que o limiar NÃO é título raro', () => {
  const quatro = [seeds('a', 4), seeds('b', 3), seeds('c', 2), seeds('d', 1)];
  const pick = decideAutofetch(capture(quatro, {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 5, autoFetchRareThreshold: 3, autoFetchRareMaxSeeders: 20 },
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')], '4 candidatos > limiar 3');
  assert.deepEqual(pick.immediate.map((i) => i.rare), [false, false]);
});

test('enxame saudável não é raro: o MELHOR acima do teto termina sozinho', () => {
  const forte = [seeds('a', 50), seeds('b', 40), seeds('c', 30)];
  const pick = decideAutofetch(capture(forte, {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 5, autoFetchRareThreshold: 3, autoFetchRareMaxSeeders: 20 },
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')]);
  assert.deepEqual(pick.immediate.map((i) => i.rare), [false, false]);
});

test('`👤 N` do nome entra na régua do raro quando `_seeders` falta', () => {
  // Sem `_seeders`, o `top` cai no `👤` do name: aqui o "melhor" é 50, ou seja
  // enxame saudável — se o nome fosse ignorado o melhor seria 1 e o regime raro
  // ativaria, elevando o limite e marcando `rare`.
  const streams = [
    seeds('a', undefined, { name: 'Filme 2020 1080p 👤 50' }),
    seeds('b', 1),
  ];
  const raro = decideAutofetch(capture(streams, {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 5, autoFetchRareThreshold: 3, autoFetchRareMaxSeeders: 20 },
  }));
  assert.deepEqual(raro.immediate.map((i) => i.rare), [false, false], '👤 50 lido ⇒ não é raro');
  assert.deepEqual(raro.immediate.map((i) => i.slotLimit), [2, 2]);

  // O par: com o MESMO nome fraco o regime ativa — prova que o número veio do name.
  const fracoNome = decideAutofetch(capture([
    seeds('a', undefined, { name: 'Filme 2020 1080p 👤 4' }),
    seeds('b', 1),
  ], {
    live: { autoFetchTopSeedsMax: 2, autoFetchRareMax: 5, autoFetchRareThreshold: 3, autoFetchRareMaxSeeders: 20 },
  }));
  assert.deepEqual(fracoNome.immediate.map((i) => i.rare), [true, true]);
});

test('excedente do pool seeds vai para a fila com o slotLimit do limite imediato', () => {
  const cinco = [seeds('a', 9), seeds('b', 8), seeds('c', 7), seeds('d', 6), seeds('e', 5)];
  const pick = decideAutofetch(capture(cinco, { live: { autoFetchTopSeedsMax: 2 }, queueDepth: 2 }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')]);
  assert.deepEqual(hashes(pick.queue), [hx('c'), hx('d')], 'os dois seguintes esperam na fila');
  assert.deepEqual(pick.queue.map((q) => q.pool), ['seeds', 'seeds'], 'a fila nasce do MESMO pool');
  assert.deepEqual(pick.queue.map((q) => q.slotLimit), [2, 2]);
});

test('stream inviável (`_seedFloorWaived`) fica fora do pool seeds', () => {
  const streams = [seeds('a', 9, { viable: false }), seeds('b', 1)];
  const pick = decideAutofetch(capture(streams, { live: { autoFetchTopSeedsMax: 2 } }));
  assert.deepEqual(hashes(pick.immediate), [hx('b')], 'o waiver do piso barra o mais semeado');
});
