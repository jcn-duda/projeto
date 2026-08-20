// Rodada 2: checagem ligada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';

/**
 * A limpeza automática da AllDebrid — o único código do addon que APAGA coisa
 * na conta do usuário. O contrato dela colide de propósito com o download
 * automático da fonte BR: o dropUncached remove tudo que não está em cache, e o
 * autofetch coloca de propósito um torrent que ainda não está pronto.
 *
 * As travas de autofetch e a semântica de src/debrid/protected.js estão em
 * test/autofetch.test.js. Aqui é o adaptador: quem de fato chama /magnet/delete.
 */

const KEY = 'chave-de-teste';
const ACCOUNT = accountScope(KEY);
const READY = 'a'.repeat(40);
const COLD = 'b'.repeat(40);
const HELD = 'c'.repeat(40);

/** id do magnet na conta, por hash — é o que o /magnet/delete recebe. */
const IDS = { [READY]: 111, [COLD]: 222, [HELD]: 333 };

/**
 * Dublê da API v4.1. Só precisa de /magnet/upload (que é a própria checagem de
 * cache da AllDebrid), /magnet/status e /magnet/delete.
 */
/** Arquivo do /magnet/status no formato da API (o que o pickFile lê). */
interface FileEntry {
  n: string;
  e: { n: string; s: number; l: string }[];
}

