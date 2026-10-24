// Pack de franquia da CONTA só entra se a faixa de anos cobrir o filme
// (`filterInventoryRelevant`). Medido em 2026-10-01: "Resident Evil Saga
// Completa (2002-2017)" pronto na AllDebrid saía como fonte do Resident Evil
// de 2026 e o play abria o filme de 2007.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterInventoryRelevant } from '../src/utils/format.js';

const pack = (title: string, i: number) => ({ title, infoHash: String(i).padStart(40, 'a'), seeders: 1 });
const SAGA = pack('Resident Evil Saga Completa (2002-2017) 1080p.H265 AC3 5.1 ITA.ENG sub ita.eng Sp33dy94-MIRCrew', 1);
const PENTA = pack('Pentalogia - Resident Evil (2002-2012) BDRip 1080p 5.1 Dual Áudio - Douglasvip', 2);
const SEM_ANO = pack('Resident Evil Coleção Completa Dublado', 3);

test('pack da conta fora da faixa de anos não vira fonte do filme novo', () => {
  const ctx = { names: ['Resident Evil'], year: 2026, isSeries: false };
  assert.deepEqual(filterInventoryRelevant([SAGA, PENTA], ctx), []);
});

test('pack que cobre o ano do filme continua entrando; sem ano, a franquia decide', () => {
  const ctx = { names: ['Resident Evil 3: Extinction', 'Resident Evil'], year: 2007, isSeries: false };
  const got = filterInventoryRelevant([SAGA, PENTA, SEM_ANO], ctx).map((r) => r.infoHash);
  assert.deepEqual(got.sort(), [SAGA.infoHash, PENTA.infoHash, SEM_ANO.infoHash].sort());
});
