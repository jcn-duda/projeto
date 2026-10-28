// Política do pool `seeds` do Chupim — a régua TS (`autofetch-policy.ts`) saiu
// na leva B4 e quem decide agora é `adom-core::autofetch_policy`, chamado pelo
// lote napi (`evaluateAutofetchCandidates`) através do `decideAutofetch`.
// O que este arquivo prova é a POLÍTICA INTRÍNSECA vista pela decisão real:
// faixa máxima, REMUX, qualidade desconhecida, tamanho desconhecido e o teto de
// tamanho (`min(seedsMaxGb, maxSizeGb)`). O oráculo Rust da mesma régua é o
// `cargo test -p adom-core --test autofetch_policy_golden` (caso a caso, função
// por função); aqui se prova que a decisão da busca respeita a mesma régua.
//
// Captura sintética: os streams NÃO são BR nem dublados, `any` está desligado e
// o pt-first também — assim quem responde é sempre o pool seeds, e qualquer
// ausência na lista de imediatos é a política recusando, não outro pool
// vencendo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideAutofetch } from '../src/utils/rust-autofetch.js';
import type { AutofetchCapture, AutofetchRawStream } from '../src/utils/rust-autofetch.js';

const GB = 1024 ** 3;
const hx = (seed: string) => seed.repeat(40).slice(0, 40);

type Opts = {
  live?: Partial<AutofetchCapture['live']>;
  policy?: Partial<AutofetchCapture['policy']>;
  queueDepth?: number;
  seedsBlocked?: boolean;
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
      autoFetchTopSeedsMax: 3,
      autoFetchRareMax: 0,
      autoFetchRareThreshold: 0,
      autoFetchRareMaxSeeders: 0,
      autoFetchAnyDubbed: false,
      autoFetchTopSeeds: true,
      ...o.live,
    },
    policy: {
      dubbedOnly: false,
      cachedOnly: false,
      maxSizeGb: 0,
      seedsMaxGb: 0,
      seedsMaxQuality: '1080p',
      ...o.policy,
    },
    // `canAutoFetchBr` exige toggle + uma trava confiável (cacheCheck).
    autoFetchBr: true,
    adapter: { cacheCheck: true },
    seedsBlocked: o.seedsBlocked ?? false,
  };
}

/** Stream global (não-BR) cru, do jeito que o pipeline entrega ao Chupim. */
function seeds(
  seed: string,
  title: string,
  o: { quality?: string; seeders?: number; size?: number; pack?: number; name?: string } = {},
): AutofetchRawStream {
  return {
    infoHash: hx(seed),
    title,
    name: o.name ?? title,
    ...(o.quality != null ? { _quality: o.quality } : {}),
    ...(o.seeders != null ? { _seeders: o.seeders } : {}),
    ...(o.size != null ? { _size: o.size } : {}),
    ...(o.pack != null ? { _packBytes: o.pack } : {}),
  };
}

function picked(streams: AutofetchRawStream[], o: Opts = {}): string[] {
  return decideAutofetch(capture(streams, o)).immediate.map((item) => String(item.stream.infoHash));
}

// O controle (720p, 1 GB, 5 seeders) é o que SEMPRE sobra: os concorrentes
// abaixo têm MAIS seeders, então se algum deles entrasse na lista ele viria
// antes — a ausência prova a recusa sem depender de "lista vazia".
const CONTROL = 'f';

test('faixa acima do teto (2160p) não entra no pool seeds', () => {
  const streams = [
    seeds('a', 'Filme 2020 2160p', { quality: '2160p', seeders: 40, size: 5 * GB }),
    seeds(CONTROL, 'Filme 2020 720p', { quality: '720p', seeders: 5, size: 1 * GB }),
  ];
  assert.deepEqual(picked(streams), [hx(CONTROL)]);
});

test('REMUX/BDREMUX é recusado mesmo dentro da faixa permitida', () => {
  const streams = [
    seeds('a', 'Filme 2020 1080p REMUX', { quality: '1080p', seeders: 40, size: 5 * GB }),
    seeds('b', 'Filme 2020 1080p BDREMUX', { quality: '1080p', seeders: 30, size: 5 * GB }),
    seeds(CONTROL, 'Filme 2020 720p', { quality: '720p', seeders: 5, size: 1 * GB }),
  ];
  assert.deepEqual(picked(streams), [hx(CONTROL)]);
});

