// Cartão "Varreduras nativas (AllDebrid)" da aba Limpeza e o toast da ação
// `sweep-dead`. O que estes testes travam:
//   - sem a foto do gateway, NADA de zeros: as contagens ficam `null` e a view
//     diz "status nativo indisponível";
//   - modo é o EFETIVO do gateway (LEITURA/APLICA/DESLIGADO), não o pedido;
//   - o toast distingue plano em leitura, varredura em voo e concluída.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SweepsCard, sweepsCardView, topSweepReasons } from '../src/client/painel/limpeza/view-sweeps.js';
import { sweepToast } from '../src/client/painel/limpeza-model.js';
import { SweepsCard as Reexportado } from '../src/client/painel/view-limpeza.js';

const STAMP = /\d{2}\/\d{2} \d{2}:\d{2}/;

test('sem a foto do gateway: cartão indisponível, contagens em branco (zero nunca inventado)', () => {
  for (const entry of [null, undefined, {} as any, { mode: 'nao-existe' } as any]) {
    const view = sweepsCardView(entry as any);
    assert.equal(view.available, false);
    assert.equal(view.modeLabel, 'SEM STATUS');
    assert.equal(view.planned, null);
    assert.equal(view.swept, null);
    assert.equal(view.sweptUndubbed, null);
    assert.equal(view.failed, null);
    assert.equal(view.blocked, null);
    assert.equal(view.lastTickLabel, '—');
    assert.equal(view.nextDueLabel, '—');
    assert.deepEqual(view.topReasons, []);
  }
});

test('modo efetivo em LEITURA: badges, agendador e contadores medidas', () => {
  const view = sweepsCardView({
    ok: true,
    enabled: true,
    scheduled: true,
    mode: 'read_only',
    intervalMs: 21_600_000,
    running: false,
    nextDueAt: 1_793_245_200_000,
    disabledReason: null,
    counters: { planned: 7, swept: 0, sweptUndubbed: 0, failed: 0, blocked: 3, reasons: { not_due: 12 } },
    last: { at: 1_793_223_600_000, manual: false, outcomes: [], missing: [] },
  });
  assert.equal(view.available, true);
  assert.equal(view.modeLabel, 'LEITURA');
  assert.equal(view.modeVariant, 'ok');
  assert.equal(view.scheduled, true);
  assert.equal(view.running, false);
  assert.equal(view.intervalLabel, '6 h');
  assert.match(view.lastTickLabel, STAMP);
  assert.match(view.lastTickLabel, /agendado$/);
  assert.match(view.nextDueLabel, /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(view.planned, 7);
  assert.equal(view.swept, 0, 'zero MEDIDO pelo gateway continua zero');
  assert.equal(view.sweptUndubbed, 0);
  assert.equal(view.failed, 0);
  assert.equal(view.blocked, 3);
  assert.deepEqual(view.topReasons, [{ reason: 'not_due', count: 12 }]);
});

test('modo APLICA em voo: badge de atenção e tick manual', () => {
  const view = sweepsCardView({
    mode: 'apply',
    scheduled: true,
    running: true,
    intervalMs: 3_600_000,
    counters: { planned: 4, swept: 3, sweptUndubbed: 1, failed: 1, blocked: 0 },
    last: { at: 1_793_223_600_000, manual: true },
  });
  assert.equal(view.modeLabel, 'APLICA');
  assert.equal(view.modeVariant, 'warn');
  assert.equal(view.running, true);
  assert.equal(view.intervalLabel, '1 h');
  assert.match(view.lastTickLabel, /manual$/);
  // `sweptUndubbed` ausente é derivado de byKind; sem byKind fica `null`.
  assert.equal(view.sweptUndubbed, 1);
  assert.equal(sweepsCardView({ mode: 'apply', counters: {} }).sweptUndubbed, null);
  assert.equal(
    sweepsCardView({ mode: 'apply', counters: { byKind: { sweepUndubbed: { swept: 5 } } } }).sweptUndubbed,
    5,
    'atalho derivado do byKind quando o gateway só manda o detalhe',
  );
});

test('modo DESLIGADO: motivo do gateway vai para a tela, sem contadores inventados', () => {
  const view = sweepsCardView({ mode: 'off', scheduled: false, intervalMs: 0, disabledReason: 'cleanup_off' });
  assert.equal(view.modeLabel, 'DESLIGADO');
  assert.equal(view.modeVariant, 'neutral');
  assert.equal(view.scheduled, false);
  assert.equal(view.intervalLabel, '—', 'intervalo zero não vira "0 s"');
  assert.equal(view.disabledReason, 'cleanup_off');
  assert.equal(view.planned, null);
});

test('topSweepReasons: três maiores, empate pelo nome (ordem estável)', () => {
  const rows = topSweepReasons({ zeta: 2, alfa: 2, beta: 9, gama: 1 });
  assert.deepEqual(rows, [
    { reason: 'beta', count: 9 },
    { reason: 'alfa', count: 2 },
    { reason: 'zeta', count: 2 },
  ]);
  assert.deepEqual(topSweepReasons(null), []);
  assert.deepEqual(topSweepReasons([1, 2, 3]), []);
});

test('sweepToast: plano em leitura, varredura em voo e concluída', () => {
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
});

test('ViewLimpeza exibe o cartão e usa o helper do toast', () => {
  // Lê o FONTE: o JSX abaixo não sobrevive ao emit, então o caminho sai de
  // `dist/test` para a raiz real do repo (`../../src`).
  const src = readFileSync(new URL('../../src/client/painel/view-limpeza.ts', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/limpeza\/view-sweeps\.js'/);
  assert.match(src, /<\$\{SweepsCard\} sweeps=\$\{debrid\?\.sweeps\}/, 'a foto vem do bloco debrid');
  assert.match(src, /successToast: \(data\) => sweepToast\(data\.result\)/, 'três desfechos no helper');
  assert.equal(typeof SweepsCard, 'function');
  assert.equal(Reexportado, SweepsCard, 'reexportado para o import antigo da aba');

  const card = readFileSync(new URL('../../src/client/painel/limpeza/view-sweeps.ts', import.meta.url), 'utf8');
  assert.match(card, /status nativo indisponível/);
  assert.match(card, /Varridos e removidos/, 'o cartão mostra o vocabulário do operador');
  assert.doesNotMatch(card, /Number\([^)]*\|\|\s*0\)/, 'contador ausente não é coagido a zero');
});
