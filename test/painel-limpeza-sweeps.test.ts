// Cartão "Varreduras nativas (AllDebrid)" da aba Limpeza e o toast da ação
// `sweep-dead`. O que estes testes travam:
//   - sem a foto (ou com `ok:false`) NADA de zeros: as contagens ficam `null`,
//     a view diz "status nativo indisponível" e o cartão não pinta número;
//   - modo DESLIGADO / agendador parado / nenhuma rodada também não é medida:
//     o cartão usa o marcador de "não rodou", nunca "0 removidos";
//   - modo é o EFETIVO do gateway (LEITURA/APLICA/DESLIGADO) e a busca é por
//     `Map`, para `constructor`/`__proto__` não virarem modo válido;
//   - motivos saem em PT-BR com fallback "motivo: <chave>" (nunca `undefined`);
//   - o toast distingue concluída, interrompida (`stopped`) e recusada/em
//     espera (`busy` é espera, não falha).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SweepsCard,
  SWEEPS_RUNNING_BADGE,
  sweepsCardView,
  topSweepReasons,
} from '../src/client/painel/limpeza/view-sweeps.js';
import { sweepOutcome, sweepReasonLabel, sweepToast } from '../src/client/painel/limpeza-model.js';
import { SweepsCard as Reexportado } from '../src/client/painel/view-limpeza.js';
import { CLIENT_ASSETS } from '../src/routes/public.js';
import { expand, textOf } from './helpers/painel-vnode.js';

const STAMP = /\d{2}\/\d{2} \d{2}:\d{2}/;

/** Texto de cada `<td>` do cartão: é onde os contadores aparecem. */
function cells(node: any): string[] {
  return expand(node)
    .filter((child) => child.type === 'td')
    .map((child) => textOf(child.props?.children).trim());
}

/** Badge do cartão cujo texto contém `needle`. */
function badge(node: any, needle: string): any {
  return expand(node).find((child) => typeof child.props?.class === 'string'
    && child.props.class.includes('painel-badge')
    && textOf(child.props.children).includes(needle));
}

test('sem a foto do gateway: cartão indisponível, contagens em branco (zero nunca inventado)', () => {
  for (const entry of [null, undefined, {} as any]) {
    const view = sweepsCardView(entry as any);
    assert.equal(view.available, false);
    assert.equal(view.modeLabel, 'SEM STATUS');
    assert.equal(view.planned, null);
    assert.equal(view.swept, null);
    assert.equal(view.sweptUndubbed, null);
    assert.equal(view.failed, null);
    assert.equal(view.blocked, null);
    assert.equal(view.measured, false);
    assert.equal(view.lastTickLabel, '—');
    assert.equal(view.nextDueLabel, '—');
    assert.equal(view.runsLabel, '—');
    assert.equal(view.pulledLabel, '—');
    assert.deepEqual(view.topReasons, []);
    assert.match(String(view.unavailableReason), /foto do gateway|foto inválida/);
  }
});

test('ok:false (resposta malformada): bloco marcado indisponível, não desenha números', () => {
  const sweeps = {
    ok: false,
    mode: 'apply',
    scheduled: true,
    counters: { runs: 4, planned: 9, swept: 8, failed: 1 },
    last: { at: 1_793_223_600_000, manual: false },
  };
  const view = sweepsCardView(sweeps);
  assert.equal(view.available, false);
  assert.equal(view.modeLabel, 'SEM STATUS');
  assert.equal(view.planned, null);
  assert.equal(view.swept, null);
  assert.match(String(view.unavailableReason), /`ok`/);

  const text = textOf(SweepsCard({ sweeps }));
  assert.match(text, /status nativo indisponível/);
  assert.match(text, /foto inválida/);
  assert.doesNotMatch(text, /9 removido|\(8\)/);
  assert.deepEqual(cells(SweepsCard({ sweeps })), [], 'sem foto não há tabela de contadores');
});

