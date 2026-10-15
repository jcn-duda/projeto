// Fase 3 — cache de disponibilidade por hash (davail). O gate mediu 69% de
// repetição por hash na janela de 15 min; o L1 do registry responde pela conta
// dentro do TTL e a rede só é consultada para o que expirou ou nunca foi visto.
//
// Camada de TESTE da C3 do plano. Os TTLs curtos vêm do `test/setup-env.ts`
// (DEBRID_AVAIL_POS_TTL=2 / DEBRID_AVAIL_NEG_TTL=1): só estes testes consomem
// a camada, e o teste de expiração espera o timer REAL (~1,3s e ~2,6s).
//
// A camada vive no registry (C2): nenhum guard atual é alterado — a degradação
// por prazo e o piso da consulta não abortável continuam voltando ANTES da
// camada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import debrid from '../src/debrid/index.js';
import { AuthError } from '../src/debrid/common.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import type { DebridAdapter } from '../types/domain.js';

// runtime.run devolve unknown (o callback do AsyncLocalStorage não infere o
// retorno); o helper fixa o tipo do resultado sem inventar valor nenhum.
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

// Objeto anotado para o literal viajar com o formato documentado das opções do
// registry (`{ timeoutMs?, forceFresh? }`) sem depender de inferência na
// assinatura importada.
const forceFresh: { timeoutMs?: number; forceFresh?: boolean } = { forceFresh: true };

// Forma do retorno do registry que os testes consomem.
interface CheckResult {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string };
}

/**
 * Adaptador fake `cacheCheck: true` no registry real (mesmo padrão do
 * debrid-batch). O handler decide a resposta; `calls` registra cada conjunto
 * de hashes que a camada resolveu mandar à rede — é o único sinal de "quanto
 * o L1 respondeu sozinho".
 */
