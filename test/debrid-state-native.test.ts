// Contrato da ponte Node → ESTADO nativo de debrid (T2-L5a): `davail:v1` (⚡ por
// hash/conta) e `mag:v1` (alive/bad/lie). O núcleo Rust (`adom-index`) é o dono
// da REGRA — TTL, escopo de conta e precedência estão cobertos por
// `cargo test -p adom-index davail_state` / `magnet_state`; aqui provamos que o
// handle expõe esse veredito sem inventar nada.
//
// Isolamento: os handles são INJETADOS em `:memory:` no `beforeEach`. Nenhum
// teste cai no `cache.db` do config, mesmo que a suíte rode fora do `setup-env`
// (que pina `CACHE_PERSIST=false`).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  davailState,
  debridStateHandles,
  magnetState,
  resetDebridStateForTest,
  setDebridStateForTest,
} from '../src/utils/debrid-state-native.js';

const ADAPTER = 'premiumize';
const CONTA_A = 'chave-da-conta-a';
const CONTA_B = 'chave-da-conta-b';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

// Relógio fixo: o TTL é do Rust, então nada aqui depende do horário real.
const AGORA = 1_760_000_000_000;
const TTL = 7 * 24 * 3600;
// Janela curta do `davail`: só precisa ser positiva e sobreviver à leitura em AGORA.
const JANELA_S = 600;

beforeEach(() => {
  setDebridStateForTest(debridStateHandles(':memory:'));
});

afterEach(() => {
  resetDebridStateForTest();
});

test('ttl zero desliga a janela e não grava', () => {
  const davail = davailState();
  // Mesma regra do cache.setMany (filtra ttlSeconds <= 0): TTL zero DESLIGA a janela, não é permanente.
  davail.put(ADAPTER, CONTA_A, A, true, 0, AGORA);
  davail.put(ADAPTER, CONTA_A, B, false, 0, AGORA);
  davail.putMany(ADAPTER, CONTA_A, [{ hash: C, cached: true }], 0, AGORA);

  assert.equal(davail.get(ADAPTER, CONTA_A, A, AGORA), null, 'positivo com ttl zero não grava');
  assert.equal(davail.get(ADAPTER, CONTA_A, B, AGORA), null, 'negativo com ttl zero vira ausente, não 0');
  assert.equal(davail.get(ADAPTER, CONTA_A, C, AGORA), null, 'putMany com ttl zero não grava');
});

test('ttl positivo expira no relógio do chamador', () => {
  const davail = davailState();
  davail.put(ADAPTER, CONTA_A, A, true, JANELA_S, AGORA);

  assert.equal(davail.get(ADAPTER, CONTA_A, A, AGORA + 599_000), true, 'ainda dentro da janela');
  // Vencido, a leitura do Rust apaga a linha e devolve ausência.
  assert.equal(davail.get(ADAPTER, CONTA_A, A, AGORA + 601_000), null, 'janela vencida');
});

test('escopo por conta: o mesmo hash gravado na conta A não responde para a conta B', () => {
  const davail = davailState();
  davail.put(ADAPTER, CONTA_A, A, true, JANELA_S, AGORA);

  assert.equal(davail.get(ADAPTER, CONTA_A, A, AGORA), true);
  assert.equal(davail.get(ADAPTER, CONTA_B, A, AGORA), null, 'outra conta nunca herda o ⚡');
});

test('getMany devolve só os presentes, na ordem pedida, com hash em minúsculas', () => {
  const davail = davailState();
  davail.put(ADAPTER, CONTA_A, A, true, JANELA_S, AGORA);
  davail.put(ADAPTER, CONTA_A, B, false, JANELA_S, AGORA);

  // C não foi gravado: fica fora. B vem antes de A porque foi pedido assim, e
  // o negativo (false) também é "presente" — só não é positivo.
  const flags = davail.getMany(ADAPTER, CONTA_A, [B.toUpperCase(), C, A.toUpperCase()], AGORA);
  assert.deepEqual(flags, [
    { hash: B, cached: false },
    { hash: A, cached: true },
  ]);
});

