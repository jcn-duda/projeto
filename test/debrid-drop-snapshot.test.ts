import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { mockAccountWith, settle, flushImmediate, type FileEntry } from './helpers/alldebrid-account-mock.js';

let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

// --- Corrida do snapshot (regressão do vazamento) --------------------------
//
// O inventário de referência é um /magnet/status disparado em background junto
// com os uploads da MESMA checagem, e no serviço real ele chega depois deles.
// O snapshot então já contém os magnets que a própria checagem acabou de
// criar — e eles passam a contar como "do usuário", protegidos para sempre.
// É uma catraca: cada restart refaz o snapshot sobre o estado atual da conta,
// que já inclui o vazamento anterior (medido: 1314 magnets num teto de 1000).
//
// Os casos abaixo exercitam a corrida com o mock de estado real. O contrato: o
// que ESTE processo subiu via /magnet/upload é subtraído do snapshot antes de
// ele virar a referência — a proteção vale só para o que é de fato do usuário,
// e o resíduo da primeira busca é limpo pela segunda.

test('snapshot posterior aos uploads não protege o que a checagem criou', async () => {
  // A regressão desta issue: o snapshot atrasado nasce poluído com o upload da
  // primeira checagem; a busca seguinte tem que apagá-lo mesmo assim.
  const KEY = 'chave-snapshot-posterior';
  const NOVO = 'd1'.repeat(20);
  const api = mockAccountWith([], [NOVO], { snapshotAfterUploads: true });

  try {
    // Primeira checagem: sobe o hash e dispara o inventário (que responde
    // depois, com o upload já registrado). O fail-safe segura a limpeza aqui.
    const first = await alldebrid.checkCached(KEY, [NOVO]);
    await settle();
    await flushImmediate();
    assert.equal(first.cached.has(NOVO), true);
    assert.deepEqual(api.deleted, [], 'primeira checagem não tem inventário: nada de pronto sai');

    // Segunda: o snapshot já chegou — e está poluído com o upload da primeira.
    // Contrato: o que a checagem criou NÃO pode passar a ser preexistente.
    const second = await alldebrid.checkCached(KEY, [NOVO]);
    await settle();
    assert.equal(second.cached.has(NOVO), true, 'o hash continua em cache no serviço');
    assert.deepEqual(api.deleted, [2000], 'o resíduo da própria checagem é removido na busca seguinte');
  } finally {
    api.restore();
  }
});

test('magnet pré-existente continua protegido mesmo com o snapshot poluído', async () => {
  // A subtração do que o addon subiu não pode varrer o que é DE FATO do
  // usuário: o magnet que já estava na conta antes de qualquer upload tem que
  // continuar imune, mesmo aparecendo numa busca e mesmo constando do snapshot
  // posterior aos uploads.
  const KEY = 'chave-preexistente';
  const DO_USUARIO = 'e1'.repeat(20);
  const DA_CHECAGEM = 'f1'.repeat(20);
  const api = mockAccountWith([DO_USUARIO], [DO_USUARIO, DA_CHECAGEM], { snapshotAfterUploads: true });

  try {
    await alldebrid.checkCached(KEY, [DO_USUARIO, DA_CHECAGEM]);
    await settle();
    await flushImmediate();
    api.deleted.length = 0;

    const { cached } = await alldebrid.checkCached(KEY, [DO_USUARIO, DA_CHECAGEM]);
    await settle();

    assert.equal(cached.has(DO_USUARIO), true);
    assert.equal(cached.has(DA_CHECAGEM), true);
    // O id 2000 é o que a PRIMEIRA checagem criou (o DO_USUARIO ficou com o
    // 1000, que já era da conta). O pré-existente sobrevive; o criado sai.
    assert.deepEqual(api.deleted, [2000], 'só o que a checagem criou sai; o do usuário fica');
  } finally {
    api.restore();
  }
});

