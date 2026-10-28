// Teto por OBRA (F2) — `src/providers/autofetch-obra.ts` FICA. A reserva é
// síncrona e o registro durável é do KV nativo, então o teste mede o TETO sem
// o corpo do runner: nada aqui dispara enqueue nem caminho de rede.
//
// A ORDEM dos portões subiu para o núcleo (`adom-core::autofetch_gates`), que é
// quem decide no worker; a prova local é pelo napi (`classifyEnqueue` /
// `rollbackFor`) — ver `cargo test -p adom-core autofetch_gates`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import { kvForget } from '../src/utils/native-kv.js';
import { accountScope } from '../src/utils/request-key.js';
import { nativeCore } from '../src/utils/native-core.js';
import {
  reserveObra, commitObra, releaseObra, obraRecord, obraKey, obraStatus, resetObraForTest,
} from '../src/providers/autofetch-obra.js';

const PM = 'premiumize';
const hx = (seed: string) => seed.repeat(40).slice(0, 40);
const trash: string[] = [];

type IdentityOpts = { imdbId?: string | null; season?: number | null; episode?: number | null; searchKey?: string | null };
function identity(apiKey: string, o: IdentityOpts = {}) {
  return {
    adapterId: PM, account: accountScope(apiKey),
    imdbId: o.imdbId ?? null, season: o.season ?? null, episode: o.episode ?? null, searchKey: o.searchKey ?? null,
  };
}
function trackKey(apiKey: string, o: IdentityOpts = {}) {
  const key = obraKey(identity(apiKey, o));
  trash.push(key);
  return key;
}
function forgetHashes(apiKey: string, hashes: string[]) {
  const account = accountScope(apiKey);
  for (const h of hashes) {
    kvForget(autofetch.markerKey(PM, account, h));
    held.release(h, account);
  }
  autofetch.resetBudget(PM, account);
}

before(() => {
  autofetchLive.reset();
  resetObraForTest();
});
after(() => {
  autofetchLive.reset();
  resetObraForTest();
  autofetch.resetBudget();
  // `o:` é RUST_OWNED: a limpeza do registro é da ponte.
  for (const key of trash) kvForget(key);
});

// --- Portões (núcleo) -------------------------------------------------------

type EnqueueGatesIn = {
  isPaused: boolean; isDead: boolean; isCached: boolean; markerActive: boolean;
  lockAcquired: boolean; slotAcquired: boolean; obraCapGranted: boolean;
  accountBlocked: boolean; budgetGranted: boolean;
};
type GateCore = {
  classifyEnqueue(gates: EnqueueGatesIn): string | null;
  rollbackFor(reason: string): string[] | null;
};

const HAPPY: EnqueueGatesIn = {
  isPaused: false, isDead: false, isCached: false, markerActive: false,
  lockAcquired: true, slotAcquired: true, obraCapGranted: true,
  accountBlocked: false, budgetGranted: true,
};

test('ordem dos portões: obra-cap entre slot e account-gate; rollback devolve a reserva', () => {
  const core = nativeCore<GateCore>();
  assert.equal(core.classifyEnqueue(HAPPY), null, 'caminho feliz não fecha portão');

  // O PRIMEIRO que fecha vence — a ordem é o contrato, não só o conjunto.
  assert.equal(core.classifyEnqueue({ ...HAPPY, isPaused: true, isDead: true }), 'paused');
  assert.equal(core.classifyEnqueue({ ...HAPPY, isDead: true, isCached: true }), 'dead');
  assert.equal(core.classifyEnqueue({ ...HAPPY, isCached: true, markerActive: true }), 'already-cached');
  assert.equal(core.classifyEnqueue({ ...HAPPY, markerActive: true, lockAcquired: false }), 'marker');
  assert.equal(core.classifyEnqueue({ ...HAPPY, lockAcquired: false, slotAcquired: false }), 'in-flight');
  assert.equal(core.classifyEnqueue({ ...HAPPY, slotAcquired: false, obraCapGranted: false }), 'search-slot-busy');
  assert.equal(core.classifyEnqueue({ ...HAPPY, obraCapGranted: false, accountBlocked: true }), 'obra-cap',
    'o teto da obra é avaliado DEPOIS de lock/slot e ANTES da conta');
  assert.equal(core.classifyEnqueue({ ...HAPPY, accountBlocked: true, budgetGranted: false }), 'account-gate');
  assert.equal(core.classifyEnqueue({ ...HAPPY, budgetGranted: false }), 'budget');

  assert.deepEqual(core.rollbackFor('obra-cap'), ['lock', 'slot', 'hold'], 'cap negado: nada da obra a devolver');
  assert.deepEqual(core.rollbackFor('account-gate'), ['obra', 'lock', 'slot', 'hold'], 'gate posterior devolve a reserva');
  assert.deepEqual(core.rollbackFor('budget'), ['obra', 'lock', 'slot', 'hold']);
  assert.deepEqual(core.rollbackFor('in-flight'), [], 'hash em voo não solta o hold');
  assert.equal(core.rollbackFor('unknown'), null, 'motivo fora da tabela não tem rollback');
});