function makeFake(handler: (apiKey: string, infoHashes: string[]) => unknown) {
  const calls: string[][] = [];
  const adapter = {
    id: 'premiumize',
    label: 'Premiumize fake',
    short: 'pm',
    cacheCheck: true,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[]) {
      calls.push([...infoHashes]);
      return handler(_apiKey, infoHashes);
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;
  return { adapter, calls };
}

// Base comum de userOpts: o teste escolhe serviço e chave, o resto é default.
function userOpts(apiKey: string) {
  return {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
  };
}

const check = (opts: object, hashes: string[], options?: { timeoutMs?: number; forceFresh?: boolean }) =>
  runWith<CheckResult>({ opts, encoded: '' }, () => debrid.checkCached(hashes, options));

test('positivo em L1: segunda chamada do mesmo hash responde sem abrir rede', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-l1-pos');
  try {
    const first = await check(opts, ['pos-hit']);
    assert.equal(first.known, true);
    assert.deepEqual([...first.cached], ['pos-hit']);

    const second = await check(opts, ['pos-hit']);
    assert.equal(second.known, true, 'hit de L1 é confiável: só entra o que a API confirmou');
    assert.deepEqual([...second.cached], ['pos-hit']);
    assert.equal(calls.length, 1, 'a segunda chamada responde do L1, sem rede');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('negativo em L1: dentro do TTL devolve vazio com known:true, sem rede', async () => {
  const { adapter, calls } = makeFake(async () => ({ cached: new Set(), complete: true }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-l1-neg');
  try {
    const first = await check(opts, ['neg-hit']);
    assert.equal(first.known, true);
    assert.equal(first.cached.size, 0);

    const second = await check(opts, ['neg-hit']);
    assert.equal(second.known, true, 'fora de cache confirmado é conhecimento, não dúvida');
    assert.equal(second.cached.size, 0);
    assert.equal(calls.length, 1, 'o negativo conhecido responde do L1');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('TTLs separados: o negativo expira antes do positivo', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes.filter((h) => h === 'ttl-pos')),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-ttl');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    // Positivo e negativo gravados na mesma rodada, com TTLs distintos.
    await check(opts, ['ttl-pos']);
    await check(opts, ['ttl-neg']);
    assert.equal(calls.length, 2);

    // Passa do TTL do negativo (1s) sem chegar no do positivo (2s).
    await sleep(1300);
    await check(opts, ['ttl-neg']);
    assert.equal(calls.length, 3, 'negativo expirado é re-perguntado');
    await check(opts, ['ttl-pos']);
    assert.equal(calls.length, 3, 'positivo ainda responde do L1');

    // Passa também do TTL do positivo.
    await sleep(1300);
    await check(opts, ['ttl-pos']);
    assert.equal(calls.length, 4, 'positivo expirado é re-perguntado');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('resposta incompleta cacheia SÓ o positivo confirmado, nunca o negativo', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => {
    if (infoHashes.includes('part-confirmed')) {
      // 1ª chamada: part-confirmed confirmado em cache; o lote de
      // part-missing se perdeu no prazo (complete:false).
      return { cached: new Set(['part-confirmed']), complete: false };
    }
    // 2ª chamada: só part-missing foi perguntado, e ele não toca.
    return { cached: new Set(), complete: true };
  });
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-partial');
  try {
    const first = await check(opts, ['part-confirmed', 'part-missing']);
    assert.equal(first.known, false, 'lote perdido não é "não tem"');
    assert.deepEqual([...first.cached], ['part-confirmed']);

    const second = await check(opts, ['part-confirmed', 'part-missing']);
    // O confirmado pela API vira positivo de L1; o não-perguntado NÃO pode ter
    // virado "fora de cache" — se tivesse, a segunda chamada não o re-perguntaria.
    assert.deepEqual(calls[1], ['part-missing'], 'só o não-confirmado volta à rede');
    assert.ok(second.cached.has('part-confirmed'), 'o positivo do L1 soma no Set');
    assert.equal(second.known, true);
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('unusable não grava nada: a chamada seguinte re-pergunta', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => {
    // O wrapper empurra a chamada em calls ANTES do handler: na primeira
    // consulta o array já tem 1 entrada quando o handler roda.
    if (calls.length === 1) throw new AuthError('AUTH_BAD_APIKEY');
    return { cached: new Set(infoHashes), complete: true };
  });
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-unusable');
  try {
    const first = await check(opts, ['unusable-hash']);
    assert.equal(first.known, false);
    assert.equal(first.unusable?.reason, 'auth');
    assert.equal(calls.length, 1);

    // Se o "fora de cache" da conta que recusa upload fosse persistido, a
    // segunda chamada responderia do L1 e congelaria o erro da chave.
    const second = await check(opts, ['unusable-hash']);
    assert.equal(second.known, true, 'a conta voltou a responder: nada foi gravado');
    assert.equal(calls.length, 2, 'unusable não entra no L1');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('forceFresh pula a leitura do L1 (contrato do recheck do autofetch)', async () => {
  const { adapter, calls } = makeFake(async () => ({ cached: new Set(), complete: true }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-fresh');
  try {
    await check(opts, ['ff-neg']);
    const hit = await check(opts, ['ff-neg']);
    assert.equal(hit.known, true);
    assert.equal(hit.cached.size, 0);
    assert.equal(calls.length, 1, 'negativo conhecido responde do L1');

    // O recheck do autofetch precisa perguntar de novo mesmo com o negativo em
    // L1: o download pode ter ficado pronto entretanto, e o TTL do negativo
    // (120s) não pode segurar o ⚡ até o próximo ciclo natural.
    const fresh = await runWith<CheckResult>(
      { opts, encoded: '' },
      () => debrid.checkCached(['ff-neg'], forceFresh),
    );
    assert.equal(fresh.known, true);
    assert.equal(calls.length, 2, 'forceFresh re-executa a checagem');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('duas contas não compartilham L1; a mesma conta compartilha', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const contaA = userOpts('conta-a');
  const contaB = userOpts('conta-b');
  try {
    await check(contaA, ['scope-h']);
    await check(contaB, ['scope-h']);
    assert.equal(calls.length, 2, 'contas diferentes pagam checagem própria');

    await check(contaA, ['scope-h']);
    assert.equal(calls.length, 2, 'a mesma conta responde do L1 na volta');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('cobertura total pelo L1 devolve known:true sem rede', async () => {
  // O fake classifica por igualdade explícita: prefixo (startsWith) deixaria
  // 'full-pos' de fora — ele começa com 'full', não com 'pos' — e o caso
  // gravaria o positivo como negativo.
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes.filter((h) => h === 'full-pos')),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-full');
  try {
    await check(opts, ['full-pos']);
    await check(opts, ['full-neg']);
    assert.equal(calls.length, 2);

    const both = await check(opts, ['full-pos', 'full-neg']);
    assert.equal(both.known, true, 'o L1 conhece os dois lados: resposta confiável');
    assert.deepEqual([...both.cached], ['full-pos'], 'só o positivo entra no Set');
    assert.equal(calls.length, 2, 'zero rede na chamada coberta');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('merge: o Set de retorno soma positivos do L1 e da rede parcial', async () => {
  // A rede do segundo passe só recebe ['merge-lost'] (o L1 já conhece o
  // positivo): a classificação por igualdade explícita cobre o caso —
  // 'merge-lost' não começa por 'lost' nem 'merge-pos' por 'pos'.
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => {
    if (infoHashes.includes('merge-lost')) {
      // O lote do lost estourou no prazo, mas o que veio confirmado vale.
      return { cached: new Set(infoHashes), complete: false };
    }
    return { cached: new Set(infoHashes.filter((h) => h === 'merge-pos')), complete: true };
  });
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-merge');
  try {
    await check(opts, ['merge-pos']); // grava o positivo no L1
    const merged = await check(opts, ['merge-pos', 'merge-lost']);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ['merge-lost'], 'só o não-conhecido abre rede');
    assert.equal(merged.known, false, 'resposta incompleta continua incompleta');
    assert.deepEqual(
      [...merged.cached].sort(),
      ['merge-lost', 'merge-pos'],
      'L1 + rede parcial somam no Set, quem marca ⚡ lê o conjunto',
    );
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('métrica cached só conta confirmação após merge final conhecido', async () => {
  const { adapter } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: false,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  metrics.reset();
  try {
    const result = await check(userOpts('chave-fake-cached-parcial'), ['cached-parcial']);
    assert.equal(result.known, false);
    assert.equal(result.cached.size, 1, 'o positivo parcial segue útil para marcar o stream');
    assert.equal(metrics.snapshot().counters['debrid.check.cached'] ?? 0, 0, 'known:false não afirma cache para a taxa ⚡');
  } finally {
    metrics.reset();
    debrid.BY_ID.set('premiumize', original);
  }
});

test('medição: hit de L1 não infla o denominador do gate', async () => {
  const { adapter } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-metrics');
  metrics.reset();
  try {
    await check(opts, ['gate-a', 'gate-b']);
    await check(opts, ['gate-a', 'gate-c']);

    const counters = metrics.snapshot().counters;
    assert.equal(counters['debrid.check.hashes'], 3, 'só o hash novo paga a janela');
    assert.equal(counters['debrid.check.repeated'] ?? 0, 0, 'repetição absorvida pelo L1 não é repetição');
    assert.equal(counters['davail.servedHashes'], 1, 'o hash respondido pelo L1 é contabilizado à parte');
    assert.equal(counters['cache.hit.davail'], 1, 'o positivo do L1 conta como hit do namespace');
  } finally {
    metrics.reset();
    debrid.BY_ID.set('premiumize', original);
  }
});

test('métrica ⚡ separa L1 do resultado da rede numa consulta mista', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = userOpts('chave-fake-metrics-mixed');
  try {
    // Semeia o positivo local fora da janela que será exibida no dashboard.
    await check(opts, ['local-cached']);
    metrics.reset();

    const result = await check(opts, ['local-cached', 'network-cached']);
    const counters = metrics.snapshot().counters;
    assert.deepEqual(calls[1], ['network-cached'], 'só o hash ausente chega à rede');
    assert.deepEqual([...result.cached].sort(), ['local-cached', 'network-cached']);
    assert.equal(counters['davail.servedHashes'], 1, 'o positivo local mantém métrica própria');
    assert.equal(counters['debrid.check.hashes'], 1, 'o denominador conta somente a rede');
    assert.equal(counters['debrid.check.cached'], 1, 'o numerador conta somente a confirmação da rede');
    assert.ok(
      (counters['debrid.check.cached'] ?? 0) <= (counters['debrid.check.hashes'] ?? 0),
      'a taxa ⚡ do dashboard não ultrapassa 100%',
    );
  } finally {
    metrics.reset();
    debrid.BY_ID.set('premiumize', original);
  }
});