test('hash do autofetch sobrevive à limpeza: held vence mesmo com o download etiquetado', async () => {
  // O held é a ponte do invariante 6: o hash foi enfileirado de propósito para
  // baixar, então nem o dropUncached nem o dropReady podem tocá-lo. A proteção
  // tem que ser independente do inventário.
  //
  // MONTAGEM (proveniência estrita no enqueue): a referência de proveniência
  // precisa existir ANTES do upload do enqueue. O enqueue agora AGUARDA a
  // referência (teto do debridCheckFloor) — com o snapshot atrasado do mock
  // resolvendo DEPOIS do upload, o snapshot (poluído pelo próprio enqueue)
  // não daria prova de criação, o hash não seria etiquetado e o teste perderia
  // o alvo. Resolvendo o inventário ANTES, o snapshot nasce limpo (conta
  // vazia), o enqueue etiqueta com prova, e o que protege o AUTO na checagem é
  // o held — a intenção "sem held, o download do autofetch volta à limpeza"
  // continua sendo exatamente o que o segundo ato prova.
  const KEY = 'chave-held-poluido';
  const ACCOUNT_HELD = accountScope(KEY);
  const AUTO = 'c1'.repeat(20);
  const OUTRO = 'd2'.repeat(20);
  const api = mockAccountWith([], [AUTO, OUTRO], { snapshotAfterUploads: true });

  try {
    // Referência ANTES do upload: o snapshot resolve com a conta vazia.
    await alldebrid.warmInventory(KEY);
    await settle();
    await flushImmediate();

    held.hold(AUTO, 3600, ACCOUNT_HELD);
    // Referência existe e não contém AUTO: o enqueue etiqueta com prova.
    await alldebrid.enqueue(KEY, AUTO);
    await alldebrid.checkCached(KEY, [AUTO, OUTRO]);
    await settle();

    // O OUTRO (criado pela própria checagem) sai; o AUTO fica pelo held.
    assert.deepEqual(api.deleted, [2001], 'o não-protegido criado pela checagem sai');
    assert.equal(held.isHeld(AUTO, ACCOUNT_HELD), true, 'o hash continua protegido');

    held.release(AUTO, ACCOUNT_HELD);
    await alldebrid.checkCached(KEY, [AUTO]);
    await settle();
    assert.deepEqual(api.deleted, [2001, 2000], 'sem held, o autofetch do processo volta à limpeza');
  } finally {
    held.release(AUTO, ACCOUNT_HELD);
    api.restore();
  }
});

test('inventário aquecido no boot deixa a primeira checagem limpar os prontos que criou', async () => {
  // O warm-up no boot é o que fecha o furo do fail-safe: sem ele, a primeira
  // busca do operador gasta a checagem inteira sem apagar nada de pronto (o
  // snapshot ainda não existe). Aquecido, o snapshot já está lá ANTES de
  // qualquer upload — a primeira checagem remove os prontos normalmente.
  const KEY = 'chave-aquecido-boot';
  const NOVO = '9a'.repeat(20);
  const api = mockAccountWith([], [NOVO]);

  // Contrato novo do adaptador: disparar o inventário da conta sem checagem,
  // para o boot chamar ao lado do seal de warmup e do load do catálogo.
  assert.equal(
    typeof alldebrid.warmInventory,
    'function',
    'contrato: alldebrid expõe warmInventory(apiKey) para aquecer o inventário no boot',
  );

  try {
    alldebrid.warmInventory(KEY);
    await settle();
    await flushImmediate();

    await alldebrid.checkCached(KEY, [NOVO]);
    await settle();
    assert.deepEqual(api.deleted, [2000], 'primeira checagem já remove o pronto que criou');
  } finally {
    api.restore();
  }
});

