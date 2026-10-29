// Ponte hash -> id da transferência no Premiumize.
//
// A listagem do Premiumize não publica hash: o `src` volta como
// `/api/job/src?id=…` e não existe campo `hash`. Medido na conta do operador:
// de 60 transferências, 58 não casavam por nenhuma via da cascata, então o
// recheck só enxergava as 2 cujo NOME por acaso era o hash cru — e nada do que
// o autofetch submetia voltava a ser observável. O id que o `/transfer/create`
// devolve é a única âncora; estes testes cobrem guardá-lo, usá-lo, e o gate
// que impede a visão nova de virar remoção automática no mesmo deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as premiumize from '../src/debrid/premiumize.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import config from '../src/config.js';
import { kvForget, kvPeek } from '../src/utils/native-kv.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import { pruneKnownBroken } from './helpers/pipeline-oracle/debrid-cache-steps.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import type { DebridAdapter } from '../types/domain.js';
import { brDubCandidate } from './helpers/autofetch-fixtures.js';

/** Dublê de fetch com corpo fixo; o AbortSignal.timeout vira no-op. */
function stubFetch(body: unknown) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

// Shape REAL de uma transferência do Premiumize, como veio da conta medida:
// nove campos, nenhum deles com o hash. O `src` é uma URL de job.
const TRANSFER_SEM_HASH = {
  id: 'vJ15-ynT0V4dyb4SuFw',
  name: 'COMANDOTORRENTS.ORG - Parasita 2020 [1080p-FULL] [DUAL]',
  message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left',
  status: 'running',
  progress: 0,
  folder_id: null,
  file_id: null,
  other_cloud_id: null,
  src: 'https://www.premiumize.me/api/job/src?id=vJ15-ynT0V4dyb4SuFw',
};

const HASH = 'a'.repeat(40);

test('enqueue devolve o ID da transferência, não um booleano', async () => {
  const restore = stubFetch({ status: 'success', id: 'vJ15-ynT0V4dyb4SuFw' });
  try {
    const out = await premiumize.enqueue('chave-de-teste', HASH);
    assert.equal(out, 'vJ15-ynT0V4dyb4SuFw', 'o id vira o valor de aceite');
  } finally {
    restore();
  }
});

test('enqueue sem id continua sendo recusa', async () => {
  const restore = stubFetch({ status: 'success' });
  try {
    assert.equal(await premiumize.enqueue('chave-de-teste', HASH), false);
  } finally {
    restore();
  }
});

test('torrentStatus casa pelo id registrado e marca via=id', async () => {
  const restore = stubFetch({ transfers: [TRANSFER_SEM_HASH] });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [HASH], {
      [HASH]: 'vJ15-ynT0V4dyb4SuFw',
    });
    assert.ok(out[HASH], 'a transferência sem hash volta indexada pelo hash do enqueue');
    assert.equal(out[HASH].state, 'downloading');
    assert.equal(out[HASH].stalled, true, 'a mensagem de 0 peers ainda denuncia parada');
    assert.equal(out[HASH].via, 'id', 'a via fica registrada para o gate decidir');
  } finally {
    restore();
  }
});

test('sem o mapa de ids a mesma transferência segue invisível', async () => {
  const restore = stubFetch({ transfers: [TRANSFER_SEM_HASH] });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [HASH]);
    assert.deepEqual(Object.keys(out), [], 'era exatamente este o buraco medido em produção');
  } finally {
    restore();
  }
});

// Precedência. O id é prova de primeira mão (fomos nós que submetemos aquele
// hash); o `name` é heurística declarada. Só o `src` — o magnet real — vale
// mais que o id. Errar a ordem aqui não é cosmético: o hash resultante
// alimenta blacklist e removeTorrent.
const OUTRO = 'b'.repeat(40);
const REAL = 'c'.repeat(40);

