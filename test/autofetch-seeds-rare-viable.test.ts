// Piso de seeders do pool seeds do Chupim: o complemento RELAXADO depois do
// estrito. A régua TS (`autofetch-seeds-pool.ts`) saiu na leva B4 e quem decide
// é `adom-core::autofetch_seeds_pick` pelo lote napi (`decideAutofetch`).
//
// Regra (dois regimes, `minSeeders > 1`):
// - estrito VAZIO  ⇒ o relaxado preenche a capacidade TOTAL (imediato + fila);
// - estrito PARCIAL ⇒ o relaxado completa só as vagas IMEDIATAS que faltam.
// O estrito vem primeiro na ordem: o relaxado nunca passa na frente de quem já
// cumpre o piso.
//
// Oráculo Rust: `cargo test -p adom-core autofetch_seeds_pick`
// (`complemento_relaxado_preenche_vagas`).
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

function seeds(seed: string, seeders: number): AutofetchRawStream {
  const title = 'Filme 2020 1080p';
  return { infoHash: hx(seed), title, name: title, _quality: '1080p', _seeders: seeders, _size: 2 * GB };
}

const hashes = (items: Array<{ stream: { infoHash?: string } }>) => items.map((i) => String(i.stream.infoHash));

test('estrito PARCIAL: o relaxado completa só a vaga imediata que falta', () => {
  // Piso 5: só "a" (10) cumpre. Capacidade imediata 2 ⇒ cabe 1 relaxado.
  const pick = decideAutofetch(capture([seeds('a', 10), seeds('b', 1)], {
    live: { autoFetchMinSeeders: 5, autoFetchTopSeedsMax: 2 },
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')], 'o estrito vem primeiro');
  assert.deepEqual(pick.queue, [], 'queueDepth 0: nada sobra');
});

test('estrito PARCIAL: o relaxado respeita a ordem do enxame e não transborda', () => {
  // Piso 5: só "a" (20) cumpre. Relaxados disponíveis: 2 e 1 — só UM entra.
  const pick = decideAutofetch(capture([seeds('a', 20), seeds('b', 2), seeds('c', 1)], {
    live: { autoFetchMinSeeders: 5, autoFetchTopSeedsMax: 2 },
    queueDepth: 2,
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')], 'um estrito + um relaxado');
  assert.deepEqual(pick.queue, [], 'o relaxado não usa a profundidade da fila no regime parcial');
});

test('estrito VAZIO: o relaxado preenche a capacidade TOTAL (imediatos + fila)', () => {
  // Nenhum cumpre o piso 5 ⇒ capacidade = 2 (imediato) + 2 (fila) = 4.
  const pick = decideAutofetch(capture([seeds('a', 3), seeds('b', 2), seeds('c', 1)], {
    live: { autoFetchMinSeeders: 5, autoFetchTopSeedsMax: 2 },
    queueDepth: 2,
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')]);
  assert.deepEqual(hashes(pick.queue), [hx('c')], 'o excedente relaxado desce para a fila');
  assert.deepEqual(pick.queue.map((q) => q.pool), ['seeds']);
});

test('raro + piso alto: o limite raro vale também para o complemento', () => {
  // Piso 5 e swarm fraco: o raro eleva o limite para 4; estrito = "a" (6),
  // então o relaxado completa até 4 com "b" e "c".
  const pick = decideAutofetch(capture([seeds('a', 6), seeds('b', 3), seeds('c', 2)], {
    live: {
      autoFetchMinSeeders: 5,
      autoFetchTopSeedsMax: 2,
      autoFetchRareMax: 4,
      autoFetchRareThreshold: 3,
      autoFetchRareMaxSeeders: 50,
    },
    queueDepth: 2,
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b'), hx('c')]);
  assert.deepEqual(pick.immediate.map((i) => i.rare), [true, true, true]);
  assert.deepEqual(pick.immediate.map((i) => i.slotLimit), [4, 4, 4], 'slotLimit é o limite raro');
});

test('piso 1 não abre complemento: todos já estão no estrito', () => {
  const pick = decideAutofetch(capture([seeds('a', 9), seeds('b', 8)], {
    live: { autoFetchMinSeeders: 1, autoFetchTopSeedsMax: 2 },
  }));
  assert.deepEqual(hashes(pick.immediate), [hx('a'), hx('b')]);
  assert.deepEqual(pick.immediate.map((i) => i.rare), [false, false]);
});