test('conta vazia não lê nem grava: get é null, getMany é vazio e o put não deixa rastro', () => {
  const davail = davailState();
  davail.put('', CONTA_A, A, true, JANELA_S, AGORA);
  davail.put(ADAPTER, '', A, true, JANELA_S, AGORA);
  davail.putMany('', CONTA_A, [{ hash: A, cached: true }], JANELA_S, AGORA);
  davail.putMany(ADAPTER, '', [{ hash: A, cached: true }], JANELA_S, AGORA);

  assert.equal(davail.get('', CONTA_A, A, AGORA), null, 'sem adapter não há leitura');
  assert.equal(davail.get(ADAPTER, '', A, AGORA), null, 'sem chave não há leitura');
  assert.equal(davail.get(ADAPTER, CONTA_A, A, AGORA), null, 'o put de conta vazia não gravou na conta real');

  const semAdapter = davail.getMany('', CONTA_A, [A], AGORA);
  const semChave = davail.getMany(ADAPTER, '', [A], AGORA);
  assert.equal(semAdapter.length, 0);
  assert.equal(semChave.length, 0);
});

test('markAlive conta nascidas (1ª > 0, 2ª = 0) e o estado vira alive', () => {
  const magnet = magnetState();
  assert.equal(magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA), 1, 'a chave nasceu');
  assert.equal(magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA + 1000), 0, 'renovação não nasce de novo');
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'alive');
});

test('markBad vence: o estado vira bad e o alive do mesmo hash foi apagado', () => {
  const magnet = magnetState();
  magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA);
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'alive');

  assert.equal(magnet.markBad(ADAPTER, CONTA_A, A, TTL, AGORA), true, 'o bad nasceu');
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'bad');
  assert.equal(magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA), 0, 'bad vivo recusa a renovação');
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'bad', 'o novo markAlive não ressuscita');

  // Sem o bad, não sobra nada: o alive foi mesmo apagado pelo markBad (se
  // tivesse sobrevivido, o state voltaria "alive" aqui).
  assert.equal(magnet.forgetBad(ADAPTER, CONTA_A, A), true);
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), null);
});

test('markLie não apaga o alive e tem precedência na leitura; forgetBad não mexe no lie', () => {
  const magnet = magnetState();
  magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA);
  assert.equal(magnet.markLie(ADAPTER, CONTA_A, A, TTL, AGORA), true, 'o lie nasceu');
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'lie', 'lie > alive');

  // 0 = a chave `alive` continua existindo (presença física): o lie não a apagou.
  assert.equal(magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA), 0, 'o alive segue lá');

  assert.equal(magnet.forgetBad(ADAPTER, CONTA_A, A), false, 'não havia bad para apagar');
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'lie', 'o lie sobrevive ao forgetBad');
});

test('forgetBad devolve true só quando havia bad e o estado volta ao que sobrou', () => {
  const magnet = magnetState();

  // bad sozinho: apaga e não sobra nada.
  assert.equal(magnet.markBad(ADAPTER, CONTA_A, A, TTL, AGORA), true);
  assert.equal(magnet.forgetBad(ADAPTER, CONTA_A, A), true, 'havia bad');
  assert.equal(magnet.forgetBad(ADAPTER, CONTA_A, A), false, 'na segunda vez não havia o que apagar');
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), null);

  // bad + lie: o forget tira SÓ o bad, então o lie reaparece.
  magnet.markLie(ADAPTER, CONTA_A, B, TTL, AGORA);
  magnet.markBad(ADAPTER, CONTA_A, B, TTL, AGORA);
  assert.equal(magnet.state(ADAPTER, CONTA_A, B, AGORA), 'bad', 'bad > lie');
  assert.equal(magnet.forgetBad(ADAPTER, CONTA_A, B), true);
  assert.equal(magnet.state(ADAPTER, CONTA_A, B, AGORA), 'lie');

  // Hash liberado volta a nascer como alive.
  assert.equal(magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA), 1);
  assert.equal(magnet.state(ADAPTER, CONTA_A, A, AGORA), 'alive');
});

test('stateSnapshot devolve uma entrada por hash, na ordem pedida, com null nos sem marca', () => {
  const magnet = magnetState();
  magnet.markAlive(ADAPTER, CONTA_A, [A], TTL, AGORA);
  magnet.markBad(ADAPTER, CONTA_A, B, TTL, AGORA);
  magnet.markLie(ADAPTER, CONTA_A, C, TTL, AGORA);

  const snap = magnet.stateSnapshot(ADAPTER, CONTA_A, [C, D, A, B], AGORA);
  assert.deepEqual(snap, [
    { hash: C, state: 'lie' },
    { hash: D, state: null },
    { hash: A, state: 'alive' },
    { hash: B, state: 'bad' },
  ]);
});
