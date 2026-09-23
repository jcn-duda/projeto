import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/client/painel/vendor/preact.js';
import { jevQuestionModel, jevModel } from '../src/client/painel/jev-model.js';
import { ViewJev, JevView } from '../src/client/painel/view-jev.js';

// Snapshot REAL de UMA pergunta (contrato JudgmentCoreStatus de
// src/ai/judgment-queue-core.ts): os 13 campos do bloco `typesafe`.
const AUDIO_SNAPSHOT = {
  enabled: true,
  model: 'jev-latest',
  promptVersion: 'v1',
  questionId: 'is_ptbr_dub',
  queueDepth: 3,
  inFlight: 2,
  hourlyUsed: 40,
  hourlyCap: 60,
  dailyUsed: 300,
  dailyCap: 500,
  cooldownRemainingMs: 45000,
  consecutiveFail: 2,
  paused: true,
};

const DUBLIE_SNAPSHOT = {
  enabled: true,
  model: 'jev-latest',
  promptVersion: 'v1',
  questionId: 'is_dub_lie',
  queueDepth: 1,
  inFlight: 0,
  hourlyUsed: 10,
  hourlyCap: 60,
  dailyUsed: 80,
  dailyCap: 500,
  cooldownRemainingMs: 0,
  consecutiveFail: 0,
  paused: false,
};

// Contadores reais da concordÃ¢ncia shadow (labels FECHOS do motor).
const COUNTERS = {
  'typesafe.shadow.agree': 38,
  'typesafe.shadow.disagree': 4,
  'typesafe.shadow.disagree.ai-pt': 3,
  'typesafe.shadow.disagree.rule-pt': 1,
  'typesafe.shadow.dublie.agree': 26,
  'typesafe.shadow.dublie.disagree': 4,
  'typesafe.shadow.dublie.disagree.ai-lie': 2,
  'typesafe.shadow.dublie.disagree.rule-lie': 2,
  'typesafe.overlay.consulted': 57,
  'typesafe.overlay.cache-miss': 19,
  'typesafe.overlay.applied': 6,
};

test('jevQuestionModel lÃª os 13 campos da pergunta e a concordÃ¢ncia (prefixo vazio)', () => {
  const q = jevQuestionModel(AUDIO_SNAPSHOT, COUNTERS, '');
  assert.equal(q.enabled, true);
  assert.equal(q.model, 'jev-latest');
  assert.equal(q.promptVersion, 'v1');
  assert.equal(q.queueDepth, 3);
  assert.equal(q.inFlight, 2);
  assert.equal(q.paused, true);
  assert.equal(q.hourlyUsed, 40);
  assert.equal(q.hourlyCap, 60);
  assert.equal(q.dailyUsed, 300);
  assert.equal(q.dailyCap, 500);
  assert.equal(q.cooldownMs, 45000, 'cooldownRemainingMs do contrato vira cooldownMs');
  assert.equal(q.consecutiveFail, 2);
  assert.equal(q.agree, 38);
  assert.equal(q.disagree, 4);
  assert.equal(q.aiSide, 3, 'pergunta 1: lado da IA Ã© ai-pt');
  assert.equal(q.ruleSide, 1, 'pergunta 1: lado da regra Ã© rule-pt');
  assert.ok(Math.abs((q.agreementRate || 0) - 38 / 42) < 1e-9, 'taxa = agree / (agree + disagree)');
});

test('jevQuestionModel lÃª a pergunta 2 sob o prefixo dublie.', () => {
  const q = jevQuestionModel(DUBLIE_SNAPSHOT, COUNTERS, 'dublie.');
  assert.equal('questionId' in q, false, 'o view-model nÃ£o repassa campo alÃ©m do contrato');
  assert.equal(q.queueDepth, 1);
  assert.equal(q.paused, false);
  assert.equal(q.cooldownMs, 0);
  assert.equal(q.agree, 26);
  assert.equal(q.disagree, 4);
  assert.equal(q.aiSide, 2, 'pergunta 2: lado da IA Ã© ai-lie');
  assert.equal(q.ruleSide, 2, 'pergunta 2: lado da regra Ã© rule-lie');
  assert.ok(Math.abs((q.agreementRate || 0) - 26 / 30) < 1e-9);
});

