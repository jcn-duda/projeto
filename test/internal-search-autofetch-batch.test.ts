// Testes do efeito `autofetch_batch` (F4.1): o Rust emite o lote pós-debrid e
// o Node reconstrói os streams e roda `autoFetchCandidates`/`autoFetchBrDubbed`
// com o estado de sempre. O teste prova o FIO (rota → cascata → enqueue), não a
// rede: o adaptador Premiumize é stub e o `debrid.enqueue` é o ponto medido.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearch } from '../src/routes/internal-search.js';
import { runAutofetchBatch, streamOfItem } from '../src/providers/autofetch-batch.js';
import debrid from '../src/debrid/index.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import * as cache from '../src/utils/cache.js';
import { kvForget } from '../src/utils/native-kv.js';
import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import { forgetObraHash } from '../src/providers/autofetch-obra.js';
import { accountScope } from '../src/utils/request-key.js';
import type { DebridAdapter } from '../types/domain.js';

const TOKEN = 'tok-internal-autofetch-batch';

/** Hash de 40 hex; sufixo único por teste evita colisão de marker/obra. */
function hash(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

function item(infoHash: string, quality: string, extra: Record<string, unknown> = {}) {
  return {
    infoHash,
    title: `Filme Teste 2024 ${quality} WEB-DL DUBLADO`,
    name: `DUB ${quality}`,
    _br: true,
    _dubbed: true,
    _quality: quality,
    _seeders: 10,
    ...extra,
  };
}

let server: any;
let services: ReturnType<typeof buildServices>;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  const app = express();
  services = buildServices();
  // Colaboradores DEFAULT: o teste exercita o handler real (`runAutofetchBatch`).
  registerInternalSearch(app as unknown as express.Router, services, {}, {});
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

/** Drena o setImmediate dos efeitos e as microtarefas do enqueue. */
async function flushTimers() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Monta a conta de teste: adaptador Premiumize com `enqueue` stub, encoded com
 * autofetch BR ligado (sem cachedOnly, aceitando não-dublado como os testes de
 * fila) e limpeza de marker/hold/fila no fim.
 */
function batchAccount(name: string) {
  autofetchLive.reset();
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => {
    enqueued.push(infoHash);
    return true;
  };
  const apiKey = `chave-${name}`;
  const encoded = encodeConfig({ ds: 'premiumize', dk: apiKey, ab: true, dc: false, d: false });
  const account = accountScope(apiKey);
  return {
    enqueued,
    encoded,
    account,
    cleanup(hashes: string[], searchKey?: string) {
      pmAdapter.enqueue = originalEnqueue;
      for (const h of hashes) {
        kvForget(autofetch.markerKey('premiumize', account, h));
        kvForget(autofetch.deadKey('premiumize', account, h));
        held.release(h, account);
        // O teto por OBRA é durável (janela de 6h): sem limpar, a segunda
        // execução do MESMO teste encontraria o cap já consumido.
        forgetObraHash({
          adapterId: 'premiumize',
          account,
          imdbId: 'tt0111161',
          season: null,
          episode: null,
          isPack: false,
          hash: h,
        });
      }
      if (searchKey) {
        autofetch.dropQueue(searchKey);
        autofetch.releaseSearch(searchKey);
      }
    },
  };
}

function sendEffects(encoded: string, effects: unknown[]) {
  return server.request('POST', '/internal/search/effects', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, effects },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lote → cascata → enqueues
// ═══════════════════════════════════════════════════════════════════════════════

test('autofetch_batch: lote pós-debrid produz os enqueues esperados', async () => {
  const h1 = hash('a1');
  const h2 = hash('b2');
  const h3 = hash('c3');
  const h4 = hash('d4');
  const searchKey = 'busca-batch-quatro-br';
  const conta = batchAccount('batch-quatro');
  try {
    const payload = {
      // Mesma matriz do `applyDebrid`: 4 BR dublados fora do cache. O
      // `autoFetchCandidates` pega 1 por faixa-alvo; o 2º 1080 vai à fila.
      items: [
        item(h1, '1080p', { _seeders: 1 }),
        item(h2, '1080p', { _seeders: 5 }),
        item(h3, '720p', { _seeders: 100 }),
        item(h4, '2160p', { _seeders: 999 }),
      ],
      cached: [],
      known: true,
      season: null,
      episode: null,
      imdbId: 'tt0111161',
      searchKey,
    };
    const res = await sendEffects(conta.encoded, [{ kind: 'autofetch_batch', payload }]);
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 1, rejected: 0 });
    await flushTimers();
    // Ordem do pool: 1080 → 720 → 2160 (h1 perde a faixa para h2).
    assert.deepEqual(conta.enqueued, [h2, h3, h4], '1×1080 + 1×720 + 1×4K');
    // O excedente da faixa vai para a fila persistente, como no Node.
    const queued = autofetch.readQueue(searchKey);
    assert.equal(queued.length, 1);
    assert.equal(String(queued[0].infoHash).toLowerCase(), h1);
  } finally {
    conta.cleanup([h1, h2, h3, h4], searchKey);
  }
});