test('delete recusado pela conta não vira "removido": conta falha e não infla a métrica', async () => {
  // O allSettled engole rejeição. Sem ler o resultado, o log e a métrica
  // contavam TENTATIVA como remoção — e a conta crescia enquanto o addon
  // afirmava estar limpando. Com a conta no teto, que é quando a AllDebrid
  // recusa o /magnet/delete, era justamente aí que a medição mentia.
const CHAVE = 'chave-delete-recusado';
  const CRIADO = 'b2'.repeat(20);
  const api = mockAccountWith([], [], { failDelete: true });
  metrics.reset();

  try {
    await alldebrid.checkCached(CHAVE, [CRIADO]);
    // A rajada de 503 faz o id ser tentado 3× na 1ª rodada (400→800→1600ms),
    // reenfileirado e tentado mais 3× na 2ª. Só aí a falha é contabilizada e
    // a conta não mente que limpou. Esperamos o backoff real (≃5,6s).
    await new Promise((resolve) => setTimeout(resolve, 7000));

    // 6 tentativas = 3 da primeira rodada + 3 da segunda (reenfileirado).
    assert.equal(api.deleted.filter((n) => n === 2000).length, 6, 'reeenfileirado na 2ª rodada: 3+3 tentativas');
    const snap = metrics.snapshot();
    assert.equal(snap.counters['debrid.dropped'] || 0, 0, 'nada foi removido de fato');
    assert.equal(snap.counters['debrid.drop_failed'], 1, 'a falha é contabilizada depois das duas rodadas');
  } finally {
    api.restore();
    metrics.reset();
  }
});

test('snapshot com TTL expirado recarrega inventário e protege magnet adicionado pelo usuário pós-boot (Tarefa 1.4)', async () => {
  const KEY = 'chave-snapshot-ttl-expira';
  const PRIMEIRO = '11'.repeat(20);
  const DO_USUARIO_POSTERIOR = '22'.repeat(20);
  const DA_SEGUNDA_BUSCA = '33'.repeat(20);
  const DA_TERCEIRA_BUSCA = '99'.repeat(20);

  const originalTtl = config.debrid.preexistingTtlMs;
  config.debrid.preexistingTtlMs = 40; // 40ms TTL

  const api = mockAccountWith([], [PRIMEIRO, DO_USUARIO_POSTERIOR, DA_SEGUNDA_BUSCA, DA_TERCEIRA_BUSCA]);

  try {
    // 1. Primeira busca cria o snapshot inicial (sem o magnet posterior do usuário)
    await alldebrid.checkCached(KEY, [PRIMEIRO]);
    await settle();
    await flushImmediate();
    api.deleted.length = 0;

    // 2. Usuário adiciona um magnet diretamente na conta dele (fora do addon)
    const idUsuario = api.addExternal(DO_USUARIO_POSTERIOR, true);

    // 3. Espera o TTL do snapshot expirar
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 4. Segunda busca: dispara o refresh EM FUNDO e não espera por ele. Sem
    //    referência fresca, esta passada não apaga nada — nem o que ela criou.
    const { cached } = await alldebrid.checkCached(KEY, [DO_USUARIO_POSTERIOR, DA_SEGUNDA_BUSCA]);
    await settle();

    assert.equal(cached.has(DO_USUARIO_POSTERIOR), true);
    assert.equal(cached.has(DA_SEGUNDA_BUSCA), true);
    // `deepEqual` do assert/strict é assertion function e estreitaria o tipo de
    // `api.deleted` para never[]; aqui o que importa é só a contagem.
    assert.equal(api.deleted.length, 0, 'com o snapshot vencido, a passada do refresh não apaga nada');

    // 5. O refresh terminou: a busca seguinte já trabalha com a foto nova.
    await settle();
    await flushImmediate();
    await alldebrid.checkCached(KEY, [DO_USUARIO_POSTERIOR, DA_TERCEIRA_BUSCA]);
    await settle();

    // O magnet adicionado pelo usuário pós-boot NÃO pode ser deletado nunca.
    assert.ok(!api.deleted.includes(idUsuario), 'magnet adicionado pelo usuário pós-boot não pode ser deletado');
    // O magnet que a busca acabou de criar continua sendo limpo normalmente.
    assert.deepEqual(api.deleted, [2003], 'apenas o magnet novo criado pela busca é removido');
  } finally {
    config.debrid.preexistingTtlMs = originalTtl;
    api.restore();
  }
});

