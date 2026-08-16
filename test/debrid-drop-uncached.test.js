const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * A limpeza automática da AllDebrid — o único código do addon que APAGA coisa
 * na conta do usuário. O contrato dela colide de propósito com o download
 * automático da fonte BR: o dropUncached remove tudo que não está em cache, e o
 * autofetch coloca de propósito um torrent que ainda não está pronto.
 *
 * As travas de autofetch e a semântica de src/debrid/protected.js estão em
 * test/autofetch.test.js. Aqui é o adaptador: quem de fato chama /magnet/delete.
 */
const config = require('../src/config');
const alldebrid = require('../src/debrid/alldebrid');
const held = require('../src/debrid/protected');
const { accountScope } = require('../src/utils/request-key');

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
function mockAllDebrid({ ready = [], statusOf = () => 'Ready', files = [] } = {}) {
  const deleted = [];
  const uploaded = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  // O AbortSignal.timeout real deixaria um timer pendurado por teste.
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const body = (data) => ({ ok: true, async json() { return { status: 'success', data }; } });

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
  };

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

// A espera entre polls do resolveLink usa timer unref() — ela não segura o
// event loop. Com o fetch dublado (que resolve em microtask) não sobra nenhum
// handle vivo, o loop esvazia no meio do poll e o runner aborta os testes
// pendentes. Este handle existe só para manter o loop de pé enquanto o arquivo
// roda; não muda o comportamento do adaptador.
let keepAlive;
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
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'chave inválida' } };
    },
  });

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
      (err) => err.isAuthError === true && /chave inválida/.test(err.message),
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