test('autofetch_batch: known=false segura os hashes e não enfileira', async () => {
  const h = hash('e5');
  const searchKey = 'busca-batch-known-false';
  const conta = batchAccount('batch-known-false');
  try {
    const res = await sendEffects(conta.encoded, [{
      kind: 'autofetch_batch',
      payload: {
        items: [item(h, '1080p')],
        cached: [],
        known: false,
        imdbId: 'tt0111161',
        searchKey,
      },
    }]);
    assert.equal(res.status, 202);
    await flushTimers();
    assert.deepEqual(conta.enqueued, [], 'sem cache conhecido não há download');
    // O `autoFetchCandidates` segurou e o `autoFetchBrDubbed` liberou: nada de
    // hash órfão imune à limpeza.
    assert.equal(held.isHeld(h, conta.account), false);
  } finally {
    conta.cleanup([h], searchKey);
  }
});

test('autofetch_batch: inventário da conta completa o known (sem cacheCheck)', async () => {
  const h = hash('4b');
  const invHash = hash('5c');
  const searchKey = 'busca-batch-inventario';
  const conta = batchAccount('batch-inventario');
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalCacheCheck = pmAdapter.cacheCheck;
  const originalSource = pmAdapter.autofetchSource;
  const originalPeek = debrid.inventoryPeek;
  const originalInventory = debrid.inventory;
  // Adaptador no formato RD/Debrid-Link: sem cacheCheck, mas com inventário.
  pmAdapter.cacheCheck = false;
  pmAdapter.autofetchSource = true;
  (debrid as any).inventoryPeek = () => [{ infoHash: invHash }];
  (debrid as any).inventory = async () => [];
  try {
    const res = await sendEffects(conta.encoded, [{
      kind: 'autofetch_batch',
      payload: {
        items: [item(h, '1080p')],
        cached: [],
        known: false,
        imdbId: 'tt0111161',
        searchKey,
      },
    }]);
    assert.equal(res.status, 202);
    await flushTimers();
    // O inventário é estado do Node: sem ele, `known:false` liberaria os holds
    // e nada baixaria. É o mesmo `enrichInstantWithoutCacheCheck` do applyDebrid.
    assert.deepEqual(conta.enqueued, [h], 'inventário respondeu ⇒ known vira true');
  } finally {
    pmAdapter.cacheCheck = originalCacheCheck;
    pmAdapter.autofetchSource = originalSource;
    debrid.inventoryPeek = originalPeek;
    debrid.inventory = originalInventory;
    conta.cleanup([h], searchKey);
  }
});

test('autofetch_batch: cache em cache não é despejado (já tocável)', async () => {
  const h = hash('f6');
  const searchKey = 'busca-batch-cached';
  const conta = batchAccount('batch-cached');
  try {
    const res = await sendEffects(conta.encoded, [{
      kind: 'autofetch_batch',
      payload: {
        items: [item(h, '1080p')],
        cached: [h],
        known: true,
        imdbId: 'tt0111161',
        searchKey,
      },
    }]);
    assert.equal(res.status, 202);
    await flushTimers();
    assert.deepEqual(conta.enqueued, [], 'hash já em cache não vira download');
  } finally {
    conta.cleanup([h], searchKey);
  }
});