test('src vence o id: o magnet real é a autoridade máxima', async () => {
  const restore = stubFetch({
    transfers: [{ id: 7, name: '', status: 'finished', src: `magnet:?xt=urn:btih:${REAL}` }],
  });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [REAL], { [OUTRO]: 7 });
    assert.ok(out[REAL], 'indexada pelo hash do magnet, não pelo do mapa');
    assert.equal(out[REAL].via, 'hash');
    assert.equal(out[OUTRO], undefined);
  } finally {
    restore();
  }
});

test('id vence o nome: 40 hex no nome não desbanca o hash que nós registramos', async () => {
  // O nome carrega um 40 hex que NÃO é o hash desta transferência. Com a
  // precedência antiga o recheck a indexaria sob OUTRO e uma remoção acertaria
  // o hash errado.
  const restore = stubFetch({
    transfers: [{ id: 7, name: OUTRO, status: 'running', src: '', message: '' }],
  });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [REAL], { [REAL]: 7 });
    assert.ok(out[REAL], 'vale o hash que o enqueue registrou');
    assert.equal(out[REAL].via, 'id');
    assert.equal(out[OUTRO], undefined, 'o 40 hex do nome não entra');
  } finally {
    restore();
  }
});

test('sem id registrado, o nome continua valendo (as 2 que já funcionavam)', async () => {
  const restore = stubFetch({
    transfers: [{ id: 7, name: OUTRO, status: 'finished', src: '', message: '' }],
  });
  try {
    const out = await premiumize.torrentStatus('chave-de-teste', [OUTRO]);
    assert.equal(out[OUTRO].state, 'ready');
    assert.equal(out[OUTRO].via, 'hash', 'a heurística segue como último recurso');
  } finally {
    restore();
  }
});

test('markerValue guarda o id e markerTransferId o devolve', () => {
  const account = accountScope('chave-marker');
  const key = autofetch.markerKey('premiumize', account, HASH);
  try {
    autofetch.setMarker('premiumize', account, HASH, autofetch.markerValue('id-abc'), 60);
    assert.equal(autofetch.markerTransferId('premiumize', account, HASH), 'id-abc');
    // Aceite sem id (os outros adapters) segue gravando o `1` histórico, e os
    // leitores por truthiness não notam diferença.
    autofetch.setMarker('premiumize', account, HASH, autofetch.markerValue(true), 60);
    assert.equal(kvPeek(key), 1);
    assert.equal(autofetch.markerTransferId('premiumize', account, HASH), null);
  } finally {
    kvForget(key);
  }
});

/**
 * Gate da remoção. O COLAPSO em si (parado → blacklist → apagar/represar) saiu
 * do Node na leva B4: hoje é do worker nativo
 * (`adom-server::autofetch::recheck` → `recheck_expire`), e a matriz via×knob
 * está em `adom-autofetch::v3::recheck_tests.rs`. O que continua sendo do Node
 * — e o que estes testes medem — é o EFEITO observável: a blacklist que tira o
 * hash do lote antes da checagem e a fila de represados que o knob governa
 * (`drainSuppressed` é o único leitor de `removeById` que sobrou no TS).
 *
 * porque: a montagem abaixo reproduz o ESTADO que o colapso nativo deixa
 * (blacklist + represado), não o colapso — rodar o pipeline aqui mediria um
 * contador que, depois do corte, não tem mais escritor. Pela mesma razão o
 * `hold` não é mais observado: quem chama `protected.release` no colapso é o
 * worker nativo, no mesmo passo.
 */