test('jevQuestionModel Ã© defensivo: payload vazio vira zeros e taxa null', () => {
  const q = jevQuestionModel(null, {}, '');
  assert.equal(q.enabled, false);
  assert.equal(q.model, '');
  assert.equal(q.promptVersion, '');
  assert.equal(q.queueDepth, 0);
  assert.equal(q.inFlight, 0);
  assert.equal(q.paused, false);
  assert.equal(q.hourlyUsed, 0);
  assert.equal(q.hourlyCap, 0);
  assert.equal(q.dailyUsed, 0);
  assert.equal(q.dailyCap, 0);
  assert.equal(q.cooldownMs, 0);
  assert.equal(q.consecutiveFail, 0);
  assert.equal(q.agree, 0);
  assert.equal(q.disagree, 0);
  assert.equal(q.aiSide, 0);
  assert.equal(q.ruleSide, 0);
  assert.equal(q.agreementRate, null, 'sem julgamento algum nÃ£o hÃ¡ taxa');
});

test('jevQuestionModel com prefixo desconhecido nÃ£o inventa chave de mÃ©trica', () => {
  const q = jevQuestionModel(AUDIO_SNAPSHOT, COUNTERS, 'xpto.');
  assert.equal(q.agree, 0);
  assert.equal(q.disagree, 0);
  assert.equal(q.aiSide, 0);
  assert.equal(q.ruleSide, 0);
  assert.equal(q.agreementRate, null);
});

test('jevModel agrega o bloco typesafe com as duas perguntas', () => {
  const m = jevModel(
    { enabled: true, model: 'jev-latest', audioClassify: AUDIO_SNAPSHOT, dubLie: DUBLIE_SNAPSHOT },
    { counters: COUNTERS },
  );
  assert.equal(m.enabled, true);
  assert.equal(m.model, 'jev-latest');
  assert.equal(m.audioClassify.queueDepth, 3);
  assert.equal(m.audioClassify.paused, true);
  assert.equal(m.dubLie.queueDepth, 1);
  assert.equal(m.dubLie.agree, 26);
});

test('jevModel com typesafe ausente nÃ£o quebra (modelo vazio)', () => {
  // Sem o bloco E sem mÃ©trica: tudo vazio, taxa null.
  const m = jevModel(undefined, { counters: {} });
  assert.equal(m.enabled, false);
  assert.equal(m.model, '');
  assert.equal(m.audioClassify.queueDepth, 0);
  assert.equal(m.dubLie.queueDepth, 0);
  assert.equal(m.audioClassify.agreementRate, null);

  const semMetrics = jevModel(undefined, undefined);
  assert.equal(semMetrics.enabled, false);
  assert.equal(semMetrics.dubLie.disagree, 0);
  assert.equal(semMetrics.dubLie.agreementRate, null);
});

test('jevModel preserva a concordÃ¢ncia histÃ³rica quando sÃ³ o bloco typesafe falta', () => {
  // Bloco ausente (ex.: payload velho) mas contadores vivos desde o boot: a
  // concordÃ¢ncia Ã© mÃ©trica acumulada e permanece â€” Ã© dado auxiliar, nÃ£o fila.
  const m = jevModel(undefined, { counters: COUNTERS });
  assert.equal(m.enabled, false);
  assert.equal(m.audioClassify.agree, 38);
  assert.equal(m.dubLie.agree, 26);
});

