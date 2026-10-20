import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as metrics from '../src/utils/metrics.js';
import {
  firstObserverStep, createFirstObserver,
  firstObserverClaim, promoteFirstObserverEligible,
} from '../src/providers/index.js';
import { stageFirstTiming } from '../src/providers/first-observer.js';
import { limitReservingBr } from '../src/utils/format.js';

test('limitReservingBr observa os BR selecionados ANTES de limpar os campos internos', () => {
  metrics.reset();
  const brStream = { name: 'Filme BR', infoHash: 'a'.repeat(40), _br: true, _seeders: 1, _quality: '1080p' };
  const global1 = { name: 'G1', infoHash: 'b'.repeat(40) };
  const global2 = { name: 'G2', infoHash: 'c'.repeat(40) };
  let observed: any[] | undefined;
  const out = limitReservingBr([global1, global2, brStream] as any, {
    brReservedSlots: 1,
    maxResults: 3,
    brFirst: true,
    onSelected: (sel) => { observed = sel; },
  });
  // O callback recebe os selecionados AINDA com `_br` — é isso que permite medir
  // quantas fontes BR realmente serão entregues.
  assert.ok(observed, 'callback é chamado com os selecionados');
  assert.ok(observed!.some((s) => s._br === true), 'callback vê o campo interno _br antes da limpeza');
  assert.ok(observed!.some((s) => s.name === 'Filme BR'), 'o BR reservado está entre os observados');
  // E a saída pública não expõe o campo interno (contrato preservado).
  assert.ok(out.some((s: any) => s.name === 'Filme BR'), 'o BR segue na lista final');
  assert.equal((out.find((s: any) => s.name === 'Filme BR') as any)?._br, undefined, 'saída não expõe _br');
});

test('firstObserverStep: passe tardio antes do first não reclama nem conta; Alita dá delta 3; repetição zero', () => {
  const s = createFirstObserver(true);

  // Recache tardio enquanto o first ainda está em voo (primeira não confirmou):
  // não pode reclamar nem contar — flags first/late ambos ausentes no correr.
  let step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: false, brVisible: 3 });
  assert.equal(step.kind, 'none', 'tardio antes do first confirmar não é nada');
  assert.equal(step.delta, 0, 'e não conta delta');
  // Mesmo que um chamador passasse observeLatePass por engano, sem firstCounted
  // não conta (a guarda é o estado, não o flag).
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 3 });
  assert.equal(step.kind, 'none', 'observeLatePass sem firstCounted não conta');

  // Primeira passada reclamada: first (Alita com 1 BR visível).
  step = firstObserverStep(s, { observeFirstPass: true, observeLatePass: false, brVisible: 1 });
  assert.equal(step.kind, 'first', 'passada reclamada e ainda não contada é first');
  assert.equal(step.delta, 1);
  s.firstCounted = true;
  s.maxBrVisible = 1;

  // Recache tardio sobe para 4: delta é 4 - 1 = 3, nunca 4.
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 4 });
  assert.equal(step.kind, 'late');
  assert.equal(step.delta, 3, 'Alita: first=1 e late=4 geram delta 3');
  s.maxBrVisible = 4;

  // Repetição em 4: delta 0 — nunca re-cobra o total.
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 4 });
  assert.equal(step.delta, 0, 'repetição em 4 não conta nada');

  // Queda para 2: delta 0 (máximo já visto era 4).
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 2 });
  assert.equal(step.delta, 0, 'recache abaixo do máximo não conta nada');
});

test('firstObserverStep ignora execução não elegível (SWR/background) mesmo com flags', () => {
  const s = createFirstObserver(false);
  const step = firstObserverStep(s, { observeFirstPass: true, observeLatePass: false, brVisible: 5 });
  assert.equal(step.kind, 'none');
  assert.equal(step.delta, 0);
});

test('stageFirstTiming seta passos únicos, acumula coletas e ignora valor inválido/recache', () => {
  const state = createFirstObserver(true);
  stageFirstTiming(state, 'metadata', 100);
  stageFirstTiming(state, 'metadata', 80);
  stageFirstTiming(state, 'debrid', 30);
  stageFirstTiming(state, 'debrid', 20);
  stageFirstTiming(state, 'global', 40);
  stageFirstTiming(state, 'global', 10);
  stageFirstTiming(state, 'br', 7);
  stageFirstTiming(state, 'br', 3);

  assert.equal(state.pendingMetadata, 80);
  assert.equal(state.pendingDebrid, 20);
  assert.equal(state.pendingGlobal, 50);
  assert.equal(state.pendingBr, 10);

  stageFirstTiming(state, 'metadata', Number.NaN);
  stageFirstTiming(state, 'global', -1);
  state.firstCounted = true;
  stageFirstTiming(state, 'br', 999);
  assert.equal(state.pendingMetadata, 80, 'NaN não substitui valor válido');
  assert.equal(state.pendingGlobal, 50, 'negativo não entra no acumulado');
  assert.equal(state.pendingBr, 10, 'recache após firstCounted não altera estágio');
});

