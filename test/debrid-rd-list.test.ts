import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realdebrid from '../src/debrid/realdebrid.js';

/**
 * Regressão: o Real-Debrid não tem `/torrents/list` — esse caminho responde
 * 404 `unknown_method`. Enquanto o adaptador chamava ele, o inventário morria
 * no aquecimento, nada era reconhecido como já baixado na conta e a lista
 * inteira saía marcada [RD Download] mesmo com o arquivo pronto lá dentro.
 *
 * A listagem também é paginada: sem `?limit` o Real-Debrid devolve só a
 * primeira página, então uma conta grande perderia o que estiver depois dela.
 */

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

function mockRealDebridList(rows: any[]) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const urls: URL[] = [];

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname === '/rest/1.0/torrents') {
      return { ok: true, async json() { return rows; } };
    }
    // Espelha o 404 real do endpoint inexistente.
    return {
      ok: false,
      status: 404,
      async text() { return '{"error":"unknown_method","error_code":3}'; },
      async json() { return { error: 'unknown_method', error_code: 3 }; },
    };
  }) as unknown as typeof globalThis.fetch;

  return {
    urls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

test('inventário do Real-Debrid lê GET /torrents paginado', async () => {
  const mock = mockRealDebridList([
    { hash: H1.toUpperCase(), filename: 'Project Hail Mary 2026 1080p WEB.mkv', bytes: 9765757967, status: 'downloaded' },
    { hash: H2, filename: 'Baixando Ainda 2026.mkv', bytes: 100, status: 'downloading' },
  ]);
  try {
    const items = await realdebrid.inventory('chave');

    const paths = mock.urls.map((u) => u.pathname);
    assert.ok(!paths.includes('/rest/1.0/torrents/list'), 'não pode chamar o endpoint aposentado');
    assert.deepEqual(paths, ['/rest/1.0/torrents']);
    assert.equal(mock.urls[0].searchParams.get('limit'), '2500', 'precisa pedir a página ampliada inteira');

    // Só o pronto entra, e o hash normaliza em minúsculo.
    assert.deepEqual(items, [{ title: 'Project Hail Mary 2026 1080p WEB.mkv', infoHash: H1, size: 9765757967 }]);
  } finally {
    mock.restore();
  }
});

test('torrentStatus do Real-Debrid também usa GET /torrents', async () => {
  const mock = mockRealDebridList([
    { id: '4JUAJZRIEWFYE', hash: H1, status: 'downloaded' },
    { id: 'XPTO', hash: H2, status: 'magnet_error' },
  ]);
  try {
    const status = await realdebrid.torrentStatus('chave');

    assert.deepEqual(mock.urls.map((u) => u.pathname), ['/rest/1.0/torrents']);
    assert.equal(mock.urls[0].searchParams.get('limit'), '2500');
    assert.equal(status[H1].state, 'ready');
    assert.equal(status[H1].id, '4JUAJZRIEWFYE');
    assert.equal(status[H2].state, 'dead');
  } finally {
    mock.restore();
  }
});

/**
 * Regressão do play: o `/torrents/selectFiles` do Real-Debrid responde 204 com
 * corpo vazio. O helper `json()` mandava isso direto pro `res.json()`, que
 * estourava "Unexpected end of JSON input" no meio do resolve — o play devolvia
 * 502 mesmo com o arquivo 100% pronto na conta.
 */
test('json() aceita 204 sem corpo em vez de estourar no parse', async () => {
  const { json } = await import('../src/debrid/common.js');
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 204,
    async text() { return ''; },
    async json() { throw new SyntaxError('Unexpected end of JSON input'); },
  })) as unknown as typeof globalThis.fetch;
  try {
    assert.equal(await json('https://api.real-debrid.com/rest/1.0/torrents/selectFiles/X', { method: 'POST' }), null);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

/**
 * 451 `infringing_file` é o Real-Debrid recusando o conteúdo. É definitivo por
 * torrent, então precisa virar um erro próprio: a rota devolve 451 legível em
 * vez do 502 genérico, sem fingir que houve ausência de vídeo no magnetdb.
 */
test('json() classifica 451 como BlockedError', async () => {
  const { json, isBlockedError, isAuthError, isQuotaError, isRateLimitError } = await import('../src/debrid/common.js');
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 451,
    async text() { return '{"error":"infringing_file","error_code":35}'; },
  })) as unknown as typeof globalThis.fetch;
  try {
    const err = await json('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', { method: 'POST' })
      .then(() => null, (e: any) => e);
    assert.ok(err, 'precisa lançar');
    assert.ok(isBlockedError(err), 'tem que ser BlockedError');
    assert.ok(!isAuthError(err), 'não pode ser confundido com credencial ruim');
    assert.ok(!isQuotaError(err), 'não pode ser confundido com conta cheia');
    assert.ok(!isRateLimitError(err), 'não pode ser confundido com rate limit');
    assert.match(err.message, /infringing_file/);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('enqueue do Real-Debrid recusa 451 sem criar limpeza ou exceção', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const calls: string[] = [];
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push(`${init?.method || 'GET'} ${new URL(String(input)).pathname}`);
    return {
      ok: false,
      status: 451,
      async text() { return '{"error":"infringing_file","error_code":35}'; },
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    assert.equal(await realdebrid.enqueue('chave', H1), false);
    assert.deepEqual(calls, ['POST /rest/1.0/torrents/addMagnet']);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('removeTorrent do Real-Debrid aceita DELETE 204 sem corpo', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 204,
    async json() { throw new SyntaxError('Unexpected end of JSON input'); },
  })) as unknown as typeof globalThis.fetch;
  try {
    assert.equal(await realdebrid.removeTorrent('chave', 'RD1'), true);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

/**
 * O play de algo que o usuário JÁ baixou não pode passar pelo addMagnet outra
 * vez: além de duplicar o torrent na conta, o Real-Debrid responde 451
 * `infringing_file` nesse re-add — e o filme pronto, 100% na conta, não tocava.
 */
test('resolveLink reusa o torrent pronto da conta em vez de re-adicionar', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const paths: string[] = [];

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === '/rest/1.0/torrents') {
      return { ok: true, status: 200, async json() {
        return [{ id: 'JA-PRONTO', hash: H1, filename: 'Filme.mkv', bytes: 10, status: 'downloaded' }];
      } };
    }
    if (url.pathname === '/rest/1.0/torrents/addMagnet') {
      return { ok: false, status: 451, async text() { return '{"error":"infringing_file"}'; } };
    }
    if (url.pathname === '/rest/1.0/torrents/info/JA-PRONTO') {
      return { ok: true, status: 200, async json() {
        return { id: 'JA-PRONTO', status: 'downloaded', files: [{ id: 1, path: '/Filme.mkv', bytes: 10, selected: 1 }], links: ['https://real-debrid.com/d/ABC'] };
      } };
    }
    if (url.pathname === '/rest/1.0/unrestrict/link') {
      return { ok: true, status: 200, async json() { return { download: 'https://cdn.real-debrid.com/d/ABC/Filme.mkv' }; } };
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  try {
    const link = await realdebrid.resolveLink('chave', H1);
    assert.equal(link, 'https://cdn.real-debrid.com/d/ABC/Filme.mkv');
    assert.ok(!paths.includes('/rest/1.0/torrents/addMagnet'), 'não pode re-adicionar o que já está pronto');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
