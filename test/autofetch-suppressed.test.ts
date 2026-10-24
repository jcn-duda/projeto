// Fila de remoções represadas (autofetch-suppressed): contador, TTL próprio e
// drain com teto/backoff.
//
// Etapas 1 e 2 do plano da fila represada, no módulo puro: sem recheck, sem
// painel. Cobre o contrato novo do registro `{ id, at, fails, nextAt }`, a
// manutenção de elegibilidade por `nextAt`, a preservação do TTL restante na
// reescrita e a desistência em 5 falhas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import type { DebridAdapter } from '../types/domain.js';

const GIVENUP = 'autofetch.suppressed.givenup';

function givenupDelta() {
  return metrics.snapshot().counters[GIVENUP] || 0;
}

/** Adapter mínimo do tipo certo para o drain; cada teste troca o removeTorrent. */
function draftAdapter(): DebridAdapter {
  return {
    id: 'draft',
    label: 'draft (teste)',
    short: 'draft',
    cacheCheck: false,
  } as unknown as DebridAdapter;
}

const H = 'a'.repeat(40);

test('noteSuppressed usa TTL próprio de 30 dias, não o DEAD_TTL', () => {
  const account = 'conta-ttl';
  try {
    suppressed.noteSuppressed('draft', account, H, 'id-1');
    const restante = cache.peekRemaining(suppressed.suppressedKey('draft', account, H)) || 0;
    assert.ok(restante > 2_591_000, `TTL ~30 dias, obtive ${restante}s`);
  } finally {
    suppressed.forgetSuppressed('draft', account, H);
  }
});

test('drain respeita o teto por passagem e o resto sobra para a próxima', async () => {
  const account = 'conta-cap';
  const adapter = draftAdapter();
  const originalMax = config.debrid.suppressedDrainMax;
  const originalRemove = config.debrid.removeById;
  const removidos: string[] = [];
  adapter.removeTorrent = async (_k, id) => {
    removidos.push(String(id));
    return true;
  };
  try {
    config.debrid.suppressedDrainMax = 2;
    config.debrid.removeById = true;
    suppressed.noteSuppressed('draft', account, '1'.repeat(40), 'id-1');
    suppressed.noteSuppressed('draft', account, '2'.repeat(40), 'id-2');
    suppressed.noteSuppressed('draft', account, '3'.repeat(40), 'id-3');

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 2);
    assert.deepEqual(removidos, ['id-1', 'id-2'], 'para no teto');
    assert.equal(suppressed.countSuppressed('draft', account), 1, 'o terceiro fica represado');
    assert.equal(suppressed.listSuppressed('draft', account).length, 1, 'e continua elegível');

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 1, 'próxima passagem drena o resto');
    assert.deepEqual(removidos, ['id-1', 'id-2', 'id-3']);
    assert.equal(suppressed.countSuppressed('draft', account), 0);
  } finally {
    config.debrid.suppressedDrainMax = originalMax;
    config.debrid.removeById = originalRemove;
    for (const h of ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]) {
      suppressed.forgetSuppressed('draft', account, h);
    }
  }
});

test('max no opts drena além do teto configurado (preparo para a ação do painel)', async () => {
  const account = 'conta-override';
  const adapter = draftAdapter();
  const originalMax = config.debrid.suppressedDrainMax;
  const originalRemove = config.debrid.removeById;
  adapter.removeTorrent = async () => true;
  try {
    config.debrid.suppressedDrainMax = 1;
    config.debrid.removeById = true;
    for (const h of ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]) {
      suppressed.noteSuppressed('draft', account, h, `id-${h[0]}`);
    }
    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account, { max: 10 }), 3);
    assert.equal(suppressed.countSuppressed('draft', account), 0);
  } finally {
    config.debrid.suppressedDrainMax = originalMax;
    config.debrid.removeById = originalRemove;
    for (const h of ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]) {
      suppressed.forgetSuppressed('draft', account, h);
    }
  }
});

