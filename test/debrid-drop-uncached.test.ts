// Rodada 2: checagem ligada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';

/** Grava um registro adprot direto na chave real, com a idade que o teste quer. */
const retain = (
  account: string,
  hash: string,
  { readyAt = null, acceptedAt = Date.now() }: { readyAt?: number | null; acceptedAt?: number } = {},
) => {
  cache.set(`${prefix('adprot')}alldebrid:${account}:${hash}`, { acceptedAt, readyAt }, 3600);
};

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

test('os dois switches desligados não apagam nada, e ainda assim informa o cache', async () => {
  const api = mockAllDebrid({ ready: [READY] });
  const origUncached = config.debrid.dropUncached;
  const origReady = config.debrid.dropReady;
  try {
    config.debrid.dropUncached = false;
    config.debrid.dropReady = false;
    const result = await alldebrid.checkCached(KEY, [READY, COLD]);
    await settle();

    assert.deepEqual([...result.cached], [READY]);
    assert.deepEqual(api.deleted, [], 'desligado é desligado: a conta não é tocada');
  } finally {
    config.debrid.dropUncached = origUncached;
    config.debrid.dropReady = origReady;
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
function mockAccountWith(
  preexisting: any,
  readyHashes: any,
  { snapshotAfterUploads = false, failDelete = false, failStatus = false, statusDelayMs = 0 } = {},
) {
  const deleted: number[] = [];
  let failStatusActive = failStatus;
  let statusDelay = statusDelayMs;
  let statusCalls = 0;
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
      if (failStatusActive) {
        return {
          ok: false,
          status: 500,
          async json() { return { status: 'error', error: { message: 'Internal Server Error' } }; },
        };
      }
      const id = url.searchParams.get('id');
      if (id != null) {
        const magnet = byId.get(Number(id));
        return body({ magnets: magnet ? [magnet] : [] });
      }
      // Sem id é o inventário/ocupação: a lista do que existe NESTE instante.
      statusCalls += 1;
      if (statusDelay) await new Promise((resolve) => setTimeout(resolve, statusDelay));
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
    set failStatus(val: boolean) {
      failStatusActive = val;
    },
    get failStatus() {
      return failStatusActive;
    },
    set statusDelayMs(val: number) {
      statusDelay = val;
    },
    get statusCalls() {
      return statusCalls;
    },
    addExternal(hash: string, ready = true) {
      const id = nextId++;
      const magnet = { hash, id, status: 'Ready', ready };
      byId.set(id, magnet);
      byHash.set(hash, magnet);
      if (ready && !readyHashes.includes(hash)) {
        readyHashes.push(hash);
      }
      return id;
    },
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

// --- Varredura de não-dublados antigos ------------------------------------
//
// A única limpeza que alcança o lixo tocável: não está morto nem aparece mais
// em busca. Por ser destrutiva, cada trava (balde de áudio, idade, held,
// inventário conhecido, fail-safe, teto) é exercitada individualmente.

/**
 * Dublê de conta com lista MUTÁVEL: o primeiro inventário carrega o acervo e
 * o que entra depois simula uploads do addon pós-snapshot — é a única forma
 * de algo ser candidato à limpeza (knownBefore protege tudo que já estava).
 */
function mockAccountMutable(magnets: any[]) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) return body({ magnets: [...magnets] });
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  return { deleted, magnets, restore() { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}

const velhoSec = Math.floor(Date.now() / 1000) - 10 * 24 * 3600; // 10 dias
const novoSec = Math.floor(Date.now() / 1000) - 60;               // agora há pouco
const SETE_DIAS = 7 * 24 * 3600 * 1000;

test('varredura undubbed: lixo velho sai; dub/dual/pt e o acervo ficam', async () => {
  const CHAVE = 'chave-varredura-undubbed-baldes';
  const api = mockAccountMutable([
    // Acervo no primeiro inventário com título de lixo: só o knownBefore o
    // protege — isola essa trava junto com as demais.
    { id: 1, hash: 'c1'.repeat(20), status: 'Ready', filename: 'Old Movie 1990 1080p BluRay x264', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: 'c2'.repeat(20), status: 'Ready', filename: 'Foreign Movie 2019 1080p WEBRip x264', uploadDate: velhoSec },
      { id: 3, hash: 'c3'.repeat(20), status: 'Ready', filename: 'Nome do Filme 2019 Dublado 1080p', uploadDate: velhoSec },
      { id: 4, hash: 'c4'.repeat(20), status: 'Ready', filename: 'Nome do Filme 2019 Dual Audio 1080p', uploadDate: velhoSec },
      { id: 5, hash: 'c5'.repeat(20), status: 'Ready', filename: 'Coração de Vingança 2019 720p', uploadDate: velhoSec },
    );

    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [2], 'só o balde lixo antigo sai; dub/dual/pt e knownBefore ficam');
    assert.equal(r.varridos, 1);
  } finally {
    api.restore();
  }
});

test('varredura undubbed: lixo recente sobrevive à idade mínima', async () => {
  const CHAVE = 'chave-varredura-undubbed-idade';
  const api = mockAccountMutable([
    { id: 1, hash: 'd1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: 'd2'.repeat(20), status: 'Ready', filename: 'Recent Movie 2024 1080p WEBRip', uploadDate: novoSec },
      { id: 3, hash: 'd3'.repeat(20), status: 'Ready', filename: 'Old Movie 2015 720p HDTV', uploadDate: velhoSec },
    );

    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [3], 'o recente fica, o velho sai');
  } finally {
    api.restore();
  }
});

test('varredura undubbed: sem uploadDate não há prova de idade — fica', async () => {
  // Tocável exige prova: o sweepDead trata "sem data" como antigo (morto é
  // lixo em qualquer idade), mas aqui a trava é a inversa — sem idade
  // PROVADA, o magnet fica (uploadDate ausente ou 0).
  const CHAVE = 'chave-varredura-undubbed-sem-data';
  const api = mockAccountMutable([
    { id: 1, hash: 'g1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: 'g2'.repeat(20), status: 'Ready', filename: 'Old Foreign Movie 2012 1080p WEBRip x264' },
      { id: 3, hash: 'g3'.repeat(20), status: 'Ready', filename: 'Another Old Movie 2013 BRRip x264', uploadDate: 0 },
      { id: 4, hash: 'g4'.repeat(20), status: 'Ready', filename: 'Third Old Movie 2011 HDTV x264', uploadDate: velhoSec },
    );

    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [4], 'sem prova de idade, fica; só o datado e velho sai');
  } finally {
    api.restore();
  }
});

test('varredura undubbed: download do autofetch em hold sobrevive', async () => {
  const CHAVE = 'chave-varredura-undubbed-held';
  const PROTEGIDO = 'e2'.repeat(20);
  const api = mockAccountMutable([
    { id: 1, hash: 'e1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  held.hold(PROTEGIDO, 60, accountScope(CHAVE));
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: PROTEGIDO, status: 'Downloading', filename: 'New Movie 2024 1080p WEBRip', uploadDate: velhoSec },
      { id: 3, hash: 'e3'.repeat(20), status: 'Ready', filename: 'Another Old Movie 2014 BRRip', uploadDate: velhoSec },
    );

    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [3], 'o held sobrevive à varredura');
  } finally {
    held.release(PROTEGIDO, accountScope(CHAVE));
    api.restore();
  }
});

test('varredura undubbed: inventário frio pula a rodada inteira (fail-safe)', async () => {
  const CHAVE = 'chave-varredura-undubbed-fria';
  const api = mockAccountMutable([
    { id: 2, hash: 'f2'.repeat(20), status: 'Ready', filename: 'Old Movie 2010 720p HDTV', uploadDate: velhoSec },
  ]);
  try {
    // Sem aquecer o inventário: não há prova de proveniência, nada pode sair
    // (mesmo padrão do dropReady).
    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.equal(r.pulado, 'inventário frio');
    assert.equal(r.varridos, 0);
    assert.deepEqual(api.deleted, [], 'fail-safe: nada é removido sem inventário');
    await settle(); // deixa o carregamento disparado em fundo assentar
  } finally {
    api.restore();
  }
});

test('varredura undubbed: teto corta pelos mais antigos, independente da ordem', async () => {
  const CHAVE = 'chave-varredura-undubbed-teto';
  const agora = Math.floor(Date.now() / 1000);
  const api = mockAccountMutable([
    { id: 1, hash: 'a1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    // Cinco lixos velhos (16–20 dias), inseridos fora de ordem de idade.
    const ordem = [3, 0, 4, 1, 2];
    for (const i of ordem) {
      api.magnets.push({
        id: 10 + i,
        hash: `a${i + 2}`.repeat(20),
        status: 'Ready',
        filename: `Old Movie ${2010 + i} 720p HDTV x264`,
        uploadDate: agora - (20 - i) * 24 * 3600,
      });
    }

    // O teto de produção é 100 (config.sweepUndubbedMax); o override exercita
    // o MESMO corte — ordenar por idade antes de cortar.
    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS, max: 2 });
    assert.deepEqual(api.deleted.sort((a, b) => a - b), [10, 11], 'os dois mais antigos saem');
    assert.equal(r.varridos, 2);
  } finally {
    api.restore();
  }
});

// -----------------------------------------------------------------------------
// Proteção DURÁVEL (`adprot:v1`) no adaptador — a retenção do acervo BR que
// sobrevive ao restart, implementada sobre o registro persistido em vez do hold
// volátil em memória. Os testes abaixo provam que os pontos de limpeza consultam
// a camada durável (e só ela — sem depender de hold) e que o estado terminal
// (dead) e o kill switch ainda restauram a limpeza.
// -----------------------------------------------------------------------------

test('proteção durável sem hold pula dropUncached e dropReady, e conta protectedBrSkipped', async () => {
  const CHAVE = 'chave-adprot-checagem';
  const ACCOUNT_ADPROT = accountScope(CHAVE);
  const BR_FRIO = 'ad'.repeat(20);
  const BR_PRONTO = 'ae'.repeat(20);
  const origUncached = config.debrid.dropUncached;
  const origReady = config.debrid.dropReady;
  config.debrid.dropUncached = true;
  config.debrid.dropReady = true;
  const api = mockAccountWith([], [BR_PRONTO]);
  metrics.reset();
  try {
    // Inventário aquecido: esta passada TEM autoridade para remover prontos
    // que não são do usuário — o que poupa o BR_PRONTO é a proteção durável.
    await alldebrid.warmInventory(CHAVE);
    await settle();
    await flushImmediate();

    held.protectBr('alldebrid', ACCOUNT_ADPROT, BR_FRIO);
    held.protectBr('alldebrid', ACCOUNT_ADPROT, BR_PRONTO);
    metrics.reset();
    await alldebrid.checkCached(CHAVE, [BR_FRIO, BR_PRONTO]);
    await settle();

    assert.equal(api.deleted.length, 0, 'durável: nem o frio (dropUncached) nem o pronto (dropReady) saem');
    assert.equal(
      metrics.snapshot().counters['debrid.cleanup.protectedBrSkipped'] || 0,
      2,
      'os dois hashes poupados pela proteção durável contam na métrica',
    );
  } finally {
    config.debrid.dropUncached = origUncached;
    config.debrid.dropReady = origReady;
    held.unprotect('alldebrid', ACCOUNT_ADPROT, BR_FRIO);
    held.unprotect('alldebrid', ACCOUNT_ADPROT, BR_PRONTO);
    metrics.reset();
    api.restore();
  }
});

test('resolveLink NÃO apaga BR retido pela proteção durável (mesmo sem hold)', async () => {
  const api = mockAllDebrid({ statusOf: () => 'Downloading' });
  const ACCOUNT_ADPROT = accountScope(KEY);
  try {
    held.protectBr('alldebrid', ACCOUNT_ADPROT, HELD);
    const link = await alldebrid.resolveLink(KEY, HELD, {});

    assert.equal(link, null);
    assert.deepEqual(api.deleted, [], 'a proteção durável preserva o download do BR no play');
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, HELD);
    api.restore();
  }
});

test('varredura undubbed pula o BR retido pela proteção durável', async () => {
  const CHAVE = 'chave-varredura-adprot';
  const ACCOUNT_ADPROT = accountScope(CHAVE);
  const BR_RETIDO = 'ab'.repeat(20);
  const LIXO = 'ac'.repeat(20);
  const api = mockAccountMutable([
    { id: 1, hash: 'ad'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  held.protectBr('alldebrid', ACCOUNT_ADPROT, BR_RETIDO);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: BR_RETIDO, status: 'Ready', filename: 'Foreign Old Movie 2009 720p WEBRip', uploadDate: velhoSec },
      { id: 3, hash: LIXO, status: 'Ready', filename: 'Another Foreign Movie 2010 BRRip', uploadDate: velhoSec },
    );

    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [3], 'o BR retido (durável) sobrevive; só o lixo solto sai');
    assert.equal(r.varridos, 1);
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, BR_RETIDO);
    api.restore();
  }
});