// --- Teto por obra ----------------------------------------------------------

test('4 searchKeys da MESMA obra aceitam no máximo 2 seeds', () => {
  const apiKey = 'chave-obra-seeds';
  const imdbId = 'tt7000001';
  const o = { imdbId, season: 1, episode: 1 };
  autofetchLive.set({ autoFetchTopSeedsMax: 2, autoFetchRareMax: 4, autoFetchTtl: 3600 });
  trackKey(apiKey, o);
  const hashes = ['a1', 'b2', 'c3', 'd4'].map(hx);
  try {
    const id = identity(apiKey, o);
    const leases = hashes.map((hash) => reserveObra({ ...id, pool: 'seeds', hash }));
    assert.equal(leases[0] !== null, true, '1ª busca cabe');
    assert.equal(leases[1] !== null, true, '2ª busca cabe');
    assert.equal(leases[2], null, '3ª busca estoura o teto');
    assert.equal(leases[3], null, '4ª busca estoura o teto');
    commitObra(leases[0], { hash: hashes[0], pool: 'seeds' });
    commitObra(leases[1], { hash: hashes[1], pool: 'seeds' });
    assert.equal(obraRecord(id).filter((e) => e.pool === 'seeds').length, 2);
    assert.equal(reserveObra({ ...id, pool: 'seeds', hash: hx('e5') }), null, 'teto segue fechado após o aceite');
  } finally {
    forgetHashes(apiKey, hashes);
  }
});

test('reserva síncrona barra a segunda busca antes do aceite resolver', () => {
  const apiKey = 'chave-obra-conc';
  const imdbId = 'tt7000002';
  autofetchLive.set({ autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId });
  const h1 = hx('e5'); const h2 = hx('f6'); const h3 = hx('a7');
  try {
    const id = identity(apiKey, { imdbId });
    const lease = reserveObra({ ...id, pool: 'any', hash: h1 });
    assert.ok(lease, 'primeira reserva em voo');
    assert.equal(reserveObra({ ...id, pool: 'any', hash: h2 }), null, 'a reserva em voo já ocupa a vaga any');
    assert.equal(obraRecord(id).length, 0, 'reserva não é registro: nada foi aceito ainda');

    releaseObra(lease);
    const segunda = reserveObra({ ...id, pool: 'any', hash: h2 });
    assert.ok(segunda, 'devolver a reserva reabre a vaga');
    commitObra(segunda, { hash: h2, pool: 'any' });
    assert.equal(reserveObra({ ...id, pool: 'any', hash: h3 }), null, 'após o aceite a vaga segue ocupada');
  } finally {
    forgetHashes(apiKey, [h1, h2, h3]);
  }
});

test('registro persistido sobrevive ao reset volátil do módulo', () => {
  const apiKey = 'chave-obra-persist';
  const imdbId = 'tt7000005';
  autofetchLive.set({ autoFetchMax: 1, autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId });
  const id = identity(apiKey, { imdbId });
  const h1 = hx('77');
  try {
    const lease = reserveObra({ ...id, pool: 'br', hash: h1 });
    assert.ok(lease);
    commitObra(lease, { hash: h1, pool: 'br' });
    assert.equal(obraRecord(id).length, 1, 'aceite grava o registro');
    resetObraForTest();
    assert.equal(obraStatus().reserved, 0, 'reset limpa SÓ o volátil');
    assert.equal(obraRecord(id).length, 1, 'registro persistido sobrevive');
    assert.equal(reserveObra({ ...id, pool: 'br', hash: hx('88') }), null, 'o registro que sobreviveu ainda conta contra o teto');
  } finally {
    forgetHashes(apiKey, [h1]);
  }
});

