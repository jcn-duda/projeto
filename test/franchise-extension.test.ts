// Subtítulo a MAIS depois do nome nu (`franchiseExtensionContradicts`): na busca
// de "Resident Evil" (2026), "Resident Evil Vendetta" — o anime de 2017 — saía
// com ⚡ (2026-10-02). Medido em 198 releases globais do índice da VPS: a regra
// corta só as 4 do Vendetta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevantRaw } from '../src/utils/format.js';

const keep = (title: string, names: string[], year: number) =>
  filterRelevantRaw([{ title, infoHash: 'a'.repeat(40), seeders: 5, indexer: 'nyaasi', isBr: false }], { names, year, isSeries: false }).length === 1;

test('subtítulo de outra obra da franquia, sem ano, sai', () => {
  for (const t of [
    'Resident Evil Vendetta (Full Japanese Audio+EN)(BD 1080p x264 AAC)',
    'Resident Evil: Vendetta [BDMV] [2160p] [Multi-Audio] [Multi-Subs]',
  ]) assert.equal(keep(t, ['Resident Evil'], 2026), false, t);
});

test('a mesma obra continua: ano do catálogo, ruído, edição e alias', () => {
  assert.ok(keep('Resident Evil 2026 1080p WEB-DL x264', ['Resident Evil'], 2026));
  assert.ok(keep('Resident Evil 1080p TELESYNC MULTi x264', ['Resident Evil'], 2026));
  assert.ok(keep('Resident Evil Unrated 1080p BluRay', ['Resident Evil'], 2002));
  assert.ok(keep('Resident Evil Directors Cut 1080p', ['Resident Evil'], 2002));
  // A palavra a mais pertence a outro nome da MESMA obra (pt-BR).
  assert.ok(keep('Resident Evil O Hospede Maldito 1080p BluRay', ['Resident Evil', 'Resident Evil: O Hóspede Maldito'], 2002));
});