let rodada = 0;
async function colapsaParado({ removeById, via, keepSuppressed = false }: {
  removeById: boolean;
  via: 'hash' | 'id';
  keepSuppressed?: boolean;
}) {
  // Montagem NOVA a cada chamada: o hash blacklistado não é limpo no finally.
  // Reaproveitar hash/conta faria a chamada seguinte já entrar filtrada como
  // morta — e o teste mediria silêncio em vez do gate.
  rodada += 1;
  const originalRemoveById = config.debrid.removeById;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const chave = `chave-gate-${rodada}`;
  const account = accountScope(chave);
  const h = String(rodada).padStart(40, '0');
  let removals = 0;
  let removedId = '';

  try {
    config.debrid.removeById = removeById;
    pmAdapter.removeTorrent = async (_chave: string, id: string | number) => {
      removals += 1;
      removedId = String(id);
      return true;
    };
    // O colapso blacklista SEMPRE, qualquer que seja a via: é o que impede o
    // hash de voltar ao lote. A represa só existe para `via === 'id'`.
    autofetch.blacklist('premiumize', account, h);
    if (via === 'id') suppressed.noteSuppressed('premiumize', account, h, 99);

    // Porta AUTOMÁTICA do drain (sem `force`): é ela que respeita o knob.
    const removed = via === 'id' ? await suppressed.drainSuppressed(pmAdapter, chave, account) : 0;

    // Prova de integração do efeito: o hash blacklistado sai do lote ANTES da
    // checagem, pelo MESMO filtro que o oráculo do pipeline chama.
    const deadBefore = metrics.snapshot().counters['magnetdb.dropped.dead'] || 0;
    const pruned = pruneKnownBroken([brDubCandidate(h)], 'premiumize', { apiKey: chave, trustScope: account });
    return {
      removals,
      removed,
      removedId,
      kept: pruned.streams.length,
      droppedDead: (metrics.snapshot().counters['magnetdb.dropped.dead'] || 0) - deadBefore,
      blacklisted: autofetch.isDead('premiumize', account, h),
      represados: suppressed.listSuppressed('premiumize', account),
      account,
      hash: h,
    };
  } finally {
    config.debrid.removeById = originalRemoveById;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    kvForget(autofetch.deadKey('premiumize', account, h));
    kvForget(autofetch.markerKey('premiumize', account, h));
    // O teste 12 cobra a virada do knob DEPOIS, então precisa do registro vivo.
    if (!keepSuppressed) suppressed.forgetSuppressed('premiumize', account, h);
  }
}

test('via=id com removeById desligado: blacklista e drena, mas NÃO apaga na conta', async () => {
  const r = await colapsaParado({ removeById: false, via: 'id' });
  assert.equal(r.removals, 0, 'nada é removido da conta do usuário');
  assert.equal(r.removed, 0, 'a porta automática do drain não fura o knob');
  assert.equal(r.represados.length, 1, 'o que teria sido apagado fica na fila');
  assert.equal(r.blacklisted, true, 'a fila para de reenfileirar o mesmo hash');
  assert.equal(r.droppedDead, 1, 'o hash sai do lote como dead antes da checagem');
  assert.equal(r.kept, 0, 'e não volta ao play como stream vivo');
});

test('via=id com removeById ligado: o knob devolve a remoção', async () => {
  const r = await colapsaParado({ removeById: true, via: 'id' });
  assert.equal(r.removals, 1, 'ligado, remove');
  assert.equal(r.removed, 1);
  assert.equal(r.removedId, '99', 'pelo id registrado, nunca pelo hash');
  assert.equal(r.represados.length, 0, 'não sobrou nada represado');
});

test('via=hash não é afetada pelo knob: a remoção histórica segue igual', async () => {
  const r = await colapsaParado({ removeById: false, via: 'hash' });
  // porque: o gate só barra `via === 'id'` (recheck.rs:99). Achado por hash tem
  // posse no próprio serviço, então nunca entra nesta fila — com o knob ligado
  // ou desligado, não há o que drenar.
  assert.equal(r.represados.length, 0, 'via=hash não entra na fila do gate');
  assert.equal(r.removed, 0, 'sem registro, o knob não tem o que barrar nem soltar');
  assert.equal(r.blacklisted, true, 'a blacklist vale para as duas vias');
});