test('varredura dead remove o BR retido e limpa a proteção durável', async () => {
  const CHAVE = 'chave-varredura-adprot-dead';
  const ACCOUNT_ADPROT = accountScope(CHAVE);
  const M0RTO = 'ae'.repeat(20);
  const api = mockAccountStates([
    { id: 60, hash: M0RTO, status: 'No peer after 30 minutes', uploadDate: antigo },
  ]);
  held.protectBr('alldebrid', ACCOUNT_ADPROT, M0RTO);
  metrics.reset();
  try {
    assert.equal(held.isDurablyProtected('alldebrid', ACCOUNT_ADPROT, M0RTO), true, 'precondição: retido');

    await alldebrid.sweepDead(CHAVE);
    assert.deepEqual(api.deleted, [60], 'estado terminal é lixo, não acervo: remove mesmo durável');
    assert.equal(held.isDurablyProtected('alldebrid', ACCOUNT_ADPROT, M0RTO), false, 'o dead destrava a proteção');
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, M0RTO);
    metrics.reset();
    api.restore();
  }
});

test('proteção durável é por conta: a mesma hash em outra conta continua sendo limpa', async () => {
  const OUTRA = 'chave-de-teste-b';
  const api = mockAllDebrid({ ready: [] });
  const ACCOUNT_ADPROT = accountScope(KEY);
  metrics.reset();
  try {
    held.protectBr('alldebrid', ACCOUNT_ADPROT, HELD);
    await alldebrid.checkCached(OUTRA, [HELD]);
    await settle();

    assert.deepEqual(api.deleted, [IDS[HELD]], 'a retenção de uma conta não vale para a outra');
    assert.equal(metrics.snapshot().counters['debrid.cleanup.protectedBrSkipped'] || 0, 0);
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, HELD);
    metrics.reset();
    api.restore();
  }
});