test('episódios diferentes têm teto independente', () => {
  const apiKey = 'chave-obra-ep';
  const imdbId = 'tt7000006';
  autofetchLive.set({ autoFetchMax: 1, autoFetchTtl: 3600 });
  trackKey(apiKey, { imdbId, season: 1, episode: 1 });
  trackKey(apiKey, { imdbId, season: 1, episode: 2 });
  const h1 = hx('99'); const h2 = hx('aa'); const h3 = hx('bb');
  try {
    const e1 = identity(apiKey, { imdbId, season: 1, episode: 1 });
    const e2 = identity(apiKey, { imdbId, season: 1, episode: 2 });
    const l1 = reserveObra({ ...e1, pool: 'br', hash: h1 });
    const l2 = reserveObra({ ...e2, pool: 'br', hash: h2 });
    assert.ok(l1, 'S1E1 tem vaga própria');
    assert.ok(l2, 'S1E2 tem vaga própria');
    commitObra(l1, { hash: h1, pool: 'br' });
    commitObra(l2, { hash: h2, pool: 'br' });
    assert.equal(reserveObra({ ...e1, pool: 'br', hash: h3 }), null, 'S1E1 saturado; S1E2 intacto');
  } finally {
    forgetHashes(apiKey, [h1, h2, h3]);
  }
});

test('pools br/any/seeds têm contadores separados', () => {
  const apiKey = 'chave-obra-pools';
  const imdbId = 'tt7000007';
  const o = { imdbId, season: 1, episode: 1 };
  autofetchLive.set({ autoFetchMax: 1, autoFetchTopSeedsMax: 1, autoFetchTtl: 3600 });
  trackKey(apiKey, o);
  const hashes = ['cc', 'dd', 'ee', 'ff', 'a0', 'b0'].map(hx);
  const [br1, any1, seeds1, br2, any2, seeds2] = hashes;
  try {
    const id = identity(apiKey, o);
    const pool = (hash: string, name: string) => {
      const lease = reserveObra({ ...id, pool: name, hash });
      assert.ok(lease, `${name} tinha vaga para ${hash.slice(0, 2)}`);
      commitObra(lease, { hash, pool: name });
    };
    pool(br1, 'br'); pool(any1, 'any'); pool(seeds1, 'seeds');
    assert.equal(reserveObra({ ...id, pool: 'br', hash: br2 }), null, 'br cheio');
    assert.equal(reserveObra({ ...id, pool: 'any', hash: any2 }), null, 'any cheio');
    assert.equal(reserveObra({ ...id, pool: 'seeds', hash: seeds2 }), null, 'seeds cheio');

    const rec = obraRecord(id);
    assert.equal(rec.filter((e) => e.pool === 'br').length, 1);
    assert.equal(rec.filter((e) => e.pool === 'any').length, 1);
    assert.equal(rec.filter((e) => e.pool === 'seeds').length, 1);
  } finally {
    forgetHashes(apiKey, hashes);
  }
});

test('seeds raro usa autoFetchRareMax como teto explícito', () => {
  const apiKey = 'chave-obra-rare';
  const imdbId = 'tt7000008';
  const o = { imdbId, season: 1, episode: 1 };
  autofetchLive.set({ autoFetchTopSeedsMax: 2, autoFetchRareMax: 4, autoFetchTtl: 3600 });
  trackKey(apiKey, o);
  const hashes = ['c0', 'd0', 'e0', 'f0', 'a1'].map(hx);
  try {
    const id = identity(apiKey, o);
    const oks = hashes.map((hash) => reserveObra({ ...id, pool: 'seeds', hash, rare: true }) !== null);
    assert.deepEqual(oks, [true, true, true, true, false], 'raro sobe o teto para rareMax (4)');

    // O slotLimit correspondente abre o mesmo teto no caminho do dreno, que
    // não carrega o booleano `rare` — e só o valor CHEIO de rareMax escala.
    const estreita = identity('chave-obra-rare-slot', o);
    trackKey('chave-obra-rare-slot', o);
    const baixos = ['b1', 'b2', 'b3'].map(hx);
    const comSlotBaixo = baixos.map((hash) => reserveObra({ ...estreita, pool: 'seeds', hash, slotLimit: 2 }) !== null);
    assert.deepEqual(comSlotBaixo, [true, true, false], 'slotLimit abaixo de rareMax NÃO é raro: o teto segue topSeedsMax');

    const alta = identity('chave-obra-rare-slot-alto', o);
    trackKey('chave-obra-rare-slot-alto', o);
    const altos = ['b4', 'b5', 'b6', 'b7', 'b8'].map(hx);
    const comSlotAlto = altos.map((hash) => reserveObra({ ...alta, pool: 'seeds', hash, slotLimit: 4 }) !== null);
    assert.deepEqual(comSlotAlto, [true, true, true, true, false], 'slotLimit >= rareMax vale como raro (teto 4)');
  } finally {
    forgetHashes(apiKey, hashes);
  }
});