test('force: true drena com o knob desligado (ação de painel sem ligar o global)', async () => {
  const account = 'conta-force';
  const adapter = draftAdapter();
  const originalRemove = config.debrid.removeById;
  const removidos: string[] = [];
  adapter.removeTorrent = async (_k, id) => {
    removidos.push(String(id));
    return true;
  };
  try {
    config.debrid.removeById = false;
    suppressed.noteSuppressed('draft', account, '1'.repeat(40), 'id-1');
    suppressed.noteSuppressed('draft', account, '2'.repeat(40), 'id-2');

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 0, 'sem force é no-op com o gate fechado');
    assert.deepEqual(removidos, [], 'nada é tocado no serviço');

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account, { force: true }), 2, 'force abre a porta');
    assert.deepEqual(removidos.sort(), ['id-1', 'id-2']);
    assert.equal(suppressed.countSuppressed('draft', account), 0, 'a fila esvazia');
  } finally {
    config.debrid.removeById = originalRemove;
    for (const h of ['1'.repeat(40), '2'.repeat(40)]) {
      suppressed.forgetSuppressed('draft', account, h);
    }
  }
});

test('falha agenda nextAt e o registro não é reentregue antes da hora', async () => {
  const account = 'conta-backoff';
  const adapter = draftAdapter();
  const originalRemove = config.debrid.removeById;
  const originalTtl = config.debrid.suppressedTtl;
  let chamadas = 0;
  adapter.removeTorrent = async () => {
    chamadas += 1;
    return false;
  };
  try {
    config.debrid.removeById = true;
    config.debrid.suppressedTtl = 3600;
    suppressed.noteSuppressed('draft', account, H, 'id-ruim');

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 0);
    assert.equal(chamadas, 1);
    assert.equal(suppressed.countSuppressed('draft', account), 1, 'falha isolada não desiste');

    const rec = cache.peek(suppressed.suppressedKey('draft', account, H)) as { fails: number; nextAt: number };
    assert.equal(rec.fails, 1, 'a falha é contada');
    assert.ok(rec.nextAt > Date.now(), 'a próxima tentativa é agendada no futuro');

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 0, 'passagem imediata');
    assert.equal(chamadas, 1, 'não toca no serviço antes do nextAt');
    assert.equal(suppressed.listSuppressed('draft', account).length, 0, 'fora da lista de elegíveis');
    assert.deepEqual(
      suppressed.listAllSuppressed('draft', account).map((r) => r.fails),
      [1],
      'a leitura completa enxerga o backoff acumulado',
    );
  } finally {
    config.debrid.removeById = originalRemove;
    config.debrid.suppressedTtl = originalTtl;
    suppressed.forgetSuppressed('draft', account, H);
  }
});

test('reescrita por falha preserva a validade restante (não renova 30 dias)', async () => {
  const account = 'conta-validade';
  const adapter = draftAdapter();
  const originalRemove = config.debrid.removeById;
  adapter.removeTorrent = async () => false;
  try {
    config.debrid.removeById = true;
    // Default do config eh 30 dias: reescrever sem preservar renasceria com o
    // TTL cheio (2592000s); com preservacao fica na casa do TTL curto pedido.
    suppressed.noteSuppressed('draft', account, H, 'id-validade', 120);
    const key = suppressed.suppressedKey('draft', account, H);
    const antes = cache.peekRemaining(key) || 0;
    assert.ok(antes > 100);

    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 0);
    const depois = cache.peekRemaining(key) || 0;
    assert.ok(depois < 3600, `nao renasce de 30 dias: depois ${depois}s`);
    assert.ok(depois <= antes, `e preserva a validade restante: antes ${antes}s, depois ${depois}s`);

    // Re-notar tambem preserva: o id ja espera ha algum tempo, nao ganha 30d.
    suppressed.noteSuppressed('draft', account, H, 'id-validade', 120);
    const renotado = cache.peekRemaining(key) || 0;
    assert.ok(renotado < 3600, 're-note nao devolve a validade cheia');
    assert.ok(renotado <= antes, 're-note preserva o que falta');
  } finally {
    config.debrid.removeById = originalRemove;
    suppressed.forgetSuppressed('draft', account, H);
  }
});