test('modo DESLIGADO: nenhum "0" na tela — o cartão diz que não rodou', () => {
  const sweeps = {
    ok: true,
    enabled: false,
    scheduled: false,
    mode: 'off',
    intervalMs: 0,
    running: false,
    startedAt: null,
    lastTickAt: null,
    nextDueAt: null,
    disabledReason: 'cleanup_off',
    // Contadores de processo recém-nascidos: zero de RAM não é medida.
    counters: { runs: 0, manualRuns: 0, planned: 0, swept: 0, sweptUndubbed: 0, failed: 0, blocked: 0 },
    last: null,
    pulledAt: '2026-10-29T12:34:00.000Z',
  };
  const view = sweepsCardView(sweeps);
  assert.equal(view.available, true);
  assert.equal(view.modeLabel, 'DESLIGADO');
  assert.equal(view.modeVariant, 'neutral');
  assert.equal(view.scheduled, false);
  assert.equal(view.intervalLabel, '—', 'intervalo zero não vira "0 s"');
  assert.equal(view.disabledReason, 'cleanup_off');
  assert.equal(view.disabledReasonLabel, 'limpeza desligada no gateway');
  assert.equal(view.measured, false, 'modo off nunca é rodada medida');
  for (const key of ['planned', 'swept', 'sweptUndubbed', 'failed', 'blocked'] as const) {
    assert.equal(view[key], null, `${key} fica em branco com o gateway desligado`);
  }
  assert.equal(view.runsLabel, '—');

  const node = SweepsCard({ sweeps });
  const text = textOf(node);
  assert.match(text, /Não rodou nesta configuração/);
  assert.match(text, /Agendador fora:\s+limpeza desligada no gateway/);
  // Células ímpares são os VALORES (par = rótulo do contador).
  const values = cells(node).filter((_, index) => index % 2 === 1);
  assert.equal(values.length, 5, 'a tabela continua listando os cinco contadores');
  assert.ok(values.every((cell) => cell === '—'), 'nenhum contador numérico com o gateway desligado');
  assert.doesNotMatch(text, /\(0\)/, 'motivo não é anunciado com contagem zero');
});

test('agendador parado (`disabledReason`) zera a leitura mesmo com `mode` aplicável', () => {
  const view = sweepsCardView({
    ok: true,
    mode: 'apply',
    disabledReason: 'no_destructive_token',
    counters: { runs: 0, swept: 0 },
    last: null,
  });
  assert.equal(view.measured, false);
  assert.equal(view.swept, null);
  assert.equal(view.disabledReasonLabel, 'sem token destrutivo para aplicar');
});