test('jevModel lÃª o bloco overlay (ETAPA C) com fallback nos contadores', () => {
  // Bloco dedicado do status tem precedÃªncia.
  const m = jevModel(
    {
      enabled: true,
      model: 'jev-latest',
      audioClassify: AUDIO_SNAPSHOT,
      dubLie: DUBLIE_SNAPSHOT,
      overlay: { enabled: true, active: true, blockedReason: '', consulted: 100, cacheMiss: 40, applied: 7 },
    },
    { counters: COUNTERS },
  );
  assert.equal(m.overlay.enabled, true);
  assert.equal(m.overlay.active, true);
  assert.equal(m.overlay.blockedReason, '');
  assert.equal(m.overlay.consulted, 100);
  assert.equal(m.overlay.cacheMiss, 40);
  assert.equal(m.overlay.applied, 7);

  // Flag ligada com portÃ£o FECHADO: o bloco carrega o motivo (enum fechado).
  const bloqueado = jevModel(
    {
      enabled: true,
      model: 'jev-latest',
      audioClassify: AUDIO_SNAPSHOT,
      dubLie: DUBLIE_SNAPSHOT,
      overlay: { enabled: true, active: false, blockedReason: 'model-alias', consulted: 5, cacheMiss: 5, applied: 0 },
    },
    { counters: COUNTERS },
  );
  assert.equal(bloqueado.overlay.enabled, true);
  assert.equal(bloqueado.overlay.active, false);
  assert.equal(bloqueado.overlay.blockedReason, 'model-alias');

  // Payload velho sem o bloco: cai nos contadores `typesafe.overlay.*`.
  const porContador = jevModel(
    { enabled: true, model: 'jev-latest', audioClassify: AUDIO_SNAPSHOT, dubLie: DUBLIE_SNAPSHOT },
    { counters: COUNTERS },
  );
  assert.equal(porContador.overlay.enabled, false, 'sem bloco, enabled vem vazio (fallback sÃ³ nos nÃºmeros)');
  assert.equal(porContador.overlay.consulted, 57);
  assert.equal(porContador.overlay.cacheMiss, 19);
  assert.equal(porContador.overlay.applied, 6);

  // Sem nada: zeros defensivos.
  const vazio = jevModel(undefined, { counters: {} });
  assert.deepEqual(vazio.overlay, {
    enabled: false, active: false, blockedReason: '', consulted: 0, cacheMiss: 0, applied: 0,
  });
});

/** Texto visÃ­vel incluindo title/badge/label â€” INVOCA componentes de funÃ§Ã£o
 * sem hooks (mesmo padrÃ£o de test/painel-magnet-bank.test.ts), senÃ£o o
 * conteÃºdo de Card/QuestionCard ficaria preso dentro da funÃ§Ã£o. */
function textOf(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props || {}));
    const props = node.props || {};
    return [
      typeof props.title === 'string' ? props.title : '',
      typeof props.badge?.text === 'string' ? props.badge.text : '',
      typeof props.label === 'string' ? props.label : '',
      textOf(props.children),
    ].join(' ');
  }
  return '';
}

test('ViewJev Ã© a casca com estado que monta o corpo presentacional', () => {
  const vnode = h(ViewJev, {
    typesafe: { enabled: true, model: 'jev-latest', audioClassify: AUDIO_SNAPSHOT, dubLie: DUBLIE_SNAPSHOT },
    metrics: { counters: COUNTERS },
  });
  assert.ok(vnode && typeof vnode === 'object');
  assert.equal(vnode.type, ViewJev);
  assert.equal(vnode.props.typesafe.audioClassify.queueDepth, 3);
});