test('firstObserverClaim: só a primeira tentativa com deadline reclama; late antes do first não observa', () => {
  const s = createFirstObserver(true);

  // Primeiro finish com deadline: reclama first.
  let r = firstObserverClaim(s, true);
  assert.equal(r.observeFirstPass, true, 'primeira passada com deadline reclama o first');
  assert.equal(r.observeLatePass, false);
  assert.equal(s.firstClaimed, true, 'o claim é mutado sync');

  // Segundo finish também com deadline (recache com prazo): NÃO reclama de novo.
  r = firstObserverClaim(s, true);
  assert.equal(r.observeFirstPass, false, 'segunda passada com deadline não re-reclama');
  assert.equal(r.observeLatePass, false, 'e ainda não é late (first não confirmou)');

  // Recache sem deadline enquanto o first está em voo: não observa nada.
  r = firstObserverClaim(s, false);
  assert.equal(r.observeFirstPass, false);
  assert.equal(r.observeLatePass, false, 'late antes de firstCounted não observa');
});

test('firstObserverClaim: após firstCounted, sem deadline vira late', () => {
  const s = createFirstObserver(true);
  firstObserverClaim(s, true); // reclama o first
  s.firstCounted = true;       // first CONCLUIU

  const r = firstObserverClaim(s, false);
  assert.equal(r.observeFirstPass, false);
  assert.equal(r.observeLatePass, true, 'recache tardio após firstConfirmado observa');
});

test('promoteFirstObserverEligible: foreground promove false→true sem mexer em firstClaimed/contadores', () => {
  metrics.reset();
  const s = createFirstObserver(false);
  s.firstClaimed = true; // já reclamado por outro caminho — não pode mudar
  const snapshotBefore = metrics.snapshot().counters['stream.coalesced'];

  promoteFirstObserverEligible(s, true); // prefetch→foreground (busca real assumindo)
  assert.equal(s.eligible, true, 'foreground promove elegibilidade');
  assert.equal(s.firstClaimed, true, 'não mexe no firstClaimed');

  // Foreground→background (no-op): não rebaixa quem já foi promovido.
  promoteFirstObserverEligible(s, false);
  assert.equal(s.eligible, true, 'background não desce elegibilidade já promovida');

  assert.equal(metrics.snapshot().counters['stream.coalesced'], snapshotBefore, 'helper não toca contadores');
});

// ---------------------------------------------------------------------------
// Fase 3.1 — gauge (estado atual): sobrescreve, pode cair, snapshot ordenado e
// reset limpa. Isso é a base das métricas `f3.br.*` do baseline de cobertura.
// ---------------------------------------------------------------------------

test('gauge publica NIVEL, sobrescreve (pode cair) e o snapshot é ordenado', () => {
  metrics.reset();
  metrics.gauge('f3.br.popular.cached', 5);
  metrics.gauge('f3.br.popular.cached', 2); // nível cai: pode voltar a baixo
  assert.equal(metrics.snapshot().gauges['f3.br.popular.cached'], 2, 'gauge é estado atual, sobrescreve');

  metrics.gauge('c2', 1);
  metrics.gauge('a1', 2);
  metrics.gauge('ignorado', Number.NaN);
  // O snapshot entrega os gauges SEMPRE ordenados para o painel não depender
  // da ordem de escrita.
  assert.deepEqual(Object.keys(metrics.snapshot().gauges), ['a1', 'c2', 'f3.br.popular.cached']);
});

test('gauge não participa dos contadores nem dos timers (espaço separado)', () => {
  metrics.reset();
  metrics.gauge('soco', 1);
  metrics.count('soco'); // mesmo nome em outro espaço não se confunde
  metrics.observe('soco', 12);
  const snap = metrics.snapshot();
  assert.equal(snap.counters['soco'], 1);
  assert.equal(snap.gauges['soco'], 1);
  assert.equal(snap.timers['soco']?.count, 1);
});

test('metrics.reset limpa contadores, gauges e timers', () => {
  metrics.reset();
  metrics.count('a', 3);
  metrics.gauge('b', 2);
  metrics.observe('c', 5);
  metrics.reset();
  const snap = metrics.snapshot();
  assert.deepEqual(snap.counters, {});
  assert.deepEqual(snap.gauges, {});
  assert.deepEqual(snap.timers, {});
});
