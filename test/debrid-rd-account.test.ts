import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realdebrid from '../src/debrid/realdebrid.js';
import * as memo from '../src/debrid/inventory-memo.js';
import * as cache from '../src/utils/cache.js';

/**
 * Conta RD no painel, paginação da listagem e o memo vivo: o play/autofetch
 * atualiza o retrato da conta sem esperar o TTL do inventário, e o play de um
 * hash já pronto resolve pelo memo sem re-listar a conta inteira.
 */

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

function mockFetch(handler: (url: URL) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
  return {
    urls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

const ok = (body: any) => ({ ok: true, status: 200, async json() { return body; } });

test('accountStatus do Real-Debrid reporta ocupação e validade do premium', async () => {
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/user') {
      return ok({ type: 'premium', expiration: '2026-09-18T01:43:01.000Z' });
    }
    if (url.pathname === '/rest/1.0/torrents') {
      return ok([
        { id: 'R1', hash: H1, status: 'downloaded' },
        { id: 'R2', hash: H2, status: 'downloading' },
        { id: 'R3', hash: 'c'.repeat(40), status: 'magnet_error' },
      ]);
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    const status = await realdebrid.accountStatus!('chave');
    assert.equal(status.magnets, 3);
    assert.equal(status.ready, 1);
    assert.equal(status.active, 1);
    assert.equal(status.error, 1);
    assert.equal(status.premiumUntil, Date.parse('2026-09-18T01:43:01.000Z'));
    const paths = mock.urls.map((u) => u.pathname);
    assert.ok(!paths.includes('/rest/1.0/torrents/list'), 'endpoint aposentado não pode voltar');
  } finally {
    mock.restore();
  }
});

test('listagem do Real-Debrid pagina e para no teto defensivo', async () => {
  const fullPage = (offset: number) => Array.from({ length: 2500 }, (_, i) => ({
    id: `T${offset + i}`,
    hash: (offset + i).toString(16).padStart(40, '0'),
    filename: 'Filme.mkv',
    bytes: 1,
    status: 'downloaded',
  }));
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents') {
      // Sempre cheia: só o teto de 10.000 linhas pode terminar a leitura.
      return ok(fullPage(Number(url.searchParams.get('offset') || 0)));
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    const items = await realdebrid.inventory('chave');
    const offsets = mock.urls.map((u) => u.searchParams.get('offset'));
    assert.deepEqual(offsets, ['0', '2500', '5000', '7500'], 'quatro páginas e para no teto');
    assert.equal(items.length, 10000, 'o adaptador lê até o teto; o corte fino (inventoryMax) é do registry');
  } finally {
    mock.restore();
  }
});

test('note/forget só mutam memo quente', async () => {
  const key = 'chave-memo-frio';
  cache.forget(memo.memoKey('realdebrid', key));
  assert.equal(memo.peek('realdebrid', key), null);
  assert.equal(memo.note('realdebrid', key, { title: 'T', infoHash: H1, size: 1 }), false, 'memo frio não vira inventário');
  assert.equal(memo.peek('realdebrid', key), null);

  const warm = 'chave-memo-quente';
  cache.forget(memo.memoKey('realdebrid', warm));
  memo.store('realdebrid', warm, []);
  assert.equal(memo.note('realdebrid', warm, { title: 'Filme.mkv', infoHash: H1.toUpperCase(), size: 10, id: 'ID1' }), true);
  // Upsert: mesmo hash não duplica, só substitui.
  assert.equal(memo.note('realdebrid', warm, { title: 'Filme BR.mkv', infoHash: H1, size: 20, id: 'ID1' }), true);
  let items = memo.peek('realdebrid', warm)!;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Filme BR.mkv');
  assert.equal(items[0].infoHash, H1, 'hash normaliza em minúsculo');

  assert.equal(memo.forget('realdebrid', warm, H1), true);
  assert.equal(memo.forget('realdebrid', warm, H1), false, 'segundo forget é no-op');
  assert.deepEqual(memo.peek('realdebrid', warm), []);
  cache.forget(memo.memoKey('realdebrid', warm));
});

test('resolveLink de hash pronto resolve pelo memo sem re-listar a conta', async () => {
  const key = 'chave-memo-play';
  cache.forget(memo.memoKey('realdebrid', key));
  memo.store('realdebrid', key, [{ title: 'Filme.mkv', infoHash: H1, size: 10, id: 'MEMO-ID' }]);
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents') {
      throw new Error('memo quente não pode pagar a listagem completa no play');
    }
    if (url.pathname === '/rest/1.0/torrents/info/MEMO-ID') {
      return ok({ id: 'MEMO-ID', status: 'downloaded', filename: 'Filme.mkv', bytes: 10, files: [{ id: 1, path: '/Filme.mkv', bytes: 10, selected: 1 }], links: ['https://real-debrid.com/d/ABC'] });
    }
    if (url.pathname === '/rest/1.0/unrestrict/link') {
      return ok({ download: 'https://cdn.real-debrid.com/d/ABC/Filme.mkv' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    const link = await realdebrid.resolveLink(key, H1);
    assert.equal(link, 'https://cdn.real-debrid.com/d/ABC/Filme.mkv');
    assert.ok(!mock.urls.some((u) => u.pathname === '/rest/1.0/torrents'), 'listagem da conta não pode rodar com memo quente');
  } finally {
    mock.restore();
    cache.forget(memo.memoKey('realdebrid', key));
  }
});

test('resolveLink atualiza o memo quente quando o torrent fica pronto', async () => {
  const key = 'chave-memo-note';
  cache.forget(memo.memoKey('realdebrid', key));
  memo.store('realdebrid', key, []);
  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents') return ok([]);
    if (url.pathname === '/rest/1.0/torrents/addMagnet') return ok({ id: 'NOVO' });
    if (url.pathname === '/rest/1.0/torrents/info/NOVO') {
      return ok({ id: 'NOVO', status: 'downloaded', filename: 'Novo.mkv', bytes: 5, files: [{ id: 1, path: '/Novo.mkv', bytes: 5, selected: 1 }], links: ['https://real-debrid.com/d/N'] });
    }
    if (url.pathname === '/rest/1.0/unrestrict/link') return ok({ download: 'https://cdn.real-debrid.com/d/N' });
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    await realdebrid.resolveLink(key, H2);
    const items = memo.peek('realdebrid', key)!;
    assert.equal(items.length, 1, 'o play semeia o memo para o ⚡ da próxima busca');
    assert.equal(items[0].infoHash, H2);
    assert.equal(items[0].id, 'NOVO');
  } finally {
    mock.restore();
    cache.forget(memo.memoKey('realdebrid', key));
  }
});
