import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as debridlink from '../src/debrid/debridlink.js';
import debrid from '../src/debrid/index.js';

process.env.CACHE_PERSIST = 'false';

const API_KEY = 'test-debridlink-key-123';
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);

function mockFetch(handler: (url: URL, init?: RequestInit) => Promise<any> | any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const result = await handler(url, init);
    return {
      ok: result?.ok ?? true,
      status: result?.status ?? 200,
      json: async () => result?.body ?? result,
    };
  }) as unknown as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

test('debridlink: metadados do adaptador e conformidade com registry', () => {
  assert.equal(debridlink.id, 'debridlink');
  assert.equal(debridlink.label, 'Debrid-Link');
  assert.equal(debridlink.short, 'DL');
  assert.equal(debridlink.cacheCheck, false, 'Debrid-Link não tem endpoint de cache');
  assert.equal(debridlink.autofetchSource, true);
  assert.equal(debridlink.keyUrl, 'https://debrid-link.com/webapp/apikey');

  const registered = debrid.BY_ID.get('debridlink');
  assert.ok(registered, 'deve estar registrado no registry central');
  assert.equal(registered?.id, 'debridlink');
  assert.equal(registered?.cacheCheck, false);
});

test('debridlink: checkCached devolve Set vazio', async () => {
  const cached = await debridlink.checkCached();
  assert.ok(cached instanceof Set);
  assert.equal(cached.size, 0);
});

test('debridlink: resolveLink fluxo feliz com polling e seleção de arquivo', async () => {
  let addCalls = 0;
  let listCalls = 0;

  const restore = mockFetch((url, init) => {
    const pathname = url.pathname;
    if (pathname === '/api/v2/seedbox/add') {
      addCalls += 1;
      assert.equal(init?.method, 'POST');
      assert.equal(init?.headers && (init.headers as any).Authorization, `Bearer ${API_KEY}`);
      return {
        success: true,
        value: {
          id: 'dl-item-42',
          hash: H1,
          name: 'The.Matrix.1999.1080p.BluRay.x264',
          downloadPercent: 50, // ainda baixando no add
        },
      };
    }

    if (pathname === '/api/v2/seedbox/list') {
      listCalls += 1;
      assert.equal(url.searchParams.get('ids'), 'dl-item-42');
      // No 2º listCall completa 100%
      const percent = listCalls >= 2 ? 100 : 80;
      return {
        success: true,
        value: [
          {
            id: 'dl-item-42',
            hash: H1,
            name: 'The.Matrix.1999.1080p.BluRay.x264',
            downloadPercent: percent,
            files: [
              {
                name: 'The.Matrix.1999.1080p.mkv',
                size: 8_500_000_000,
                downloadUrl: 'https://dl.test/stream/matrix-1080p.mkv',
              },
              {
                name: 'Sample.mkv',
                size: 50_000_000,
                downloadUrl: 'https://dl.test/stream/sample.mkv',
              },
            ],
          },
        ],
      };
    }

    throw new Error(`URL inesperada no teste: ${pathname}`);
  });

  try {
    const link = await debridlink.resolveLink(API_KEY, H1);
    assert.equal(link, 'https://dl.test/stream/matrix-1080p.mkv');
    assert.equal(addCalls, 1);
    assert.ok(listCalls >= 2, 'executou polling até atingir 100%');
  } finally {
    restore();
  }
});

test('debridlink: resolveLink com episódio de série escolhe arquivo correto', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/api/v2/seedbox/add') {
      return {
        success: true,
        value: {
          id: 'dl-series-1',
          downloadPercent: 100,
          files: [
            {
              name: 'Show.S01E01.1080p.mkv',
              size: 1_200_000_000,
              downloadUrl: 'https://dl.test/stream/s01e01.mkv',
            },
            {
              name: 'Show.S01E02.1080p.mkv',
              size: 1_200_000_000,
              downloadUrl: 'https://dl.test/stream/s01e02.mkv',
            },
          ],
        },
      };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const link = await debridlink.resolveLink(API_KEY, H1, { season: 1, episode: 2 });
    assert.equal(link, 'https://dl.test/stream/s01e02.mkv');
  } finally {
    restore();
  }
});