test('kill switch da proteção durável restaura a limpeza mesmo sobre registro retido', async () => {
  const api = mockAllDebrid({ ready: [] });
  const ACCOUNT_ADPROT = accountScope(KEY);
  const originalProtect = config.debrid.autoFetchProtectBr;
  metrics.reset();
  try {
    config.debrid.autoFetchProtectBr = true;
    held.protectBr('alldebrid', ACCOUNT_ADPROT, HELD);
    assert.equal(held.isDurablyProtected('alldebrid', ACCOUNT_ADPROT, HELD), true, 'precondição: proteção de pé');

    config.debrid.autoFetchProtectBr = false;
    metrics.reset();
    await alldebrid.checkCached(KEY, [HELD]);
    await settle();
    assert.deepEqual(api.deleted, [IDS[HELD]], 'com o kill switch, o registro retido deixa de poupar');
    assert.equal(metrics.snapshot().counters['debrid.cleanup.protectedBrSkipped'] || 0, 0, 'nada conta como poupado');
  } finally {
    config.debrid.autoFetchProtectBr = originalProtect;
    held.unprotect('alldebrid', ACCOUNT_ADPROT, HELD);
    metrics.reset();
    api.restore();
  }
});

// --- Reconcile: o reaper que fecha as janelas de restart --------------------
//
// A varredura agendada só existe para a conta do operador; a de um usuário só
// tem a própria checagem de busca. Um registro durável cuja premissa quebrou
// (pending que nunca tocou no prazo do settle — o lote em memória morreu com o
// restart — ou acervo pronto que regrediu) precisa destravar exatamente aí.