test('modo efetivo em LEITURA: badges, agendador e contadores medidos', () => {
  const view = sweepsCardView({
    ok: true,
    enabled: true,
    scheduled: true,
    mode: 'read_only',
    intervalMs: 21_600_000,
    running: false,
    nextDueAt: 1_793_245_200_000,
    disabledReason: null,
    counters: { runs: 2, manualRuns: 0, planned: 7, swept: 0, sweptUndubbed: 0, failed: 0, blocked: 3, reasons: { not_due: 12 } },
    last: { at: 1_793_223_600_000, manual: false, outcomes: [], missing: [] },
    pulledAt: '2026-10-29T12:34:00.000Z',
  });
  assert.equal(view.available, true);
  assert.equal(view.modeLabel, 'LEITURA');
  assert.equal(view.modeVariant, 'ok');
  assert.equal(view.scheduled, true);
  assert.equal(view.running, false);
  assert.equal(view.measured, true);
  assert.equal(view.intervalLabel, '6 h');
  assert.match(view.lastTickLabel, STAMP);
  assert.match(view.lastTickLabel, /agendado$/);
  assert.match(view.nextDueLabel, /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.match(view.startedLabel, /^—$|^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.match(view.pulledLabel, STAMP);
  assert.equal(view.planned, 7);
  assert.equal(view.swept, 0, 'zero MEDIDO pelo gateway continua zero');
  assert.equal(view.sweptUndubbed, 0);
  assert.equal(view.failed, 0);
  assert.equal(view.blocked, 3);
  assert.equal(view.runsLabel, '2');
  assert.deepEqual(view.topReasons, [{ reason: 'not_due', label: 'motivo: not_due', count: 12 }]);
});

test('modo APLICA em voo: selo NEUTRO ("aguarde"), nunca o vermelho de falha', () => {
  const sweeps = {
    ok: true,
    mode: 'apply',
    scheduled: true,
    running: true,
    intervalMs: 3_600_000,
    counters: { runs: 2, manualRuns: 1, planned: 4, swept: 3, sweptUndubbed: 1, failed: 1, blocked: 0 },
    last: { at: 1_793_223_600_000, manual: true },
  };
  const view = sweepsCardView(sweeps);
  assert.equal(view.modeLabel, 'APLICA');
  assert.equal(view.modeVariant, 'warn');
  assert.equal(view.running, true);
  assert.equal(view.intervalLabel, '1 h');
  assert.match(view.lastTickLabel, /manual$/);
  assert.equal(view.runsLabel, '2 · 1 manual(is)');
  // `sweptUndubbed` ausente é derivado de byKind; sem byKind fica `null`.
  assert.equal(view.sweptUndubbed, 1);
  assert.equal(sweepsCardView({ ok: true, mode: 'apply', counters: { runs: 1 } }).sweptUndubbed, null);
  assert.equal(
    sweepsCardView({ ok: true, mode: 'apply', counters: { runs: 1, byKind: { sweepUndubbed: { swept: 5 } } } }).sweptUndubbed,
    5,
    'atalho derivado do byKind quando o gateway só manda o detalhe',
  );
  assert.equal(SWEEPS_RUNNING_BADGE.variant, 'neutral');
  const running = badge(SweepsCard({ sweeps }), 'EM VOO');
  assert.ok(running, 'a rodada em voo aparece no cartão');
  assert.match(running.props.class, /painel-badge-neutral/);
  assert.doesNotMatch(running.props.class, /painel-badge-err/);
});

test('campos que chegam e precisam aparecer: runs, startedAt, pulledAt, missing, stopped', () => {
  const view = sweepsCardView({
    ok: true,
    mode: 'apply',
    scheduled: true,
    intervalMs: 21_600_000,
    startedAt: 1_793_100_000_000,
    lastTickAt: 1_793_223_600_000,
    nextDueAt: 1_793_245_200_000,
    disabledReason: null,
    counters: { runs: 3, manualRuns: 1, planned: 4, swept: 3, failed: 0, blocked: 0, missing: 1 },
    last: {
      at: 1_793_223_600_000,
      manual: true,
      outcomes: [{ kind: 'sweepDead', stopped: null }],
      missing: ['revalidate'],
    },
    pulledAt: '2026-10-29T12:34:00.000Z',
  });
  assert.equal(view.measured, true);
  assert.equal(view.runsLabel, '3 · 1 manual(is)');
  assert.match(view.startedLabel, STAMP);
  assert.match(view.pulledLabel, STAMP);
  assert.equal(view.missingLabel, 'revalidate');
  assert.equal(view.stoppedLabel, null);
  assert.match(view.lastTickLabel, /manual$/);

  const stopped = sweepsCardView({
    ok: true,
    mode: 'apply',
    counters: { runs: 1 },
    last: { at: 1_793_223_600_000, manual: false, missing: [], outcomes: [{ kind: 'sweepDead', stopped: 'quota' }] },
  });
  assert.equal(stopped.stoppedLabel, 'sweepDead: cota do serviço esgotada');
  assert.match(textOf(SweepsCard({
    sweeps: {
      ok: true, mode: 'apply', counters: { runs: 1 },
      last: { at: 1_793_223_600_000, manual: false, missing: [], outcomes: [{ kind: 'sweepDead', stopped: 'quota' }] },
    },
  })), /Última rodada interrompida —\s+sweepDead: cota do serviço esgotada/);

  // Sem `last.missing`, a contagem de `counters.missing` ainda diz que faltou.
  assert.equal(
    sweepsCardView({ ok: true, mode: 'apply', counters: { runs: 1, missing: 2 }, last: { at: 1, manual: false } }).missingLabel,
    '2 tipo(s)',
  );
});

test('mapa de modo é por chave própria: `constructor`/`__proto__` não viram modo válido', () => {
  for (const mode of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nao-existe']) {
    const view = sweepsCardView({ ok: true, mode });
    assert.equal(view.available, false, `modo hostil "${mode}" não pode passar pelo lookup`);
    assert.equal(view.modeLabel, 'SEM STATUS');
    assert.equal(view.modeVariant, 'neutral');
  }
  // `byKind` também vem da rede: herdar `swept` de Object.prototype não vale.
  const view = sweepsCardView({
    ok: true,
    mode: 'read_only',
    counters: { runs: 1, byKind: { sweepUndubbed: { constructor: 7 } } },
    last: { at: 1, manual: false },
  });
  assert.equal(view.sweptUndubbed, null);
});

test('motivo desconhecido nunca vira undefined nem [object Object]', () => {
  assert.equal(sweepReasonLabel('motivo_novo'), 'motivo: motivo_novo');
  assert.equal(sweepReasonLabel('quota'), 'cota do serviço esgotada');
  assert.equal(sweepReasonLabel(undefined), 'motivo não informado');
  assert.equal(sweepReasonLabel({ toString: () => 'x' }), 'motivo não informado');
  const rows = topSweepReasons({ motivo_novo: 2 });
  assert.deepEqual(rows, [{ reason: 'motivo_novo', label: 'motivo: motivo_novo', count: 2 }]);
  assert.doesNotMatch(rows.map((r) => r.label).join(' '), /undefined|object Object/);
});

test('topSweepReasons: três maiores, empate pelo nome (ordem estável)', () => {
  const rows = topSweepReasons({ zeta: 2, alfa: 2, beta: 9, gama: 1 });
  assert.deepEqual(rows, [
    { reason: 'beta', label: 'motivo: beta', count: 9 },
    { reason: 'alfa', label: 'motivo: alfa', count: 2 },
    { reason: 'zeta', label: 'motivo: zeta', count: 2 },
  ]);
  assert.deepEqual(topSweepReasons(null), []);
  assert.deepEqual(topSweepReasons([1, 2, 3]), []);
});

test('sweepToast: plano em leitura, em voo, concluída, interrompida e recusada', () => {
  assert.equal(
    sweepToast({ applied: false, planned: 12, varridos: 0 }),
    'Plano: 12 alvo(s) · modo leitura, nada removido',
  );
  assert.equal(
    sweepToast({ applied: false, planned: null, varridos: null }),
    'Plano: ? alvo(s) · modo leitura, nada removido',
    'contagem ausente não vira zero',
  );
  assert.equal(sweepToast({ pending: true }), 'Varredura em andamento; acompanhe o status nativo');
  assert.equal(sweepToast({ timedOut: true }), 'Varredura em andamento; acompanhe o status nativo');
  assert.equal(sweepToast({ applied: true, varridos: 4, falhas: 1 }), 'Varredura concluída: 4 removido(s) · 1 falha(s)');
  assert.equal(sweepToast({ applied: true, swept: 3, failed: 0 }), 'Varredura concluída: 3 removido(s)');
  assert.equal(sweepToast(null), 'Varredura concluída: ? removido(s)');
  assert.equal(sweepToast({ ran: false, reason: 'sweeps_disabled' }), 'Varredura recusada · varreduras desligadas no gateway');
  assert.equal(sweepToast({ ran: false }), 'Varredura recusada pelo gateway');
});

test('stopped:"quota" produz toast de INTERROMPIDA, com o motivo em PT-BR', () => {
  const result = { ok: true, ran: true, applied: true, stopped: 'quota', varridos: 2, swept: 2 };
  assert.equal(sweepOutcome(result), 'stopped');
  const toast = sweepToast(result);
  assert.match(toast, /Varredura interrompida/);
  assert.match(toast, /cota do serviço esgotada/);
  assert.match(toast, /2 removido\(s\) até parar/);
  assert.doesNotMatch(toast, /concluída/, 'parada por cota não é varredura concluída');
  assert.match(sweepToast({ stopped: 'auth', varridos: 0 }), /credencial recusada pelo serviço/);
  assert.match(sweepToast({ stopped: 'novo_motivo' }), /motivo: novo_motivo/);
});

test('busy:true é ESPERA (neutro), nunca falha', () => {
  const busy = { ok: false, ran: false, busy: true, reason: 'reentered' };
  assert.equal(sweepOutcome(busy), 'waiting');
  const toast = sweepToast(busy);
  assert.equal(toast, 'Outra varredura em andamento; aguarde o ciclo atual terminar');
  assert.doesNotMatch(toast, /falha|erro|recusada/i);
});

test('ViewLimpeza exibe o cartão e usa o helper do toast', () => {
  // Lê o FONTE: o JSX abaixo não sobrevive ao emit, então o caminho sai de
  // `dist/test` para a raiz real do repo (`../../src`).
  const src = readFileSync(new URL('../../src/client/painel/view-limpeza.ts', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/limpeza\/view-sweeps\.js'/);
  assert.match(src, /<\$\{SweepsCard\} sweeps=\$\{debrid\?\.sweeps\}/, 'a foto vem do bloco debrid');
  assert.match(src, /successToast: \(data\) => sweepToast\(data\.result\)/, 'desfechos no helper');
  assert.equal(typeof SweepsCard, 'function');
  assert.equal(Reexportado, SweepsCard, 'reexportado para o import antigo da aba');

  const card = readFileSync(new URL('../../src/client/painel/limpeza/view-sweeps.ts', import.meta.url), 'utf8');
  assert.match(card, /status nativo indisponível/);
  assert.match(card, /Varridos e removidos/, 'o cartão mostra o vocabulário do operador');
  assert.doesNotMatch(card, /Number\([^)]*\|\|\s*0\)/, 'contador ausente não é coagido a zero');
  // O módulo passou a importar `../limpeza-model.js`: o grafo do browser só
  // resolve módulo que esteja na allowlist fechada da rota.
  assert.match(card, /from '\.\.\/limpeza-model\.js'/);
  assert.ok(CLIENT_ASSETS.includes('client/painel/limpeza/view-sweeps.js'));
  assert.ok(CLIENT_ASSETS.includes('client/painel/limpeza-model.js'));
});
