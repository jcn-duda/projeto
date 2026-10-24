// Tail da resposta instantânea: a foto do idx (fromSnapshot) perde o 📦 só
// quando o indexer dela respondeu. Extraído de magnet-bank-instant.test.ts pelo
// orçamento de 400 linhas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearInstantSnapshots, promoteInstantTail } from '../src/providers/magnet-bank-instant.js';

const hex = (c: string) => c.repeat(40);

test('tail instantâneo: foto do idx perde o 📦 e a lista é reconstruída mesmo sem novidade viva', async () => {
  const snapshot = { title: 'Idx Release 1080p', infoHash: hex('9'), seeders: 5, fromSnapshot: true };
  const reserva = { title: 'Banco Release 720p', infoHash: hex('8'), seeders: 3, fromFallback: true };
  const rawItems: any[] = [snapshot, reserva];
  const calls: Array<{ items: any[]; grew: boolean }> = [];
  await promoteInstantTail({
    rawItems,
    liveItems: [],
    live: null,
    phase: 0,
    late: (items, grew) => { calls.push({ items: [...items], grew }); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].grew, true, 'sem reconstruir, a promoção gravaria a lista antiga com o selo');
  assert.deepEqual(calls[0].items.map((i) => i.infoHash), [hex('9')], 'a reserva 📦 sai; a foto do idx fica');
  assert.equal(calls[0].items[0].fromSnapshot, undefined, 'a foto do idx perde a marca');
  assert.equal(clearInstantSnapshots([{ title: 'x' }]), 0);
});

test('tail instantâneo: foto do idx de indexer que FALHOU mantém o 📦 (Jackett fora do ar)', () => {
  const live: any = {
    allFailed: () => false,
    failedIndexers: () => new Set(['kickasstorrents-to']),
    suspectIndexers: () => new Set(),
    hasAnyFailure: () => true,
  };
  const caiu = { title: 'A', infoHash: hex('7'), indexer: 'kickasstorrents-to', fromSnapshot: true };
  const vivo = { title: 'B', infoHash: hex('6'), indexer: 'yts', fromSnapshot: true };
  assert.equal(clearInstantSnapshots([caiu, vivo], live), 1);
  assert.equal(caiu.fromSnapshot, true, 'indexer falho: segue foto salva');
  assert.equal((vivo as any).fromSnapshot, undefined, 'indexer respondeu: vira lista viva');
  const tudo: any = { allFailed: () => true, failedIndexers: () => new Set(), suspectIndexers: () => new Set(), hasAnyFailure: () => true };
  const outra = { title: 'C', infoHash: hex('5'), indexer: 'yts', fromSnapshot: true };
  assert.equal(clearInstantSnapshots([outra], tudo), 0, '/all falho: nada perde o selo');
  const vazio: any = { allFailed: () => false, failedIndexers: () => new Set(), suspectIndexers: () => new Set(['nerdfilmes']) };
  const foto = { title: 'D', infoHash: hex('4'), indexer: 'nerdfilmes', fromSnapshot: true };
  assert.equal(clearInstantSnapshots([foto], vazio), 0, 'vazio suspeito não reconfirma a foto: segue 📦');
});
