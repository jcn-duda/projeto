// Fase 5: corrida in-flight da fila do colhedor. Uma obra em voo no
// `harvestOne` pode ter sido re-enfileirada — e promovida — enquanto estava
// fora da fila; `head`/`tail` fecham essa corrida sem duplicar e sem rebaixar
// o motivo de maior precedência (`next-episode` > `br-gap` > demais).
//
// Item aberto 8: o coalescing deixou de ser só da sonda e passou a valer para
// QUALQUER `enqueue` da identidade em voo — estes testes cobrem a fusão da
// intenção (motivo/flag) sem criar segunda entrada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import type { HarvestEntry } from '../src/providers/harvest-queue.js';
import * as harvestInflight from '../src/providers/harvest-inflight.js';
import { reasonPriority } from '../src/providers/harvest-reason.js';
import { settleHarvest, settleHarvestFailure, resetHarvestOutcomeForTest } from '../src/providers/harvest-outcome.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as metrics from '../src/utils/metrics.js';

const identityOf = (imdbId: string, season: number | null = null, episode: number | null = null) =>
  harvestQueue.obraIdentity({ imdbId, season, episode });

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

test('item aberto 8: enqueue comum durante voo coalesce, não enfileira e não infla harvest.enqueued', () => {
  harvesterLive.reset();
  const before = metrics.snapshot().counters['harvest.enqueued'] || 0;
  try {
    harvestQueue.clearQueue();
    const obra = 'tt9040001';
    const id = identityOf(obra);
    harvestInflight.begin(id, { reason: 'popular', rank: reasonPriority('popular') });
    const outcome = harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
    assert.equal(outcome.reason, 'coalesced', 'a intenção foi absorvida em vez de virar entrada');
    assert.equal(harvestQueue.depth(), 0, 'nada novo entra na fila');
    const intent = harvestInflight.pendingIntent(id);
    assert.equal(intent?.reason, 'br-gap', 'motivo mais forte fundido');
    assert.ok(intent?.priorityAt != null, 'a janela do br-gap viaja com a intenção');
    assert.equal(metrics.snapshot().counters['harvest.enqueued'] || 0, before, 'não conta enqueue novo');
  } finally {
    harvestInflight.resetHarvestInflightForTest();
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('item aberto 8: next-episode durante miss em voo sobe o motivo (sem duplicar)', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    const obra = 'tt9040002';
    const id = identityOf(obra, 1, 1);
    harvestInflight.begin(id, { reason: 'miss', rank: reasonPriority('miss') });
    const outcome = harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 1, reason: 'next-episode' });
    assert.equal(outcome.reason, 'coalesced');
    assert.equal(harvestQueue.depth(), 0, 'sem segunda entrada');
    assert.equal(harvestInflight.pendingIntent(id)?.reason, 'next-episode', 'promoção só sobe');
    // E o end limpa o slot: nada fica preso após a execução.
    harvestInflight.end(id);
    assert.equal(harvestInflight.isInflight(id), false);
    assert.equal(harvestInflight.pendingIntent(id), null);
  } finally {
    harvestInflight.resetHarvestInflightForTest();
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('item aberto 8: flag dirigida é OR-aderente na fusão em voo', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    const obra = 'tt9040003';
    const id = identityOf(obra);
    harvestInflight.begin(id, { reason: 'miss', rank: reasonPriority('miss'), brProbe: false });
    const outcome = harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap', brProbe: true });
    assert.equal(outcome.reason, 'coalesced');
    const intent = harvestInflight.pendingIntent(id);
    assert.equal(intent?.brProbe, true, 'a flag probe é anexada');
    assert.equal(intent?.reason, 'br-gap');
  } finally {
    harvestInflight.resetHarvestInflightForTest();
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('item aberto 8: obra DIFERENTE não coalesce — entra na fila normalmente', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    const emVoo = 'tt9040004';
    const outra = 'tt9040005';
    harvestInflight.begin(identityOf(emVoo), { reason: 'miss', rank: reasonPriority('miss') });
    const outcome = harvestQueue.enqueue({ imdbId: outra, type: 'movie', season: null, episode: null, reason: 'miss' });
    assert.equal(outcome.reason, 'queued', 'obra distinta segue o caminho normal');
    assert.equal(harvestQueue.depth(), 1);
    assert.equal(harvestQueue.preview(1)[0].imdbId, outra);
    assert.equal(harvestInflight.pendingIntent(identityOf(emVoo))?.reason, 'miss', 'a obra em voo fica intacta');
  } finally {
    harvestInflight.resetHarvestInflightForTest();
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('item aberto 8 + fullBase: o retry preserva o pedido FULL e descarta a flag dirigida', () => {
  harvesterLive.reset();
  resetHarvestOutcomeForTest();
  try {
    harvestQueue.clearQueue();

    // FULL `miss` que recebe a sonda da MESMA obra como `br-gap`+brProbe: a
    // promoção anexa a flag dirigida e marca `fullBase` (a cobertura completa
    // da entrada sobrevive ao desfecho).
    const obra = 'tt9050001';
    const serie = { imdbId: obra, type: 'series' as const, season: 4, episode: 1 };
    harvestQueue.enqueue({ ...serie, reason: 'miss' });
    const promoted = harvestQueue.enqueue({ ...serie, reason: 'br-gap', brProbe: true });
    assert.equal(promoted.reason, 'promoted');
    const emVoo = harvestQueue.takeHead();
    assert.ok(emVoo && emVoo.brProbe === true && emVoo.fullBase === true, 'promoção anexa a flag e marca fullBase');
    settleHarvestFailure(emVoo!, null);
    let fila = harvestQueue.preview(10).filter((e) => e.imdbId === obra);
    assert.equal(fila.length, 1, 'UMA entrada reencaminhada');
    assert.equal(fila[0].brProbe, undefined, 'fullBase não ressuscita a flag dirigida');
    assert.equal(fila[0].reason, 'br-gap', 'preserva o motivo FULL vigente da entrada');

    // Sonda anexada SEM promoção (motivo igual): a entrada FULL segue `miss` e o
    // retry também — o pedido completo original não é reescrito pela flag.
    harvestQueue.clearQueue();
    const obraSegura = 'tt9050002';
    const filme = { imdbId: obraSegura, type: 'movie' as const, season: null, episode: null };
    harvestQueue.enqueue({ ...filme, reason: 'miss' });
    assert.equal(harvestQueue.enqueue({ ...filme, reason: 'miss', brProbe: true }).reason, 'queued');
    const emVooSeguro = harvestQueue.takeHead();
    assert.ok(emVooSeguro?.fullBase === true, 'a flag foi anexada sem promoção');
    settleHarvestFailure(emVooSeguro!, null);
    fila = harvestQueue.preview(10).filter((e) => e.imdbId === obraSegura);
    assert.equal(fila[0].reason, 'miss', 'o pedido FULL original permanece');
    assert.equal(fila[0].brProbe, undefined);

    // A3: run FULL com sonda apenas COALESCIDA em voo. O `returned`
    // OR-aderente do tick (brProbe de `isProbe`) não pode rebaixar o retry — a
    // preempção descarta a flag porque a base era FULL (não-dirigida).
    harvestQueue.clearQueue();
    const obraA3 = 'tt9050003';
    const idA3 = identityOf(obraA3, 4, 1);
    const base: HarvestEntry = {
      imdbId: obraA3,
      type: 'series',
      season: 4,
      episode: 1,
      reason: 'miss',
      enqueuedAt: Date.now(),
    };
    harvestInflight.begin(idA3, { reason: 'miss', rank: reasonPriority('miss'), brProbe: false });
    const coalesced = harvestQueue.enqueue({ imdbId: obraA3, type: 'series', season: 4, episode: 1, reason: 'br-gap', brProbe: true });
    assert.equal(coalesced.reason, 'coalesced', 'a sonda fundiu na execução em voo');
    const intent = harvestInflight.pendingIntent(idA3);
    assert.equal(intent?.brProbe, true, 'sonda coalescida em voo');
    settleHarvest({
      entry: base,
      identity: idA3,
      intent,
      isProbe: true,
      // `returned` como o tick monta (flag OR-aderente); o desfecho é quem
      // aplica a política de sobrevivência da flag.
      returned: { ...base, reason: intent?.reason ?? base.reason, brProbe: true },
      ok: false,
      added: 0,
      capped: false,
      preempted: true,
      brFound: false,
      responded: 0,
    });
    fila = harvestQueue.preview(10).filter((e) => e.imdbId === obraA3);
    assert.equal(fila.length, 1, 'preempção reencaminha UMA entrada');
    assert.equal(fila[0].brProbe, undefined, 'base FULL: a flag coalescida não viaja');
    assert.equal(fila[0].reason, 'br-gap', 'o motivo mais forte fundido viaja');
  } finally {
    harvestInflight.resetHarvestInflightForTest();
    resetHarvestOutcomeForTest();
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});
