// B-4 — prova de segurança do gate ÚNICO de deleção da AllDebrid:
//
//   - o gate de `deleteMagnets` serializa TODAS as deleções da conta
//     (dropReady, dropDownload, catálogo, painel) — duas chamadas concorrentes
//     para a mesma conta não sobrepõem.
//
// As varreduras destrutivas da AllDebrid (mortos, não-dublados, reconcile da
// posse e cura dos represados) não são mais do Node: quem monta o plano e
// aplica é o agendador NATIVO (`al_sweeps`, gate `DEBRID_AL_SWEEP_APPLY`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as metrics from '../src/utils/metrics.js';
import { deleteMagnets } from '../src/debrid/alldebrid-cleanup.js';
import { assenta, mockAd } from './helpers/alldebrid-mock.js';

const KEY = 'chave-delete-gate-816';

// --- Gate único de deleção (B-4) ---------------------------------------------

test('B-4: fila única serializa deleteMagnets por conta (duas chamadas não sobrepõem)', async () => {
  metrics.reset();
  const api = mockAd({ failFirstOnce: true });
  try {
    // A entra no gate e fica PRESA no backoff da 1ª tentativa (waitFn injetado).
    let liberar!: () => void;
    const preso = new Promise<void>((r) => { liberar = r; });
    const pa = deleteMagnets(KEY, [11], { waitFn: () => preso });
    await assenta();
    assert.deepEqual([...api.ordem], [11], 'A está em voo, presa no backoff');

    // B chega enquanto A não terminou: o gate NÃO pode deixar rodar.
    const pb = deleteMagnets(KEY, [22], { waitFn: () => Promise.resolve(), delays: [1, 1] });
    await assenta();
    assert.deepEqual([...api.ordem], [11], 'B não inicia enquanto A está em voo');

    liberar();
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.ok, 1);
    assert.equal(rb.ok, 1);
    assert.deepEqual([...(ra.removedIds ?? [])], [11]);
    assert.deepEqual([...(rb.removedIds ?? [])], [22]);
    const idxB = api.ordem.indexOf(22);
    assert.ok(idxB > -1, 'B rodou depois da liberação');
    assert.ok(api.ordem.slice(0, idxB).every((id) => id === 11), 'todas as tentativas de A precedem a 1ª de B');
  } finally {
    api.restore();
    metrics.reset();
  }
});