test('qualidade desconhecida (nem `_quality` nem título) é recusada', () => {
  const streams = [
    seeds('a', 'Filme 2020', { seeders: 40, size: 5 * GB }),
    seeds(CONTROL, 'Filme 2020 720p', { quality: '720p', seeders: 5, size: 1 * GB }),
  ];
  assert.deepEqual(picked(streams), [hx(CONTROL)]);
});

test('tamanho desconhecido (sem `_size`/`_packBytes`/💾) é recusado', () => {
  const streams = [
    seeds('a', 'Filme 2020 720p', { quality: '720p', seeders: 40 }),
    seeds(CONTROL, 'Filme 2020 720p', { quality: '720p', seeders: 5, size: 1 * GB }),
  ];
  assert.deepEqual(picked(streams), [hx(CONTROL)]);
});

test('teto de tamanho é o MENOR entre seedsMaxGb e maxSizeGb (0 = sem teto)', () => {
  const grande = 'a';
  const streams = [
    seeds(grande, 'Filme 2020 1080p', { quality: '1080p', seeders: 40, size: 6 * GB }),
    seeds(CONTROL, 'Filme 2020 720p', { quality: '720p', seeders: 5, size: 4 * GB }),
  ];
  const casos: Array<{ policy: Opts['policy']; entra: boolean; porque: string }> = [
    { policy: { seedsMaxGb: 5, maxSizeGb: 0 }, entra: false, porque: 'teto do pool (5 GB) corta 6 GB' },
    { policy: { seedsMaxGb: 0, maxSizeGb: 5 }, entra: false, porque: 'teto do usuário corta quando o pool não tem' },
    { policy: { seedsMaxGb: 8, maxSizeGb: 5 }, entra: false, porque: 'vale o MENOR: pool 8 GB vs usuário 5 GB' },
    { policy: { seedsMaxGb: 8, maxSizeGb: 0 }, entra: true, porque: 'só o pool limita, 6 GB cabe em 8 GB' },
    { policy: { seedsMaxGb: 0, maxSizeGb: 0 }, entra: true, porque: 'sem teto nenhum' },
  ];
  for (const caso of casos) {
    const hashes = picked(streams, { policy: caso.policy });
    assert.equal(hashes.includes(hx(grande)), caso.entra, caso.porque);
    assert.equal(hashes.includes(hx(CONTROL)), true, `o controle sobrevive sempre — ${caso.porque}`);
  }
});

test('`_packBytes` e o 💾 do título suprem o `_size` ausente', () => {
  const streams = [
    seeds('a', 'Filme 2020 720p', { quality: '720p', seeders: 9, pack: 2 * GB }),
    seeds('b', 'Filme 2020 720p 💾 3.5 GB', { quality: '720p', seeders: 8 }),
    seeds('c', 'Filme 2020 720p', { quality: '720p', seeders: 7 }),
  ];
  const hashes = picked(streams, { live: { autoFetchTopSeedsMax: 3 }, policy: { seedsMaxGb: 5 } });
  assert.deepEqual(hashes, [hx('a'), hx('b')], 'pack e 💾 entram; o sem tamanho nenhum fica fora');
});

test('`seedsBlocked` (fato do oráculo) fecha o pool seeds inteiro', () => {
  const streams = [seeds('a', 'Filme 2020 1080p', { quality: '1080p', seeders: 40, size: 5 * GB })];
  assert.deepEqual(picked(streams), [hx('a')], 'sem bloqueio o pool responde');
  // O bloqueio é o `seedsSelectionBlock` pré-computado no Node (dubbed-only,
  // lista tocável, sonda BR pendente): o lote não vê a lista tocável.
  assert.deepEqual(picked(streams, { seedsBlocked: true }), []);
});

test('faixa máxima inválida cai no default `1080p`', () => {
  const streams = [
    seeds('a', 'Filme 2020 2160p', { quality: '2160p', seeders: 40, size: 5 * GB }),
    seeds('b', 'Filme 2020 1080p', { quality: '1080p', seeders: 20, size: 5 * GB }),
    seeds(CONTROL, 'Filme 2020 720p', { quality: '720p', seeders: 5, size: 1 * GB }),
  ];
  const hashes = picked(streams, { policy: { seedsMaxQuality: 'qualquer-coisa' } });
  assert.equal(hashes.includes(hx('a')), false, '2160p continua acima do default');
  assert.deepEqual(hashes, [hx('b'), hx(CONTROL)]);
});