test('pending mais velho que o settle destrava na checagem e volta à limpeza', async () => {
  // Cenário: o autofetch aceitou o BR, o processo reiniciou antes do lote do
  // recheck expirar o settle, e o download nunca completou. Sem reconcile, o
  // registro de 10 anos pouparia o magnet para sempre — mesmo no AllDebrid o
  // contrato sendo "remove se não tocou em autoFetchTtl".
  const CHAVE = 'chave-adprot-pending-velho';
  const CONTA = accountScope(CHAVE);
  const BR = 'af'.repeat(20);
  const api = mockAllDebrid({ ready: [] });
  metrics.reset();
  try {
    retain(CONTA, BR, { acceptedAt: Date.now() - (config.debrid.autoFetchTtl * 1000 + 60_000) });
    assert.equal(held.isDurablyProtected('alldebrid', CONTA, BR), true, 'precondição: retido');

    await alldebrid.checkCached(CHAVE, [BR]);
    await settle();

    assert.equal(held.isDurablyProtected('alldebrid', CONTA, BR), false, 'pending expirado destrava o registro');
    assert.deepEqual(api.deleted, [999], 'o magnet volta à limpeza normal da busca');
    assert.equal(metrics.snapshot().counters['adprot.pendingExpired'] || 0, 1);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
    api.restore();
  }
});