test('overflow de upgrade: cap cheio por faixas baixas não bloqueia o 1080p novo; uma por janela', () => {
  const apiKey = 'chave-obra-overflow';
  const imdbId = 'tt7000010';
  const o = { imdbId, season: 1, episode: 1 };
  autofetchLive.set({ autoFetchMax: 3, autoFetchTtl: 3600 });
  trackKey(apiKey, o);
  const lows: Array<[string, string]> = [[hx('c0'), '720p'], [hx('c1'), '480p'], [hx('c2'), 'sd']];
  const extra = hx('c4');
  const bloqueados = [hx('c3'), hx('c5'), hx('c6')];
  try {
    const id = identity(apiKey, o);
    for (const [hash, quality] of lows) {
      const lease = reserveObra({ ...id, pool: 'br', hash, quality });
      assert.ok(lease, `cap ainda tinha vaga para ${quality}`);
      commitObra(lease, { hash, pool: 'br', quality });
    }
    // Cap normal (cheio) barra faixa repetida/inferior.
    assert.equal(reserveObra({ ...id, pool: 'br', hash: bloqueados[0], quality: '720p' }), null, 'faixa repetida não abre overflow');

    // Faixa-alvo ausente e superior ao pior registrado (sd) → UMA extra.
    const upgrade = reserveObra({ ...id, pool: 'br', hash: extra, quality: '1080p' });
    assert.ok(upgrade, '1080p ausente abre a reserva extra de upgrade');
    assert.equal(upgrade?.overflow, true, 'a reserva extra é marcada como overflow');
    commitObra(upgrade, { hash: extra, pool: 'br', quality: '1080p' });

    // Só UMA por janela.
    assert.equal(reserveObra({ ...id, pool: 'br', hash: bloqueados[1], quality: '1080p' }), null, 'faixa já presente não repete');
    assert.equal(reserveObra({ ...id, pool: 'br', hash: bloqueados[2], quality: '2160p' }), null, 'uma overflow por janela');

    const rec = obraRecord(id);
    assert.equal(rec.length, 4, 'três baixos + um overflow');
    assert.equal(rec.filter((e) => e.overflow === true).length, 1);
    assert.ok(rec.some((e) => e.hash === lows[0][0]), 'magnet antigo NÃO foi removido pelo overflow');

    // Cap normal invariável: abaixo do teto, a faixa-alvo entra sem overflow.
    const imdb2 = 'tt7000011';
    const o2 = { imdbId: imdb2 };
    trackKey(apiKey, o2);
    const id2 = identity(apiKey, o2);
    const b1 = hx('d0'); const b2 = hx('d1'); const b3 = hx('d2');
    for (const [hash, quality] of [[b1, '720p'], [b2, '720p']] as const) {
      const l = reserveObra({ ...id2, pool: 'br', hash, quality });
      assert.ok(l);
      commitObra(l, { hash, pool: 'br', quality });
    }
    const normal = reserveObra({ ...id2, pool: 'br', hash: b3, quality: '1080p' });
    assert.ok(normal, 'com vaga no cap, o 1080p entra normalmente');
    assert.equal(normal?.overflow, undefined, 'cap normal não vira overflow');
    commitObra(normal, { hash: b3, pool: 'br', quality: '1080p' });
    forgetHashes(apiKey, [b1, b2, b3]);
  } finally {
    forgetHashes(apiKey, [...lows.map(([h]) => h), ...bloqueados, extra]);
  }
});