test('autofetch_batch: multiobra e reserva não elegível ficam de fora da seleção', async () => {
  const multi = hash('07');
  const reservaBloqueada = hash('18');
  const reservaElegivel = hash('29');
  const searchKey = 'busca-batch-filtro';
  const conta = batchAccount('batch-filtro');
  try {
    const payload = {
      items: [
        item(multi, '1080p', { _multiWorkAdmitted: true }),
        item(reservaBloqueada, '1080p', { _fromFallback: true, _fallbackFetchable: false }),
        item(reservaElegivel, '720p', { _fromFallback: true, _fallbackFetchable: true }),
      ],
      cached: [],
      known: true,
      imdbId: 'tt0111161',
      searchKey,
    };
    const res = await sendEffects(conta.encoded, [{ kind: 'autofetch_batch', payload }]);
    assert.equal(res.status, 202);
    await flushTimers();
    assert.deepEqual(conta.enqueued, [reservaElegivel], 'só a reserva elegível baixa');
  } finally {
    conta.cleanup([multi, reservaBloqueada, reservaElegivel], searchKey);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Forma do payload (rota e reconstrução)
// ═══════════════════════════════════════════════════════════════════════════════

test('autofetch_batch: payload sem items/cached/known é rejeitado, lote segue', async () => {
  const h = hash('3a');
  const searchKey = 'busca-batch-forma';
  const conta = batchAccount('batch-forma');
  try {
    const res = await sendEffects(conta.encoded, [
      { kind: 'autofetch_batch', payload: { items: [] } },
      { kind: 'autofetch_batch', payload: { items: 'x', cached: [], known: true } },
      { kind: 'autofetch_batch', payload: { items: [], cached: [], known: 'true' } },
      { kind: 'autofetch_batch', payload: { items: [item(h, '1080p')], cached: [], known: true, searchKey } },
    ]);
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 1, rejected: 3 });
    await flushTimers();
    assert.deepEqual(conta.enqueued, [h]);
  } finally {
    conta.cleanup([h], searchKey);
  }
});

test('streamOfItem: sem hash é descartado e fato de tipo errado não viaja', () => {
  assert.equal(streamOfItem({ title: 'sem hash' }), null);
  assert.equal(streamOfItem('não-objeto'), null);
  assert.equal(streamOfItem({ infoHash: '   ' }), null);
  const stream = streamOfItem({
    infoHash: 'abc',
    title: 'Filme 2024 1080p',
    name: 7,
    _quality: 1080,
    _seeders: '9',
    _size: 12.5,
    _br: true,
    _dubClaim: true,
    _multiWorkAdmitted: false,
    campoDesconhecido: 'x',
  });
  assert.ok(stream);
  assert.equal(stream.infoHash, 'abc');
  assert.equal(stream.title, 'Filme 2024 1080p');
  assert.equal(stream.name, undefined, 'name não-string é descartado');
  assert.equal(stream._quality, undefined, '_quality não-string é descartado');
  assert.equal(stream._seeders, undefined, '_seeders não-número é descartado');
  assert.equal(stream._size, 12.5);
  assert.equal(stream._br, true);
  assert.equal(stream._dubClaim, true);
  assert.equal(stream._multiWorkAdmitted, false);
  assert.equal((stream as unknown as Record<string, unknown>).campoDesconhecido, undefined);
});

test('runAutofetchBatch: lote vazio ou sem hash é no-op silencioso', () => {
  // Sem debrid na configuração corrente não há cascata; o importante é não
  // lançar e não enfileirar.
  assert.equal(runAutofetchBatch({ items: [], cached: [], known: true }), 0);
  assert.equal(runAutofetchBatch({ items: [{ title: 'sem hash' }], cached: [], known: true }), 0);
});
