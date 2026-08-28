// Camada de adaptador do catálogo / limpador BR da conta AllDebrid.
//
// Fases 2/3/4 do lado do ADAPTER (o outro subagente faz src/utils/catalog.ts,
// src/debrid/index.ts e o dashboard). Aqui é o contrato que eles vão consumir:
//
//   - magnetList: normaliza todos os magnets da conta (segundos→ms, hash
//     minúsculo, pula item sem id/hash);
//   - magnetFiles: desembrulha a resposta "às vezes lista de um item" e
//     devolve a árvore de arquivos prontos;
//   - deleteMagnets: remove com backoff exponencial + reenfileiramento, para a
//     rajada de 503 (medida: 13 de 45 deletes paralelos) não deixar magnet
//     para sempre;
//   - sweepUndubbed: inventário frio é AGUARDADO (não pula mais a rodada),
//     estados ativos nunca são alvo, e o "lixo" agora só é o estrangeiro
//     PROVADO (`foreignVerdict === 'condena'`) — ausência de PT nunca mais
//     apaga.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as held from '../src/debrid/protected.js';
import { accountScope } from '../src/utils/request-key.js';

// As esperas (backoff, AbortSignal) mantêm o loop vivo mesmo com o fetch dublé
// resolvendo em microtask; o keepAlive impede o node --test de abortar testes
// pendentes no meio de um poll vazio.
let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

const velhoSec = Math.floor(Date.now() / 1000) - 10 * 24 * 3600;

// --- magnetList -----------------------------------------------------------

