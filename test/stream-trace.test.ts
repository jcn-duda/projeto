// P5 Fase 0 — unit puro do ledger observacional (sem rede, sem pipeline).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STREAM_TRACE_MAX_ITEMS,
  STREAM_TRACE_LABEL_MAX,
  createStreamTrace,
  stageTrace,
  dropTrace,
  finalizeTrace,
  serializeTrace,
} from '../src/utils/stream-trace.js';
import config from '../src/config.js';

const HASH = 'a'.repeat(40);

// O ledger é observacional: nada aqui pode mudar o caminho de busca. O que os
// testes cobram é a CONTABILIDADE (estágios e motivos), os TETOS (payload não
// pode crescer sem controle dentro de uma entrada de cache de 900s) e a
// HIGIENE do payload (sem hash de magnet nem URI de magnet — o endpoint é
// diagnosticável, não uma lista de torrents).

test('createStreamTrace nasce vazio, com startedAt e finishedAt aberto', () => {
  const t = createStreamTrace();
  assert.deepEqual(t.stages, {});
  assert.deepEqual(t.items, []);
  assert.ok(Number.isFinite(t.startedAt) && t.startedAt > 0);
  assert.equal(t.finishedAt, null);
});

test('stageTrace acumula por estágio e ignora lixo (null, negativo, NaN)', () => {
  const t = createStreamTrace();
  stageTrace(t, 'raw', 10);
  stageTrace(t, 'raw', 5);
  stageTrace(t, 'afterSort', 3);
  assert.deepEqual(t.stages, { raw: 15, afterSort: 3 });

  const antes = { ...t.stages };
  stageTrace(t, 'raw', 0);
  stageTrace(t, 'raw', -2);
  stageTrace(t, 'raw', Number.NaN);
  stageTrace(t, '', 10);
  stageTrace(null, 'raw', 10);
  assert.deepEqual(t.stages, antes, 'estágio sem queda não conta');
});

test('dropTrace registra item com id sequencial, motivo e metadados', () => {
  const t = createStreamTrace();
  // Forma de STREAM (campos internos _br/_dubbed/_quality).
  dropTrace(t, { name: 'Filme X\n1080p ⚡', infoHash: HASH, _br: true, _dubbed: true, _quality: '1080p' }, 'cached-only');
  // Forma de ITEM CRU (title/isBr) — o ledger roda antes do toStremioStream.
  dropTrace(t, { title: 'Release Y 720p', isBr: true }, 'title-filter');
  // Item vazio não explode: sem rótulo, sem br.
  dropTrace(t, null, 'pool-cut');

  assert.equal(t.items.length, 3);
  const [a, b, c] = t.items;
  assert.equal(a.id, 's1');
  assert.equal(a.reason, 'cached-only');
  assert.equal(a.label, 'Filme X'); // primeira linha do name
  assert.equal(a.br, true);
  assert.equal(a.dubbed, true);
  assert.equal(a.quality, '1080p');
  assert.equal(b.id, 's2');
  assert.equal(b.reason, 'title-filter');
  assert.equal(b.label, 'Release Y 720p');
  assert.equal(b.br, true);
  assert.equal(c.reason, 'pool-cut');
  assert.equal(c.label, '');
  assert.equal(c.br, false);
});

test('dropTrace é no-op sem trace', () => {
  // A regra de ouro: sem trace NADA acontece — nenhum call site precisa
  // checar o kill-switch.
  assert.doesNotThrow(() => dropTrace(null, { name: 'x' }, 'dedupe'));
  assert.doesNotThrow(() => stageTrace(null, 'raw', 1));
  assert.doesNotThrow(() => finalizeTrace(null, 0));
  assert.equal(serializeTrace(null), null);
  assert.equal(serializeTrace(undefined), null);
});

test('teto de itens: 301º corte não entra no ledger', () => {
  const t = createStreamTrace();
  for (let i = 0; i < STREAM_TRACE_MAX_ITEMS + 10; i++) {
    dropTrace(t, { name: `item ${i}` }, 'pool-cut');
  }
  assert.equal(t.items.length, STREAM_TRACE_MAX_ITEMS);
  // Os estágios continuam íntegros mesmo com o teto de itens — a contagem é
  // exata, só o DETALHE por item é amostrado.
  stageTrace(t, 'final', 1);
  assert.equal(t.stages.final, 1);
});

test('finalizeTrace fixa o tamanho entregue e o instante de término', () => {
  const t = createStreamTrace();
  stageTrace(t, 'final', 2); // estágio provisório antes do aviso
  const antes = Date.now();
  finalizeTrace(t, 1);
  assert.ok(t.finishedAt !== null && t.finishedAt >= antes);
  assert.equal(t.stages.final, 1); // sobrescrito pelo tamanho FINAL
});

test('serializeTrace devolve payload sanitizado, truncado e idempotente', () => {
  const t = createStreamTrace();
  const tituloLongo = 'Uma release brasileira com título comprido demais para o rótulo do ledger';
  dropTrace(t, { name: `Magnet ${HASH} e título ${tituloLongo}`, _br: true }, 'title-filter');
  dropTrace(t, { title: 'magnet:?xt=urn:btih:abcdef&dn=segredo' }, 'no-hash');
  stageTrace(t, 'raw', 2);
  finalizeTrace(t, 0);

  const payload = serializeTrace(t);
  assert.ok(payload);
  assert.deepEqual(payload.stages, { raw: 2, final: 0 });
  assert.ok(typeof payload.startedAt === 'number');
  assert.ok(typeof payload.finishedAt === 'number');
  assert.equal(payload.items.length, 2);

  const cru = JSON.stringify(payload);
  assert.doesNotMatch(cru, /[a-f0-9]{40}/, 'payload não pode expor hash de magnet');
  assert.ok(!cru.includes('magnet:'), 'payload não pode expor URI de magnet');
  assert.ok(cru.includes('<hash>'), 'o hash vira marcador legível');
  assert.ok(cru.includes('<magnet>'), 'a URI vira marcador legível');

  const [primeiro] = payload.items;
  assert.equal(primeiro.br, true);
  assert.ok(primeiro.label.length <= STREAM_TRACE_LABEL_MAX, `rótulo truncado (len=${primeiro.label.length})`);

  // Idempotência: o payload gravado no cache volta a passar por aqui na
  // leitura do endpoint e tem que sair igual.
  const deNovo = serializeTrace(payload);
  assert.deepEqual(deNovo, payload);
});

test('kill-switch STREAM_TRACE=false desliga: serializeTrace devolve null', () => {
  const t = createStreamTrace();
  dropTrace(t, { name: 'x' }, 'dedupe');
  const original = config.search.streamTrace;
  try {
    config.search.streamTrace = false;
    assert.equal(serializeTrace(t), null, 'kill-switch desligado => payload null');
    // A captura continua sendo um no-op barato; o call site grava trace:null.
    dropTrace(t, { name: 'y' }, 'pool-cut');
    assert.equal(serializeTrace(createStreamTrace()), null);
  } finally {
    config.search.streamTrace = original;
  }
});

test('rótulo vazio e item sem campo nenhum não quebram o payload', () => {
  const t = createStreamTrace();
  dropTrace(t, undefined, 'max-results');
  dropTrace(t, { Title: '' }, 'min-seeders');
  const payload = serializeTrace(t);
  assert.ok(payload);
  assert.equal(payload.items.length, 2);
  assert.deepEqual(payload.items.map((i) => i.label), ['', '']);
});