function mockAllDebrid({ ready = [], statusOf = () => 'Ready', files = [] }: { ready?: string[]; statusOf?: (id: number) => string; files?: FileEntry[] } = {}) {
  const deleted: number[] = [];
  const uploaded: string[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  // O AbortSignal.timeout real deixaria um timer pendurado por teste.
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });

    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      uploaded.push(...hashes);
      return body({
        magnets: hashes.map((hash) => ({
          hash,
          ready: ready.includes(hash),
          id: IDS[hash] ?? 999,
        })),
      });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deleted.push(Number(url.searchParams.get('id')));
      return body({ message: 'deleted' });
    }
    if (url.pathname.endsWith('/magnet/status')) {
      const id = Number(url.searchParams.get('id'));
      return body({ magnets: { id, status: statusOf(id), files } });
    }
    if (url.pathname.endsWith('/link/unlock')) {
      return body({ link: 'https://cdn.alldebrid.test/arquivo.mkv' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    deleted,
    uploaded,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

/** A limpeza é disparada sem await (efeito colateral, não resposta). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Deixa o snapshot atrasado do inventário resolver antes da checagem seguinte. */
const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

// A espera entre polls do resolveLink usa timer unref() — ela não segura o
// event loop. Com o fetch dublado (que resolve em microtask) não sobra nenhum
// handle vivo, o loop esvazia no meio do poll e o runner aborta os testes
// pendentes. Este handle existe só para manter o loop de pé enquanto o arquivo
// roda; não muda o comportamento do adaptador.
let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

test('checkCached remove da conta o que não está em cache e preserva o que está', async () => {
  const api = mockAllDebrid({ ready: [READY] });
  try {
    const result = await alldebrid.checkCached(KEY, [READY, COLD]);

    assert.deepEqual([...result.cached], [READY]);
    await settle();
    // Sem isto, cada busca deixa um download rodando na conta — chegaram a 226
    // fantasmas acumulados antes da limpeza existir.
    assert.deepEqual(api.deleted, [IDS[COLD]], 'só o não cacheado é removido');
  } finally {
    api.restore();
  }
});

test('hash protegido pelo autofetch sobrevive à limpeza; solto, volta a ser removido', async () => {
  const api = mockAllDebrid({ ready: [] });
  try {
    held.hold(HELD, 3600, ACCOUNT);
    await alldebrid.checkCached(KEY, [COLD, HELD]);
    await settle();

    // O protegido está "não pronto" justamente porque pedimos que baixasse:
    // apagá-lo joga fora o download no meio.
    assert.deepEqual(api.deleted, [IDS[COLD]], 'o protegido não entra na limpeza');

    held.release(HELD, ACCOUNT);
    await alldebrid.checkCached(KEY, [HELD]);
    await settle();
    assert.deepEqual(api.deleted, [IDS[COLD], IDS[HELD]], 'liberado, volta à limpeza normal');
  } finally {
    held.release(HELD, ACCOUNT);
    api.restore();
  }
});

test('a proteção é por conta: o mesmo hash em outra conta continua sendo limpo', async () => {
  const api = mockAllDebrid({ ready: [] });
  const OUTRA = 'chave-de-outra-conta';
  try {
    held.hold(HELD, 3600, ACCOUNT);
    await alldebrid.checkCached(OUTRA, [HELD]);
    await settle();

    assert.deepEqual(api.deleted, [IDS[HELD]], 'a proteção de uma conta não vale para a outra');
  } finally {
    held.release(HELD, ACCOUNT);
    api.restore();
  }
});

test('DEBRID_DROP_UNCACHED=false não apaga nada, e ainda assim informa o cache', async () => {
  const api = mockAllDebrid({ ready: [READY] });
  const original = config.debrid.dropUncached;
  try {
    config.debrid.dropUncached = false;
    const result = await alldebrid.checkCached(KEY, [READY, COLD]);
    await settle();

    assert.deepEqual([...result.cached], [READY]);
    assert.deepEqual(api.deleted, [], 'desligado é desligado: a conta não é tocada');
  } finally {
    config.debrid.dropUncached = original;
    api.restore();
  }
});

test('resolveLink apaga o magnet quando o torrent não fica pronto', async () => {
  // Nenhum poll devolve Ready: é o play que falha e deixaria o fantasma.
  const api = mockAllDebrid({ statusOf: () => 'Downloading' });
  try {
    const link = await alldebrid.resolveLink(KEY, COLD, {});

    assert.equal(link, null, 'sem link: melhor devolver nada e deixar escolher outro');
    assert.deepEqual(api.deleted, [IDS[COLD]]);
  } finally {
    api.restore();
  }
});

test('resolveLink NÃO apaga um hash protegido que ainda está baixando', async () => {
  const api = mockAllDebrid({ statusOf: () => 'Downloading' });
  try {
    held.hold(HELD, 3600, ACCOUNT);
    const link = await alldebrid.resolveLink(KEY, HELD, {});

    // O usuário clicou num BR que está baixando por nossa conta: apagar aqui
    // jogaria fora o progresso e a próxima busca recomeçaria do zero.
    assert.equal(link, null);
    assert.deepEqual(api.deleted, [], 'o download em andamento é preservado');
  } finally {
    held.release(HELD, ACCOUNT);
    api.restore();
  }
});

test('resolveLink em cache devolve o link e não toca na conta', async () => {
  const api = mockAllDebrid({
    statusOf: () => 'Ready',
    files: [
      { n: 'Filme.2024.1080p', e: [{ n: 'sample.mkv', s: 1024, l: 'https://ad.test/sample' }, { n: 'filme.mkv', s: 9_000_000, l: 'https://ad.test/filme' }] },
    ],
  });
  try {
    const link = await alldebrid.resolveLink(KEY, READY, {});

    assert.equal(link, 'https://cdn.alldebrid.test/arquivo.mkv');
    assert.deepEqual(api.deleted, [], 'torrent pronto nunca é removido');
  } finally {
    api.restore();
  }
});

test('erro da API vira exceção em vez de "nada em cache"', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    async json() {
      return { status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'chave inválida' } };
    },
  })) as unknown as typeof globalThis.fetch;

  try {
    // batched só deixa passar quando ALGUM lote responde; com todos falhando o
    // erro tem que subir, senão chave inválida viraria "seu debrid não tem nada"
    // e o cachedOnly apagaria a lista inteira em silêncio.
    //
    // AUTH_BAD_APIKEY sobe marcado como credencial recusada (antes vinha o
    // genérico "nenhum lote"): é o que deixa o orquestrador devolver a lista
    // como P2P em vez de prometer um debrid que não autentica.
    await assert.rejects(
      () => alldebrid.checkCached(KEY, [READY, COLD]),
      (err: any) => err.isAuthError === true && /chave inválida/.test(err.message),
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- Limpeza dos PRONTOS ---------------------------------------------------
//
// A checagem de cache é um upload, e por muito tempo ela só removia o que não
// estava pronto. Os prontos ficavam: cada busca sobe dezenas de hashes, e a
// conta chegou a 2300 magnets em quatro dias de uso — até bater o teto da
// AllDebrid, derrubar a checagem inteira e fazer o ⚡ sumir de TODOS os streams.
//
// Apagar é seguro (o cache é do serviço, não da conta; o play reenvia o hash),
// menos em dois casos: o download do autofetch (`held`) e o que o usuário já
// tinha na conta — daí o inventário de referência.

/**
 * Dublê com ESTADO REAL de conta: o /magnet/status lista o que existe naquele
 * instante — incluindo o que o /magnet/upload acabou de criar e excluindo o
 * que o /magnet/delete removeu. O upload é idempotente como na API de verdade:
 * reenviar um hash que já está na conta devolve o MESMO id, sem duplicar.
 *
 * Essa fidelidade existe por causa da corrida do inventário: no serviço real o
 * /magnet/status do snapshot é disparado junto com os uploads da MESMA
 * checagem e costuma chegar depois deles — o snapshot nasce já poluído com o
 * que a checagem criou. Um dublê de lista fixa nunca reproduz isso, e era
 * exatamente o caso que deixava o resíduo da primeira busca "protegido para
 * sempre" como se fosse do usuário.
 *
 * `snapshotAfterUploads: true` atrasa a resposta do inventário em um
 * macrotask: como o upload roda no mesmo tick, depois do disparo do snapshot,
 * ele registra primeiro — e o snapshot reflete o estado poluído.
 */
function mockAccountWith(preexisting: any, readyHashes: any, { snapshotAfterUploads = false, failDelete = false } = {}) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  // Estado da conta: id → magnet. Os preexistentes entram prontos (1000+i);
  // os uploads ganham ids a partir de 2000.
  const byId = new Map();
  const byHash = new Map();
  let nextId = 2000;
  preexisting.forEach((hash: any, i: any) => {
    const magnet = { hash, id: 1000 + i, status: 'Ready', ready: true };
    byId.set(magnet.id, magnet);
    byHash.set(hash, magnet);
  });

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });

    if (url.pathname.endsWith('/magnet/status')) {
      const id = url.searchParams.get('id');
      if (id != null) {
        const magnet = byId.get(Number(id));
        return body({ magnets: magnet ? [magnet] : [] });
      }
      // Sem id é o inventário/ocupação: a lista do que existe NESTE instante.
      if (snapshotAfterUploads) {
        // A resposta só é montada no macrotask seguinte: o upload desta
        // checagem (disparado depois do status) registra antes, e o snapshot
        // já inclui os magnets que a checagem criou.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return body({ magnets: [...byId.values()] });
    }
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      return body({
        magnets: hashes.map((hash) => {
          let magnet = byHash.get(hash);
          if (!magnet) {
            magnet = { hash, id: nextId++, status: 'Ready', ready: true };
            byId.set(magnet.id, magnet);
            byHash.set(hash, magnet);
          }
          return { ...magnet, ready: readyHashes.includes(hash) };
        }),
      });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      // A AllDebrid responde 200 com {status:"error"} quando recusa; é assim que
      // uma conta no teto rejeita a limpeza sem devolver HTTP de erro.
      if (failDelete) {
        return {
          ok: true,
          async json() { return { status: 'error', error: { code: 'MAGNET_INVALID_ID', message: 'conta recusou' } }; },
        };
      }
      const magnet = byId.get(id);
      if (magnet) {
        byId.delete(id);
        byHash.delete(magnet.hash);
      }
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    deleted,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

test('a primeira checagem não apaga pronto: preserva o fail-safe inicial', async () => {
  // Mesmo com inventário carregado antes do upload, a primeira checagem não
  // apaga prontos: o segundo passe é que limpa o resíduo da própria busca.
  const NOVO = 'd'.repeat(40);
  const api = mockAccountWith([], [NOVO]);
  try {
    await alldebrid.checkCached('chave-primeira-checagem', [NOVO]);
    await settle();
    assert.deepEqual(api.deleted, [], 'nada de pronto sai antes do inventário existir');
  } finally {
    api.restore();
  }
});

test('com o inventário pronto, o magnet da checagem sai e o do usuário fica', async () => {
  const KEY = 'chave-inventario-ok';
  const DO_USUARIO = 'e'.repeat(40);
  const DA_CHECAGEM = 'f'.repeat(40);
  const api = mockAccountWith([DO_USUARIO], [DO_USUARIO, DA_CHECAGEM]);

  try {
    // Primeira passada: dispara o inventário (e não apaga nada de pronto).
    await alldebrid.checkCached(KEY, [DO_USUARIO, DA_CHECAGEM]);
    await settle();
    api.deleted.length = 0;

    // Segunda: o inventário já respondeu.
    const { cached } = await alldebrid.checkCached(KEY, [DO_USUARIO, DA_CHECAGEM]);
    await settle();

    assert.equal(cached.has(DO_USUARIO), true, 'ambos continuam sendo reportados como em cache');
    assert.equal(cached.has(DA_CHECAGEM), true);
    // O id 2000 é o do DA_CHECAGEM, criado pela própria checagem no primeiro
    // upload; o DO_USUARIO ficou com o 1000, que o inventário protege.
    assert.deepEqual(api.deleted, [2000], 'só o que a checagem criou é removido');
  } finally {
    api.restore();
  }
});

test('o download do autofetch sobrevive à limpeza mesmo depois de ficar pronto', async () => {
  // O held existe justamente para isso: o torrent foi enfileirado de propósito
  // e apagá-lo jogaria fora o download que o usuário está esperando.
  const KEY = 'chave-autofetch';
  const ACCOUNT_AUTO = accountScope(KEY);
  const AUTO = 'a1'.repeat(20);
  const api = mockAccountWith([], [AUTO]);

  try {
    await alldebrid.checkCached(KEY, [AUTO]);
    await settle();
    api.deleted.length = 0;

    held.hold(AUTO, 3600, ACCOUNT_AUTO);
    await alldebrid.checkCached(KEY, [AUTO]);
    await settle();
    assert.deepEqual(api.deleted, [], 'hash protegido não é removido nem estando pronto');
  } finally {
    held.release(AUTO, ACCOUNT_AUTO);
    api.restore();
  }
});

test('DEBRID_DROP_READY=false devolve o comportamento antigo', async () => {
  const KEY = 'chave-drop-ready-off';
  const PRONTO = 'b1'.repeat(20);
  const api = mockAccountWith([], [PRONTO]);
  const original = config.debrid.dropReady;

  try {
    config.debrid.dropReady = false;
    await alldebrid.checkCached(KEY, [PRONTO]);
    await settle();
    await alldebrid.checkCached(KEY, [PRONTO]);
    await settle();
    assert.deepEqual(api.deleted, [], 'com a flag desligada, pronto nunca sai');
  } finally {
    config.debrid.dropReady = original;
    api.restore();
  }
});

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

test('hash do autofetch sobrevive à limpeza mesmo constando do snapshot poluído', async () => {
  // O held é a ponte do invariante 6: o hash foi enfileirado de propósito para
  // baixar, então nem o dropUncached nem o dropReady podem tocá-lo — mesmo
  // quando o snapshot atrasado o classifica (erradamente) como preexistente.
  // A proteção tem que ser independente do inventário.
  const KEY = 'chave-held-poluido';
  const ACCOUNT_HELD = accountScope(KEY);
  const AUTO = 'c1'.repeat(20);
  const OUTRO = 'd2'.repeat(20);
  const api = mockAccountWith([], [AUTO, OUTRO], { snapshotAfterUploads: true });

  try {
    // O autofetch sobe AUTO durante o inventário em voo. Quando o status chega,
    // ele vê AUTO na conta, mas o rastro deste processo precisa subtraí-lo.
    const inventory = alldebrid.warmInventory(KEY);
    await alldebrid.enqueue(KEY, AUTO);
    await inventory;

    held.hold(AUTO, 3600, ACCOUNT_HELD);
    await alldebrid.checkCached(KEY, [AUTO, OUTRO]);
    await settle();

    // O OUTRO (criado pela própria checagem) sai; o AUTO fica — e não porque o
    // snapshot o protege (ele está no snapshot poluído), e sim pelo held.
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
    // Mais que o backoff de 400ms do dropMagnets: sem esperar a retentativa, o
    // teste mediria só a primeira tentativa e não veria a repetição.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Duas entradas do mesmo id: a rajada leva 503 e dropMagnets tenta de novo
    // antes de desistir. Só depois da segunda recusa é que conta como falha.
    assert.deepEqual(api.deleted, [2000, 2000], 'tenta, falha e repete uma vez');
    const snap = metrics.snapshot();
    assert.equal(snap.counters['debrid.dropped'] || 0, 0, 'nada foi removido de fato');
    assert.equal(snap.counters['debrid.drop_failed'], 1, 'a falha é contabilizada');
  } finally {
    api.restore();
    metrics.reset();
  }
});

// --- Varredura dos mortos -------------------------------------------------
//
// A limpeza do checkCached só toca hashes que estão NA busca do momento. Um
// torrent que morreu e nunca mais é pesquisado ficava ocupando vaga para
// sempre — e vaga esgotada é o que faz a conta recusar até o delete.

/** Dublê de conta com estados arbitrários, para exercitar a varredura. */
function mockAccountStates(magnets: any) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const byId = new Map(magnets.map((m: any) => [m.id, m]));

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) return body({ magnets: [...byId.values()] });
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      byId.delete(id);
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  return { deleted, restore() { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}

const antigo = Math.floor(Date.now() / 1000) - 3 * 3600;

test('varredura remove só o que está em estado terminal', async () => {
  const api = mockAccountStates([
    { id: 1, hash: '1a'.repeat(20), status: 'Ready', uploadDate: antigo },
    { id: 2, hash: '2a'.repeat(20), status: 'Downloading', uploadDate: antigo },
    { id: 3, hash: '3a'.repeat(20), status: 'No peer after 30 minutes', uploadDate: antigo },
    { id: 4, hash: '4a'.repeat(20), status: 'Expired - Files removed', uploadDate: antigo },
    { id: 5, hash: '5a'.repeat(20), status: 'File not available - no peer', uploadDate: antigo },
  ]);
  try {
    const r = await alldebrid.sweepDead('chave-varredura');
    assert.deepEqual(api.deleted.sort(), [3, 4, 5], 'Ready e Downloading ficam');
    assert.equal(r.varridos, 3);
  } finally {
    api.restore();
  }
});

test('varredura não mata download do autofetch marcado cedo demais', async () => {
  const CHAVE = 'chave-varredura-held';
  const PROTEGIDO = '6a'.repeat(20);
  held.hold(PROTEGIDO, 60, accountScope(CHAVE));
  const api = mockAccountStates([
    { id: 7, hash: PROTEGIDO, status: 'No peer after 30 minutes', uploadDate: antigo },
    { id: 8, hash: '8a'.repeat(20), status: 'No peer after 30 minutes', uploadDate: antigo },
  ]);
  try {
    await alldebrid.sweepDead(CHAVE);
    assert.deepEqual(api.deleted, [8], 'o held sobrevive à varredura');
  } finally {
    held.release(PROTEGIDO, accountScope(CHAVE));
    api.restore();
  }
});

test('varredura respeita a margem de idade: morto recém-marcado fica', async () => {
  // A conta pode marcar "no peer" e ainda reavaliar; varrer na hora
  // apagaria um torrent que talvez ainda ande.
  const agora = Math.floor(Date.now() / 1000);
  const api = mockAccountStates([
    { id: 9, hash: '9a'.repeat(20), status: 'No peer after 30 minutes', uploadDate: agora },
    { id: 10, hash: 'aa'.repeat(20), status: 'No peer after 30 minutes', uploadDate: antigo },
  ]);
  try {
    await alldebrid.sweepDead('chave-varredura-idade', { minAgeMs: 30 * 60 * 1000 });
    assert.deepEqual(api.deleted, [10], 'só o que passou da margem sai');
  } finally {
    api.restore();
  }
});
