// Gate do relógio de poda (`mag-davail-sweep.ts`): o único sweep físico de
// `mag` e `davail` é o setInterval de 10 min deste módulo — o Rust não faz
// varredura própria e o TTL só esconde a linha na leitura. Prova que
// sweepNativeNamespaces() remove a vencida nos DOIS namespaces (o núcleo
// reporta a contagem removida — a prova física), preserva a viva e é
// idempotente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { davailState, magnetState } from '../src/utils/debrid-state-native.js';
import { sweepNativeNamespaces } from '../src/utils/mag-davail-sweep.js';

const ADAPTER = 'sweepfake';
const CONTA = 'conta-sweep';

test('sweepNativeNamespaces: poda a vencida de mag e davail, preserva a viva e é idempotente', async () => {
  const hVencida = 'a'.repeat(40);
  const hViva = 'b'.repeat(40);
  const hDavail = 'c'.repeat(40);
  const now = Date.now();
  // TTL de 1s nas duas pontas: vence antes da chamada (o teste dorme 1.1s);
  // a viva do mag leva 60s para não morrer na mesma varredura.
  magnetState().markAlive(ADAPTER, CONTA, [hVencida], 1, now);
  magnetState().markAlive(ADAPTER, CONTA, [hViva], 60, now);
  davailState().put(ADAPTER, CONTA, hDavail, true, 1, now);
  await new Promise((r) => setTimeout(r, 1100));

  const primeiro = sweepNativeNamespaces();
  assert.ok(primeiro.mag.expired >= 1, 'alive vencida sai fisicamente do mag');
  assert.ok(primeiro.davail.expired >= 1, 'linha vencida sai fisicamente do davail');
  assert.equal(
    davailState().get(ADAPTER, CONTA, hDavail, Date.now()),
    null,
    'davail vencido não responde mais (apagado, não só escondido)',
  );

  // A viva do mag sobrevive: o sweep só tira vencidas (o teto não foi
  // atingido) — e o reconto do status passa a vê-la.
  const sobrou = magnetState()
    .summary(Date.now())
    .find((r) => r.adapter === ADAPTER && r.side === 'alive');
  assert.ok(sobrou && sobrou.count >= 1, 'a viva continua no físico/reconto');

  const segundo = sweepNativeNamespaces();
  assert.equal(segundo.mag.expired + segundo.davail.expired, 0, 'segunda passada não tem o que apagar');
});
