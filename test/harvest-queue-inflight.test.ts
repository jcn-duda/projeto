// Fase 5: corrida in-flight da fila do colhedor. Uma obra em voo no
// `harvestOne` pode ter sido re-enfileirada — e promovida — enquanto estava
// fora da fila; `head`/`tail` fecham essa corrida sem duplicar e sem rebaixar
// o motivo de maior precedência (`next-episode` > `br-gap` > demais).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import * as harvesterLive from '../src/utils/harvester-live.js';

test('Fase 5: in-flight — tail(miss) mantém o br-gap que entrou na fila (sem duplicar)', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    const obra = 'tt9030001';
    harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'miss' });
    const emVoo = harvestQueue.takeHead();
    assert.ok(emVoo && emVoo.reason === 'miss', 'a entrada saiu para colheita');
    // Durante o voo, a busca prova a lacuna BR e re-enfileira a MESMA obra.
    harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
    // Falha transitória devolve a entrada em voo para a cauda.
    harvestQueue.tail(emVoo!);
    const fila = harvestQueue.preview(10).filter((e) => e.imdbId === obra);
    assert.equal(fila.length, 1, 'tail não duplica a identidade já re-enfileirada');
    assert.equal(fila[0].reason, 'br-gap', 'preserva o motivo de maior precedência');
  } finally {
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('Fase 5: in-flight — tail(next) sobe o br-gap da fila para next (sem duplicar)', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    const obra = 'tt9030002';
    harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 1, reason: 'next-episode' });
    const emVoo = harvestQueue.takeHead();
    assert.ok(emVoo && emVoo.reason === 'next-episode', 'a entrada saiu para colheita');
    harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 1, reason: 'br-gap' });
    harvestQueue.tail(emVoo!);
    const fila = harvestQueue.preview(10).filter((e) => e.imdbId === obra);
    assert.equal(fila.length, 1, 'sem duplicata');
    assert.equal(fila[0].reason, 'next-episode', 'next-episode é a precedência máxima');
  } finally {
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('Fase 5: in-flight — head(next) sobre br-gap sobe o motivo, não duplica e volta à frente', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    const obra = 'tt9030003';
    harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 1, reason: 'next-episode' });
    const emVoo = harvestQueue.takeHead();
    assert.ok(emVoo && emVoo.reason === 'next-episode', 'a entrada saiu para colheita');
    // Durante o voo a mesma obra foi re-enfileirada como br-gap.
    harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 1, reason: 'br-gap' });
    harvestQueue.head(emVoo!);
    const fila = harvestQueue.preview(10).filter((e) => e.imdbId === obra);
    assert.equal(fila.length, 1, 'head não duplica a identidade já presente');
    assert.equal(fila[0].reason, 'next-episode', 'preserva o motivo de maior precedência');
    // Head semantics: o sobrevivente volta à FRENTE (o primeiro takeHead é ele).
    const primeiro = harvestQueue.takeHead();
    assert.equal(primeiro?.imdbId, obra, 'a entrada retomada volta à frente');
    assert.equal(primeiro?.reason, 'next-episode');

    // Espelho do tail: um `miss` em voo NÃO rebaixa o br-gap já na fila.
    const outra = 'tt9030004';
    harvestQueue.enqueue({ imdbId: outra, type: 'movie', season: null, episode: null, reason: 'miss' });
    const emVooMiss = harvestQueue.takeHead();
    harvestQueue.enqueue({ imdbId: outra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
    harvestQueue.head(emVooMiss!);
    const filaOutra = harvestQueue.preview(10).filter((e) => e.imdbId === outra);
    assert.equal(filaOutra.length, 1, 'sem duplicata');
    assert.equal(filaOutra[0].reason, 'br-gap', 'head não rebaixa o motivo de maior precedência');
  } finally {
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});