test('refresh do snapshot por TTL não entra no prazo da resposta: /magnet/status lento não atrasa a checagem', async () => {
  const KEY = 'chave-refresh-nao-bloqueia';
  const PRIMEIRO = '66'.repeat(20);
  const SEGUNDO = '77'.repeat(20);

  const originalTtl = config.debrid.preexistingTtlMs;
  config.debrid.preexistingTtlMs = 40;

  const api = mockAccountWith([], [PRIMEIRO, SEGUNDO]);

  try {
    await alldebrid.checkCached(KEY, [PRIMEIRO]);
    await settle();
    await flushImmediate();

    // O inventário passa a demorar MAIS que a resposta inteira pode esperar.
    api.statusDelayMs = 400;
    await new Promise((resolve) => setTimeout(resolve, 60));

    const inicio = Date.now();
    const { cached } = await alldebrid.checkCached(KEY, [SEGUNDO]);
    const gasto = Date.now() - inicio;

    // O bug original: o refresh era aguardado dentro do checkCached, então a
    // busca pagava a latência inteira do /magnet/status (até 6s, o timeout
    // padrão do adaptador) dentro da reserva do debrid, uma vez a cada TTL.
    assert.ok(gasto < 300, `checkCached não pode esperar o inventário lento (gastou ${gasto}ms)`);
    assert.equal(cached.has(SEGUNDO), true, 'a checagem responde normalmente');
  } finally {
    config.debrid.preexistingTtlMs = originalTtl;
    api.restore();
  }
});

test('o PRIMEIRO inventário é esperado, mas com teto: lento demais devolve a checagem sem apagar prontos', async () => {
  const KEY = 'chave-primeiro-inventario-lento';
  const DO_USUARIO = '88'.repeat(20);
  const DA_BUSCA = 'aa'.repeat(20);

  const originalFloor = config.debridCheckFloor;
  config.debridCheckFloor = 80;

  // Conta com um magnet do usuário e o inventário mais lento que o teto.
  const api = mockAccountWith([DO_USUARIO], [DO_USUARIO, DA_BUSCA], { statusDelayMs: 300 });

  try {
    const inicio = Date.now();
    const { cached } = await alldebrid.checkCached(KEY, [DA_BUSCA]);
    const gasto = Date.now() - inicio;
    await settle();

    assert.ok(gasto < 250, `a espera do primeiro inventário tem teto (gastou ${gasto}ms)`);
    assert.equal(cached.has(DA_BUSCA), true);
    // Sem inventário em mãos, nada de destrutivo: fail-safe fecha.
    assert.deepEqual(api.deleted, [], 'sem inventário no prazo, nenhum pronto é apagado');
  } finally {
    config.debridCheckFloor = originalFloor;
    api.restore();
  }
});

test('fail-safe closed: erro HTTP 500 no refresh do inventário não apaga prontos e busca segue normal (Tarefa 1.5)', async () => {
  const KEY = 'chave-failsafe-refresh-erro';
  const NOVO_1 = '44'.repeat(20);
  const NOVO_2 = '55'.repeat(20);

  const originalTtl = config.debrid.preexistingTtlMs;
  config.debrid.preexistingTtlMs = 40;

  // Inicia com mock normal
  const api = mockAccountWith([], [NOVO_1, NOVO_2]);

  try {
    // Primeira passada cria snapshot
    await alldebrid.checkCached(KEY, [NOVO_1]);
    await settle();
    await flushImmediate();
    api.deleted.length = 0;

    // Expira o snapshot
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Ativa falha HTTP 500 no /magnet/status
    api.failStatus = true;

    // Segunda busca: o refresh de inventário vai falhar com 500
    const result = await alldebrid.checkCached(KEY, [NOVO_2]);
    await settle();

    // A busca tem que suceder normalmente
    assert.equal(result.complete, true);
    assert.equal(result.cached.has(NOVO_2), true);

    // Fail-safe closed: com falha no refresh do inventário, nenhum pronto pode ser removido!
    assert.deepEqual(api.deleted, [], 'nenhum magnet pronto é apagado quando o inventário falha');
  } finally {
    config.debrid.preexistingTtlMs = originalTtl;
    api.restore();
  }
});

