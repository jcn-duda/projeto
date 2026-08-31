// Fase 8, 8.16 + B-4 — provas de segurança da evicção por busca
// (complemento de alldebrid-evict.test.ts):
//
//   - a marca `adrm` (8.14) só grava para removedIds bem-sucedidos;
//   - erro de rede é fail-open e inventário null pula a rodada FECHADO;
//   - o gate ÚNICO de deleteMagnets serializa TODAS as deleções da conta
//     (dropReady, dropDownload, varreduras, painel e a própria evicção) —
//     duas chamadas concorrentes para a mesma conta não sobrepõem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import { preexisting } from '../src/debrid/alldebrid-inventory.js';
import { deleteMagnets } from '../src/debrid/alldebrid-cleanup.js';
import { scheduleEvict } from '../src/debrid/alldebrid-evict.js';
import {
  adrmKey, counter, mag, mockAd, withDebrid, inventario, soltaInventario, assenta, esperaMetrica,
} from './helpers/alldebrid-mock.js';

config.debrid.reuploadBlock = true;
config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;

const KEY = 'chave-evict-gate-816';
const ACCOUNT = accountScope(KEY);
const OPERADOR = { evictPerSearch: true, apiKey: KEY, harvestEvictFloor: 0, harvestEvictMaxPerSearch: 25 } as const;

let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));

// --- Marca adrm só de removedIds ---------------------------------------------

test('8.16: removedIds marcam adrm; delete recusado não marca e conta failed', async () => {
  metrics.reset();
  const G1 = '21'.repeat(20);
  const G2 = '43'.repeat(20);
  const api = mockAd({
    account: [
      mag(551, G1, 'Sai.Movie.2010.TrueFrench.1080p', 1000),
      mag(552, G2, 'Fica.Movie.2011.TrueFrench.1080p', 2000),
    ],
    failDeleteFor: [552], // a conta recusa este delete (6 tentativas, backoff real)
  });
  inventario(ACCOUNT, []);
  const restore = withDebrid({ ...OPERADOR });
  try {
    scheduleEvict(KEY, ['65'.repeat(20), '87'.repeat(20)]); // alvo = min(2, 25, 2)
    await esperaMetrica('debrid.evicted.failed');
    await assenta();
    assert.equal(counter('debrid.evicted.perSearch'), 1, 'perSearch conta o que saiu de verdade');
    assert.ok(cache.peek(adrmKey(ACCOUNT, G1)) != null, 'o que saiu recebe "não re-subir"');
    assert.equal(cache.peek(adrmKey(ACCOUNT, G2)), null, 'falha de delete não marca (o magnet continua lá)');
  } finally {
    restore();
    cache.forget(adrmKey(ACCOUNT, G1));
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- Fail-open e inventário frio ---------------------------------------------

test('8.16: erro de rede é fail-open; inventário null pula a rodada fechado', async () => {
  metrics.reset();
  const apiFalha = mockAd({ account: [mag(561, 'aa'.repeat(20), 'Old.Movie.2019.TrueFrench.1080p', 1000)], failStatus: true });
  inventario(ACCOUNT, []);
  const restore = withDebrid({ ...OPERADOR });
  try {
    assert.doesNotThrow(() => scheduleEvict(KEY, ['65'.repeat(20)]), 'agendar nunca lança');
    await esperaMetrica('debrid.evicted.failed');
    assert.equal(apiFalha.ordem.length, 0, 'sem status não há deleção');
  } finally {
    restore();
    apiFalha.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
  // Proveniência null: o fail-safe FECHA — nenhuma remoção sem referência.
  const apiFria = mockAd({ account: [mag(562, 'aa'.repeat(20), 'Old.Movie.2019.TrueFrench.1080p', 1000)] });
  preexisting.set(ACCOUNT, { hashes: null, loadedAt: 0 });
  const restoreFrio = withDebrid({ ...OPERADOR });
  try {
    scheduleEvict(KEY, ['65'.repeat(20)]);
    await assenta();
    await assenta();
    assert.equal(apiFria.statusCalls, 0, 'inventário frio: nem a leitura da conta acontece');
    assert.equal(apiFria.ordem.length, 0);
  } finally {
    restoreFrio();
    apiFria.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

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