test('cinco falhas esquecem o registro e contam givenup', async () => {
  const account = 'conta-givenup';
  const adapter = draftAdapter();
  const originalRemove = config.debrid.removeById;
  adapter.removeTorrent = async () => false;
  const antes = givenupDelta();
  try {
    config.debrid.removeById = true;
    suppressed.noteSuppressed('draft', account, H, 'id-fatal');
    const key = suppressed.suppressedKey('draft', account, H);
    let fails = 0;
    while (suppressed.countSuppressed('draft', account) > 0) {
      // Simula o tempo passando: o recheck roda de novo depois do backoff.
      cache.set(key, { id: 'id-fatal', at: Date.now() - 1000, fails, nextAt: 0 }, 60);
      fails += 1;
      assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 0);
    }
    assert.equal(fails, 5, 'cinco falhas consecutivas até a desistência');
    assert.equal(givenupDelta() - antes, 1, 'uma desistência contada');
  } finally {
    config.debrid.removeById = originalRemove;
    suppressed.forgetSuppressed('draft', account, H);
  }
});

test('registro em formato antigo {id, at} continua drenável', async () => {
  const account = 'conta-legado';
  const adapter = draftAdapter();
  const originalRemove = config.debrid.removeById;
  const removidos: Array<string | number> = [];
  adapter.removeTorrent = async (_k, id) => {
    removidos.push(id);
    return true;
  };
  try {
    config.debrid.removeById = true;
    // Registro gravado ANTES da Etapa 2 (só id/at, sem fails/nextAt).
    cache.set(suppressed.suppressedKey('draft', account, H), { id: 'legado-1', at: Date.now() - 3600_000 }, 3600);

    assert.equal(suppressed.listSuppressed('draft', account).length, 1, 'legado nasce elegível');
    assert.equal(await suppressed.drainSuppressed(adapter, 'chave', account), 1);
    assert.deepEqual(removidos, ['legado-1']);
    assert.equal(suppressed.countSuppressed('draft', account), 0);
  } finally {
    config.debrid.removeById = originalRemove;
    suppressed.forgetSuppressed('draft', account, H);
  }
});

test('countAllSuppressed agrega adapters e contas distintos', () => {
  const pares: Array<[string, string, string]> = [
    ['premiumize', 'conta-a', '1'.repeat(40)],
    ['premiumize', 'conta-b', '2'.repeat(40)],
    ['torbox', 'conta-b', '3'.repeat(40)],
  ];
  try {
    for (const [adapter, conta, hash] of pares) {
      suppressed.noteSuppressed(adapter, conta, hash, `id-${adapter}-${conta}`);
    }
    assert.equal(suppressed.countAllSuppressed(), 3, 'varre o prefixo inteiro');
    assert.equal(suppressed.countSuppressed('premiumize', 'conta-a'), 1);
    assert.equal(suppressed.countSuppressed('premiumize', 'conta-b'), 1);
    assert.equal(suppressed.countSuppressed('torbox', 'conta-b'), 1);
  } finally {
    for (const [adapter, conta, hash] of pares) {
      suppressed.forgetSuppressed(adapter, conta, hash);
    }
  }
});

// Dois atores drenam a mesma fila: A materializou a lista e removeu + esqueceu;
// B falha no removeTorrent porque a transferência já não existe. `scheduleRetry`
// deve abortar (registro sumido = outro ator liquidou), NÃO recriar com TTL
// cheio de 30 dias.
test('falha de drain sobre registro já liquidado não recria o registro', async () => {
  const account = 'conta-corrida';
  const adapter = draftAdapter();
  const originalRemove = config.debrid.removeById;
  adapter.removeTorrent = async (_k, _id) => {
    // Outro ator liquidou o registro enquanto este drain rodava.
    suppressed.forgetSuppressed('draft', account, H);
    return false;
  };
  try {
    config.debrid.removeById = true;
    suppressed.noteSuppressed('draft', account, H, 'id-corrida');
    await suppressed.drainSuppressed(adapter, 'chave', account);
    assert.equal(cache.peek(suppressed.suppressedKey('draft', account, H)), null, 'não ressuscitado');
    assert.equal(suppressed.countSuppressed('draft', account), 0);
  } finally {
    config.debrid.removeById = originalRemove;
    suppressed.forgetSuppressed('draft', account, H);
  }
});