test('acervo pronto que regrediu (deixou de ter ⚡) destrava a retenção', async () => {
  // A retenção promete proteger conteúdo TOCÁVEL. Um magnet pronto cujos
  // arquivos a AllDebrid expirou volta a responder "não pronto": segurar o
  // registro negaria vaga na conta sem entregar ⚡ — pior que limpar.
  const CHAVE = 'chave-adprot-regrediu';
  const CONTA = accountScope(CHAVE);
  const BR = 'b0'.repeat(20);
  const api = mockAllDebrid({ ready: [] });
  metrics.reset();
  try {
    retain(CONTA, BR, { acceptedAt: Date.now() - 3_600_000, readyAt: Date.now() - 3_000_000 });
    await alldebrid.checkCached(CHAVE, [BR]);
    await settle();

    assert.equal(held.isDurablyProtected('alldebrid', CONTA, BR), false, 'sem ⚡ não há acervo a reter');
    assert.deepEqual(api.deleted, [999]);
    assert.equal(metrics.snapshot().counters['adprot.regressed'] || 0, 1);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
    api.restore();
  }
});

test('pending fresco e acervo pronto continuam poupados pelo reconcile', async () => {
  // O reconcile é conservador: download aceito há poucos minutos segue
  // protegido (o settle ainda não venceu), e o pronto com ⚡ intacto é o acervo
  // — a razão da camada existir.
  const CHAVE = 'chave-adprot-reconcile-ok';
  const CONTA = accountScope(CHAVE);
  const NOVO = 'c0'.repeat(20);
  const api = mockAllDebrid({ ready: [] });
  metrics.reset();
  try {
    retain(CONTA, NOVO, { acceptedAt: Date.now() - 60_000 });
    await alldebrid.checkCached(CHAVE, [NOVO]);
    await settle();

    assert.equal(held.isDurablyProtected('alldebrid', CONTA, NOVO), true, 'download dentro do prazo segue retido');
    assert.deepEqual(api.deleted, []);
    assert.equal(metrics.snapshot().counters['adprot.pendingExpired'] || 0, 0);
    assert.equal(metrics.snapshot().counters['adprot.regressed'] || 0, 0);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
    api.restore();
  }
});