test('magnetList normaliza segundos→ms, hash em minúsculo e pula item sem id/hash', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    assert.equal(url.pathname.endsWith('/magnet/status'), true, 'uma única chamada à conta inteira');
    assert.equal(url.searchParams.get('id'), null, 'lista da conta inteira, não é por magnet');
    return {
      ok: true,
      async json() {
        return {
          status: 'success',
          data: {
            magnets: [
              { id: 1, hash: 'A'.repeat(40), filename: 'Movie.2024.1080p', size: 100, status: 'Ready', ready: true, uploadDate: 1620000000 },
              { id: 'dois', hash: 'ef'.repeat(20), filename: 'Outra', size: 0, status: 'Downloading', uploadDate: 0 },
              { hash: 'bad', filename: 'NoId', status: 'Ready' }, // sem id: pula
              { id: 5, filename: 'NoHash', status: 'Ready' },     // sem hash: pula
            ],
          },
        };
      },
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    const rows = await alldebrid.magnetList('chave-magnet-list');
    assert.equal(rows.length, 2, 'itens sem id ou sem hash são pulados');
    const [a, b] = rows;
    assert.equal(a.id, 1);
    assert.equal(a.hash, 'a'.repeat(40), 'hash normalizado em minúsculo');
    assert.equal(a.uploadDate, 1620000000 * 1000, 'segundos→ms');
    assert.equal(a.ready, true);
    assert.equal(a.status, 'Ready');
    assert.equal(b.uploadDate, 0, 'uploadDate ausente = 0');
    assert.equal(b.ready, false, 'sem ready nem status Ready');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- magnetFiles ----------------------------------------------------------

test('magnetFiles desembrulha o "lista de um item" e devolve arquivos prontos', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/magnet/status')) {
      const id = url.searchParams.get('id');
      if (id === '7') {
        // Resposta às vezes vem ENVUELTA como lista de um único magnet.
        return {
          ok: true,
          async json() {
            return {
              status: 'success',
              data: {
                magnets: [{
                  id: 7,
                  status: 'Ready',
                  files: [
                    { n: 'Filme.2024', e: [{ n: 'filme.mkv', s: 9000, l: 'https://ad.test/filme' }] },
                  ],
                }],
              },
            };
          },
        };
      }
      if (id === '8') {
        return { ok: true, async json() { return { status: 'success', data: { magnets: { id: 8, status: 'Downloading' } } }; } };
      }
      if (id === '9') {
        return { ok: true, async json() { return { status: 'success', data: { magnets: { id: 9, status: 'Ready', files: [] } } }; } };
      }
      throw new Error(`id inesperado: ${id}`);
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  try {
    const files = await alldebrid.magnetFiles('chave-files', 7);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'Filme.2024/filme.mkv');

    const nReady = await alldebrid.magnetFiles('chave-files', 8);
    assert.deepEqual(nReady, [], 'torrent não-Ready: nunca lança por estado; devolve []');

    const semFiles = await alldebrid.magnetFiles('chave-files', 9);
    assert.deepEqual(semFiles, [], 'sem files: []');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- deleteMagnets (backoff + reenfileiramento) ---------------------------

/**
 * Dublê de /magnet/delete que falha segundo `fail(id, attempt)` (attempt 1-K).
 * Falha devolve `status:"error"` no corpo (é assim a AllDebrid entrega o 503),
 * sucesso devolve `success`.
 */
function mockDelete(fail: (id: number, attempt: number) => boolean) {
  const deleted: number[] = [];
  const calls = new Map<number, number>();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/magnet/delete')) throw new Error(`URL inesperada: ${url.pathname}`);
    const id = Number(url.searchParams.get('id'));
    const attempt = (calls.get(id) || 0) + 1;
    calls.set(id, attempt);
    deleted.push(id);
    if (fail(id, attempt)) {
      return { ok: true, async json() { return { status: 'error', error: { code: 'MAGNET_INVALID_ID', message: 'temporarily unavailable (503)' } }; } };
    }
    return { ok: true, async json() { return { status: 'success', data: {} }; } };
  }) as unknown as typeof globalThis.fetch;

  return {
    deleted,
    calls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

// Esperas zeradas e waitFn instantâneo: o teste não paga o backoff de produção
// (400/800/1600ms). Produção usa o padrão — `wait` do common.js.
const FAST = { waitFn: async () => {}, delay: [0, 0, 0] };

test('deleteMagnets: 503 nas duas primeiras de um id e sucesso depois — o id é removido', async () => {
  const api = mockDelete((id: number, attempt: number) => attempt <= 2);
  try {
    const r = await alldebrid.deleteMagnets('chave-del', [41], FAST);
    assert.equal(r.ok, 1);
    assert.equal(r.falhas.length, 0);
    assert.equal(api.calls.get(41), 3, 'duas 503 + uma sucesso = removido no lugar');
  } finally {
    api.restore();
  }
});

test('deleteMagnets: 503 sempre cai em falhas depois das duas rodadas', async () => {
  const api = mockDelete(() => true);
  try {
    const r = await alldebrid.deleteMagnets('chave-del', [55], FAST);
    assert.equal(r.ok, 0);
    assert.equal(r.falhas.length, 1, 'reenfileirado na segunda rodada, falhou de verdade');
    assert.equal(api.calls.get(55), 6, '3 tentativas da rodada 1 + 3 da rodada 2');
  } finally {
    api.restore();
  }
});

// --- sweepUndubbed ----------------------------------------------------------

/**
 * Conta com chamada de inventário cronometrada e lista MUTÁVEL. A primeira
 * chamada sem id é o snapshot que o sweepUndubbed AGUARDA; as seguintes são a
 * leitura da própria rodada. `onWarm(list)` roda quando o snapshot resolve —
 * é onde o teste injeta o magnet que a rodada deve achar (depois do snapshot,
 * então ele NÃO vira preexistente).
 */
function mockAccount(preexistentes: any[], onWarm: (list: any[]) => void, { inventoryDelayMs = 50 }: { inventoryDelayMs?: number } = {}) {
  const list = [...preexistentes];
  const deleted: number[] = [];
  let statusCalls = 0;
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) {
      const id = url.searchParams.get('id');
      if (id == null) {
        // A PRIMEIRA chamada sem id é o snapshot que o sweepUndubbed AGUARDA:
        // devolve SÓ o que já estava na conta (preexistente). A SEGUNDA é a
        // leitura da rodada — é nela que `onWarm` injeta o magnet novo, que não
        // fazia parte do snapshot e portanto NÃO vira preexistente.
        statusCalls += 1;
        if (statusCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, inventoryDelayMs));
        } else {
          onWarm(list);
        }
        return body({ magnets: [...list] });
      }
      const magnet = list.find((m: any) => String(m.id) === id);
      return body({ magnets: magnet ? [magnet] : [] });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deleted.push(Number(url.searchParams.get('id')));
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    deleted,
    list,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

test('sweepUndubbed: inventário frio é AGUARDADO, a rodada NÃO é pulada', async () => {
  // O bug documentado: com snapshot frio, `knownBefore` devolve null e a
  // rodada inteira pulava ('inventário frio') — a guarda de 5min do TTL contra
  // o timer de 6h é por isso a conta chegou a 812. Como a varredura é em
  // fundo, deve AGUARDAR o inventário (que chega aqui em ~50ms) e limpar.
  const api = mockAccount(
    [{ id: 1, hash: 'aa'.repeat(20), status: 'Ready', filename: 'Acervo Dublado', uploadDate: velhoSec }],
    (list) => {
      list.push({ id: 2, hash: 'bb'.repeat(20), status: 'Ready', filename: 'Movie.2024.TRUEFRENCH.1080p.x264', uploadDate: velhoSec });
    },
    { inventoryDelayMs: 30 },
  );
  try {
    const r = await alldebrid.sweepUndubbed('chave-sweep-frio', { minAgeMs: 24 * 3600 * 1000 });
    assert.equal(r.pulado, undefined, 'inventário frio aguardado: não deve pular');
    assert.deepEqual(api.deleted, [2], 'o estrangeiro PROVADO e velho é removido');
    assert.equal(r.varridos, 1);
  } finally {
    api.restore();
  }
});

test('sweepUndubbed: estado ativo NUNCA é alvo, mesmo com título condenável', async () => {
  const api = mockAccount(
    [{ id: 1, hash: 'cc'.repeat(20), status: 'Ready', filename: 'Acervo Dublado', uploadDate: velhoSec }],
    (list) => {
      // Baixando agora: download em curso não é lixo.
      list.push({ id: 2, hash: 'cd'.repeat(20), status: 'Downloading', filename: 'Movie.2024.TRUEFRENCH.1080p.x264', uploadDate: velhoSec });
    },
    { inventoryDelayMs: 5 },
  );
  try {
    const r = await alldebrid.sweepUndubbed('chave-sweep-ativo', { minAgeMs: 24 * 3600 * 1000 });
    assert.deepEqual(api.deleted, [], 'estado ativo não é alvo');
    assert.equal(r.varridos, 0);
  } finally {
    api.restore();
  }
});

test('sweepUndubbed: estrangeiro PROVADO é alvo; ambíguo e PT nunca são', async () => {
  const api = mockAccount(
    [{ id: 1, hash: 'ee'.repeat(20), status: 'Ready', filename: 'Acervo Dublado', uploadDate: velhoSec }],
    (list) => {
      list.push(
        { id: 11, hash: 'ef'.repeat(20), status: 'Ready', filename: 'Movie.2024.TRUEFRENCH.1080p.x264', uploadDate: velhoSec },
        { id: 12, hash: 'ac'.repeat(20), status: 'Ready', filename: 'Vingadores Ultimato 2019 1080p', uploadDate: velhoSec },
        { id: 13, hash: 'ad'.repeat(20), status: 'Ready', filename: 'Filme Dublado', uploadDate: velhoSec },
      );
    },
    { inventoryDelayMs: 5 },
  );
  try {
    const r = await alldebrid.sweepUndubbed('chave-sweep-verdicts', { minAgeMs: 24 * 3600 * 1000 });
    assert.deepEqual(api.deleted, [11], 'só o estrangeiro PROVADO sai');
    assert.equal(r.varridos, 1);
  } finally {
    api.restore();
  }
});

test('sweepUndubbed: protegido (held) continua fora mesmo título condenável', async () => {
  const CHAVE_HELD = 'chave-sweep-held';
  const CONTA_HELD = accountScope(CHAVE_HELD);
  const api = mockAccount(
    [{ id: 1, hash: 'ff'.repeat(20), status: 'Ready', filename: 'Acervo Dublado', uploadDate: velhoSec }],
    (list) => {
      list.push({ id: 14, hash: '14'.repeat(20), status: 'Ready', filename: 'Movie.2024.TRUEFRENCH.1080p.x264', uploadDate: velhoSec });
    },
    { inventoryDelayMs: 5 },
  );
  held.hold('14'.repeat(20), 3600, CONTA_HELD);
  try {
    const r = await alldebrid.sweepUndubbed(CHAVE_HELD, { minAgeMs: 24 * 3600 * 1000 });
    assert.deepEqual(api.deleted, [], 'held sobrevive à varredura');
    assert.equal(r.varridos, 0);
  } finally {
    held.release('14'.repeat(20), CONTA_HELD);
    api.restore();
  }
});