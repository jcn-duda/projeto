// Promoção tardia do cache de busca (`src/providers/search-late-promoter.ts`).
//
// MUT-10 do harness adversarial ataca a escrita do ramo SEM novidade: a coleta
// estourou o orçamento, a resposta saiu parcial e o lote fechou sem item novo.
// Essa reescrita (`partial:false`) é o que faz a reabertura do Stremio sair do
// cache com TTL cheio; forçá-la a `true` deixa a entrada parcial para sempre.
//
// Por que uma suíte dedicada em vez de um e2e: o caminho quente responde
// completo e o ramo `grew` passa pelo `finish` do orquestrador, não por esta
// escrita. Nenhuma suíte e2e existente alcançava o ramo sem novidade; sem este
// teste o mutante ficaria verde por vacuidade.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { createLatePromoter } from '../src/providers/search-late-promoter.js';

interface FinishCall { input: any; phase?: number }

function makeFinish(phase = 1) {
  const calls: FinishCall[] = [];
  const finish: any = (input: any, p?: number) => {
    calls.push({ input, phase: p });
    return Promise.resolve(undefined);
  };
  finish.phase = () => phase;
  return { finish, calls };
}

let seq = 0;
const freshKey = () => `test:late-promoter:${process.pid}:${++seq}`;

test('promove entrada parcial a completa quando a coleta encerra sem novidade', () => {
  const { finish, calls } = makeFinish(1);
  const cacheKey = freshKey();
  const streams = [{ title: 'Stream Parcial' }];
  const originalTtl = config.cacheTtl;
  config.cacheTtl = 900;
  try {
    cache.set(
      cacheKey,
      { streams, partial: true, debridKnown: true, trace: { marker: 1 }, searchMeta: { name: 'Obra' } },
      300,
    );

    const promote = createLatePromoter({ finish, cacheKey, id: 'tt-promo' });
    promote([...streams], false, 1, false, null);

    const hit: any = cache.get(cacheKey);
    assert.ok(hit, 'entrada continua no cache');
    assert.equal(hit.partial, false, 'promoção sem novidade reescreve como completa');
    assert.equal(hit.streams.length, 1, 'lote preservado');
    assert.deepEqual(hit.trace, { marker: 1 }, 'ledger do trace preservado');
    assert.deepEqual(hit.searchMeta, { name: 'Obra' }, 'searchMeta preservado');
    assert.ok((cache.peekRemaining(cacheKey) || 0) > 60, 'TTL cheio depois da promoção');
    assert.equal(calls.length, 0, 'promoção sem novidade não refaz o build');
  } finally {
    config.cacheTtl = originalTtl;
    cache.forget(cacheKey);
  }
});

test('lote que cresceu refaz o build completo e não promove direto', () => {
  const { finish, calls } = makeFinish(7);
  const cacheKey = freshKey();
  cache.set(cacheKey, { streams: [], partial: true, debridKnown: true }, 60);
  try {
    const live = { hasAnyFailure: () => false } as any;
    const promote = createLatePromoter({ finish, cacheKey, id: 'tt-grew' });
    promote([{ a: 1 }, { b: 2 }], true, 7, false, live);

    assert.equal(calls.length, 1, 'cresceu => chama o finish');
    assert.equal(calls[0].input.partial, false, 'lote completo não é parcial');
    assert.equal(calls[0].input.items.length, 2, 'lote completo entregue');
    assert.equal(calls[0].phase, 7, 'fase propagada');
    assert.equal(calls[0].input.live, live, 'estado vivo propagado');
    const hit: any = cache.get(cacheKey);
    assert.equal(hit.partial, true, 'a promoção direta não toca o cache quando cresceu');
  } finally {
    cache.forget(cacheKey);
  }
});

test('passe intermediário (partial=true) e fase divergente são no-op', () => {
  const { finish } = makeFinish(3);
  const intermediateKey = freshKey();
  const divergedKey = freshKey();
  cache.set(intermediateKey, { streams: [{ title: 'x' }], partial: true, debridKnown: true }, 60);
  cache.set(divergedKey, { streams: [{ title: 'x' }], partial: true, debridKnown: true }, 60);
  try {
    const promoteIntermediate = createLatePromoter({ finish, cacheKey: intermediateKey, id: 'inter' });
    promoteIntermediate([{ title: 'x' }], false, 3, true, null);
    assert.equal((cache.get(intermediateKey) as any).partial, true, 'lote ainda parcial não promove');

    const promoteDiverged = createLatePromoter({ finish, cacheKey: divergedKey, id: 'div' });
    promoteDiverged([{ title: 'x' }], false, 99, false, null);
    assert.equal((cache.get(divergedKey) as any).partial, true, 'fase diferente (pack assumiu) não promove');
  } finally {
    cache.forget(intermediateKey);
    cache.forget(divergedKey);
  }
});

test('entrada já completa não é tocada', () => {
  const { finish } = makeFinish(1);
  const cacheKey = freshKey();
  cache.set(cacheKey, { streams: [{ title: 'x' }], partial: false, debridKnown: true }, 900);
  try {
    const promote = createLatePromoter({ finish, cacheKey, id: 'done' });
    promote([{ title: 'x' }], false, 1, false, null);
    const hit: any = cache.get(cacheKey);
    assert.equal(hit.partial, false);
  } finally {
    cache.forget(cacheKey);
  }
});

test('reserva do banco com indexer saudável é invalidada em vez de promovida', () => {
  const { finish } = makeFinish(1);
  const cacheKey = freshKey();
  cache.set(cacheKey, { streams: [{ title: 'x' }], partial: true, debridKnown: true, fallback: true }, 120);
  try {
    const liveHealthy = { hasAnyFailure: () => false } as any;
    const promote = createLatePromoter({ finish, cacheKey, id: 'fallback' });
    promote([{ title: 'x' }], false, 1, false, liveHealthy);
    assert.equal(cache.has(cacheKey), false, 'falha sumiu => reserva invalidada');
  } finally {
    cache.forget(cacheKey);
  }

  const keptKey = freshKey();
  cache.set(keptKey, { streams: [{ title: 'x' }], partial: true, debridKnown: true, fallback: true }, 120);
  try {
    const liveFailing = { hasAnyFailure: () => true } as any;
    const promote = createLatePromoter({ finish, cacheKey: keptKey, id: 'fallback-keep' });
    promote([{ title: 'x' }], false, 1, false, liveFailing);
    assert.equal((cache.get(keptKey) as any).partial, true, 'com falha viva a reserva fica intacta');
  } finally {
    cache.forget(keptKey);
  }
});