test('debridlink: resolveLink esgota 4 tentativas sem 100% e retorna null', async () => {
  let listCalls = 0;
  const restore = mockFetch((url) => {
    if (url.pathname === '/api/v2/seedbox/add') {
      return { success: true, value: { id: 'dl-stuck', downloadPercent: 20 } };
    }
    if (url.pathname === '/api/v2/seedbox/list') {
      listCalls += 1;
      return { success: true, value: [{ id: 'dl-stuck', downloadPercent: 25 }] };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const link = await debridlink.resolveLink(API_KEY, H1);
    assert.equal(link, null, 'retorna null quando download não atinge 100%');
    assert.equal(listCalls, 4, 'tentou exatamente 4 vezes');
  } finally {
    restore();
  }
});

test('debridlink: resolveLink retorna null se add falhar ou vier sem id', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/api/v2/seedbox/add') {
      return { success: true, value: {} }; // sem id
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const link = await debridlink.resolveLink(API_KEY, H1);
    assert.equal(link, null);
  } finally {
    restore();
  }
});

test('debridlink: enqueue adiciona magnet e retorna boolean', async () => {
  let added = false;
  const restore = mockFetch((url) => {
    if (url.pathname === '/api/v2/seedbox/add') {
      added = true;
      return { success: true, value: { id: 'dl-async-99' } };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const ok = await debridlink.enqueue(API_KEY, H2);
    assert.equal(ok, true);
    assert.equal(added, true);
  } finally {
    restore();
  }
});

test('debridlink: inventory lista apenas itens prontos (downloadPercent >= 100) com dados válidos', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/api/v2/seedbox/list') {
      return {
        success: true,
        value: [
          { hash: H1, name: 'Filme A 1080p', downloadPercent: 100, totalSize: 5_000_000_000 },
          { hash: H2, name: 'Filme B Baixando', downloadPercent: 65, totalSize: 3_000_000_000 }, // não pronto
          { hash: H3, name: H3.toUpperCase(), downloadPercent: 100, size: 2_000_000_000 }, // nome é o hash -> descartado
          { name: 'Sem hash', downloadPercent: 100, size: 1_000_000_000 }, // sem hash -> descartado
        ],
      };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const items = await debridlink.inventory(API_KEY);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      title: 'Filme A 1080p',
      infoHash: H1,
      size: 5_000_000_000,
    });
  } finally {
    restore();
  }
});

test('debridlink: torrentStatus mapeia ready, downloading e dead', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/api/v2/seedbox/list') {
      return {
        success: true,
        value: [
          { id: '101', hash: H1.toUpperCase(), downloadPercent: 100, status: 'downloading' },
          { id: '102', hash: H2, downloadPercent: 45, status: 'downloading' },
          { id: '103', hash: H3, downloadPercent: 0, status: 'error' },
          { id: '104', downloadPercent: 50 }, // sem hash
        ],
      };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const statusMap = await debridlink.torrentStatus(API_KEY);
    assert.equal(statusMap[H1]?.state, 'ready');
    assert.equal(statusMap[H1]?.id, '101');

    assert.equal(statusMap[H2]?.state, 'downloading');
    assert.equal(statusMap[H2]?.id, '102');

    assert.equal(statusMap[H3]?.state, 'dead');
    assert.equal(statusMap[H3]?.id, '103');

    assert.equal(statusMap['104'], undefined);
  } finally {
    restore();
  }
});

test('debridlink: removeTorrent remove da seedbox e trata erros defensivamente', async () => {
  let deletedId = '';
  const restore = mockFetch((url, init) => {
    if (url.pathname === '/api/v2/seedbox/dl-item-99/remove') {
      deletedId = 'dl-item-99';
      assert.equal(init?.method, 'DELETE');
      return { success: true };
    }
    if (url.pathname === '/api/v2/seedbox/dl-item-fail/remove') {
      return { success: false, error: 'not_found' };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });

  try {
    const ok = await debridlink.removeTorrent(API_KEY, 'dl-item-99');
    assert.equal(ok, true);
    assert.equal(deletedId, 'dl-item-99');

    const fail = await debridlink.removeTorrent(API_KEY, 'dl-item-fail');
    assert.equal(fail, false, 'erro no endpoint retorna false sem estourar');
  } finally {
    restore();
  }
});