test('JevView renderiza as duas perguntas shadow com concordÃ¢ncia e controles', () => {
  const model = jevModel(
    { enabled: true, model: 'jev-latest', audioClassify: AUDIO_SNAPSHOT, dubLie: DUBLIE_SNAPSHOT },
    { counters: COUNTERS },
  );
  const text = textOf(JevView({ model }));
  assert.match(text, /is_ptbr_dub/, 'a pergunta 1 aparece');
  assert.match(text, /is_dub_lie/, 'a pergunta 2 aparece');
  assert.match(text, /ATIVO/, 'badge do card de controles reflete o runtime ligado');
  assert.match(text, /PAUSADO/, 'a pergunta 1 pausada tem badge próprio');
  assert.match(text, /38\s+concordam\s*·\s*4\s+divergem/, 'concordância da pergunta 1 visível');
  assert.match(text, /26\s+concordam/, 'concordância da pergunta 2 visível');
  assert.match(text, /IA afirma\s+PT-BR\s*:\s*3/, 'quebra ai-side da pergunta 1');
  assert.match(text, /regra afirma\s+lie\s*:\s*2/, 'quebra rule-side da pergunta 2');
  assert.match(text, /Retomar Jev/, 'a pergunta 1 pausada liga o estado global (botão vira retomar)');
  assert.match(text, /Drenar Fila \(\s*4\s*\)/, 'fila somada das duas perguntas');
  assert.match(text, /Zerar Cooldown/, 'reset do breaker ofertado com falha ativa');
});

test('JevView cobre typesafe ausente sem quebrar (INATIVO)', () => {
  const text = textOf(JevView({ model: jevModel(undefined, { counters: {} }) }));
  assert.match(text, /INATIVO/, 'runtime desligado Ã© estado, nÃ£o erro');
  assert.match(text, /Pausar Jev/, 'sem pausa nenhuma o botÃ£o ofertado Ã© o de pausar');
});

test('JevView renderiza o card do overlay gateado com os trÃªs contadores', () => {
  const ligado = jevModel(
    {
      enabled: true,
      model: 'jev-latest',
      audioClassify: AUDIO_SNAPSHOT,
      dubLie: DUBLIE_SNAPSHOT,
      overlay: { enabled: true, active: true, blockedReason: '', consulted: 100, cacheMiss: 40, applied: 7 },
    },
    { counters: COUNTERS },
  );
  const textOn = textOf(JevView({ model: ligado }));
  assert.match(textOn, /Overlay Jev/, 'o card do overlay aparece');
  assert.match(textOn, /GATEADO ON/, 'badge mostra o gate ligado');
  assert.match(textOn, /100\s+\(\s*consultadas\s*\)/, 'contador consulted visÃ­vel');
  assert.match(textOn, /40\s+\(\s*sem cache\s*\)/, 'contador cache-miss visÃ­vel');
  assert.match(textOn, /7\s+\(\s*derrubadas\s*\)/, 'contador applied visÃ­vel');
  assert.match(textOn, /Cache-only/, 'a garantia cache-only estÃ¡ explicada');

  // Flag ligada com portÃ£o fechado NÃO Ã© "GATEADO ON": badge BLOQUEADO com o
  // motivo legÃ­vel (enum fechado, sem texto de credencial).
  const bloqueado = jevModel(
    {
      enabled: true,
      model: 'jev-latest',
      audioClassify: AUDIO_SNAPSHOT,
      dubLie: DUBLIE_SNAPSHOT,
      overlay: { enabled: true, active: false, blockedReason: 'no-key', consulted: 0, cacheMiss: 0, applied: 0 },
    },
    { counters: COUNTERS },
  );
  const textBlocked = textOf(JevView({ model: bloqueado }));
  assert.match(textBlocked, /BLOQUEADO/, 'portÃ£o fechado com flag ligada Ã© BLOQUEADO');
  assert.match(textBlocked, /sem chave da API/, 'o motivo legÃ­vel aparece');
  assert.doesNotMatch(textBlocked, /GATEADO ON/, 'o badge mentiroso nÃ£o aparece');

  const desligado = jevModel(undefined, { counters: {} });
  const textOff = textOf(JevView({ model: desligado }));
  assert.match(textOff, /OFF/, 'overlay desligado Ã© estado, nÃ£o erro');
});