test('suprimir REGISTRA a transferência, para a virada do knob ser retroativa', async () => {
  const r = await colapsaParado({ removeById: false, via: 'id', keepSuppressed: true });
  assert.equal(r.represados.length, 1, 'o que nao foi apagado fica registrado');
  assert.equal(r.represados[0].hash, r.hash);
  assert.equal(r.represados[0].id, '99', 'guarda o id da transferencia, que e o que apaga depois');
  // O ponto do item 3: sem o registro, ligar o knob depois não alcançava nada
  // do que se acumulou enquanto ele estava desligado.
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const originalRemoveById = config.debrid.removeById;
  const removidos: Array<string | number> = [];
  try {
    pmAdapter.removeTorrent = async (_chave: string, id: string | number) => {
      removidos.push(id);
      return true;
    };
    config.debrid.removeById = true;
    assert.equal(await suppressed.drainSuppressed(pmAdapter, r.account, r.account), 1);
    assert.deepEqual(removidos, ['99'], 'a virada do knob cobra o id guardado');
  } finally {
    config.debrid.removeById = originalRemoveById;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    suppressed.forgetSuppressed('premiumize', r.account, r.hash);
  }
});

test('remover de verdade NÃO deixa registro represado', async () => {
  const r = await colapsaParado({ removeById: true, via: 'id' });
  assert.equal(r.represados.length, 0, 'ja foi apagado; nao ha atraso a cobrar');
});

// O ponto do item 3: sem isto, ligar o knob depois nao alcancava nada do que
// se acumulou enquanto ele estava desligado — o hash saia do lote e nunca mais
// era revisitado.
test('drainSuppressed aplica o atraso quando o knob liga', async () => {
  const account = accountScope('chave-drain');
  const h = '7'.repeat(40);
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const originalRemoveById = config.debrid.removeById;
  const removidos: Array<string | number> = [];
  try {
    pmAdapter.removeTorrent = async (_k: string, id: string | number) => {
      removidos.push(id);
      return true;
    };
    suppressed.noteSuppressed('premiumize', account, h, 'transfer-42');
    assert.equal(suppressed.countSuppressed('premiumize', account), 1);

    config.debrid.removeById = false;
    assert.equal(await suppressed.drainSuppressed(pmAdapter, 'chave', account), 0, 'desligado nao apaga');
    assert.equal(removidos.length, 0);
    assert.equal(suppressed.countSuppressed('premiumize', account), 1, 'e o registro sobrevive');

    config.debrid.removeById = true;
    assert.equal(await suppressed.drainSuppressed(pmAdapter, 'chave', account), 1);
    assert.deepEqual(removidos, ['transfer-42'], 'apaga pelo id guardado');
    assert.equal(suppressed.countSuppressed('premiumize', account), 0, 'e o registro sai da fila');
  } finally {
    config.debrid.removeById = originalRemoveById;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    suppressed.forgetSuppressed('premiumize', account, h);
  }
});

test('falha ao remover mantém o represado para a próxima passagem', async () => {
  const account = accountScope('chave-drain-falha');
  const h = '8'.repeat(40);
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const originalRemoveById = config.debrid.removeById;
  try {
    pmAdapter.removeTorrent = async () => false;
    config.debrid.removeById = true;
    suppressed.noteSuppressed('premiumize', account, h, 'transfer-ruim');
    assert.equal(await suppressed.drainSuppressed(pmAdapter, 'chave', account), 0);
    assert.equal(
      suppressed.countSuppressed('premiumize', account),
      1,
      'falha isolada nao desiste: quem aposenta id ruim e o backoff (5 falhas), nao o TTL',
    );
    // A falha agora agenda a proxima tentativa no proprio registro (backoff
    // 5min..6h) e preserva o TTL restante — o TTL proprio de 30 dias cobre a
    // janela de observacao do operador, nao a aposentadoria do id.
    const rec = kvPeek(suppressed.suppressedKey('premiumize', account, h)) as {
      fails?: number;
      nextAt?: number;
    };
    assert.equal(rec.fails, 1, 'a falha é contada para o backoff');
    assert.ok((rec.nextAt || 0) > Date.now(), 'a proxima tentativa é agendada');
  } finally {
    config.debrid.removeById = originalRemoveById;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    suppressed.forgetSuppressed('premiumize', account, h);
  }
});
