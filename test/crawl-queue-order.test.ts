// Ordem da fila do motor de raspagem: NOVIDADE primeiro (`added_at DESC`). As
// duas engines (SQLite e memória) têm de servir a mesma ordem.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.CACHE_PERSIST = 'false';
import * as store from '../src/utils/crawl-store.js';
import { memoryCrawlEngine } from '../src/utils/crawl-store-memory.js';

const movie = (url: string, lastmod = '2026-09-25') => ({ url, lastmod, kind: 'movie' as const });

beforeEach(() => {
  store.resetForTests();
  store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-order-')), 'crawl.db'));
});
after(() => store.resetForTests());

test('takeNext: NOVIDADE primeiro — descoberta recente e post atualizado furam o estoque (as duas engines)', () => {
  // Medido na VPS em 2026-09-29: com `added_at ASC`, as séries recém-ligadas e
  // o lançamento do dia esperavam atrás de ~34 mil filmes da carga inicial.
  for (const [label, e] of [['aberta', store.engine()], ['memória', memoryCrawlEngine()]] as const) {
    e.upsertUrls('vacatorrent', [movie('/estoque-1'), movie('/estoque-2')], 1000);
    e.upsertUrls('vacatorrent', [{ url: '/serie-nova', lastmod: '2026-09-29', kind: 'tv_show' }], 5000);
    assert.equal(e.takeNext('vacatorrent', 9000)?.url, '/serie-nova', `${label}: descoberta recente primeiro`);
    // Post do estoque ATUALIZADO (lastmod novo) volta como novidade.
    e.upsertUrls('vacatorrent', [movie('/estoque-2', '2026-09-30')], 6000);
    assert.equal(e.takeNext('vacatorrent', 9000)?.url, '/estoque-2', `${label}: post atualizado fura o estoque`);
    assert.equal(e.takeNext('vacatorrent', 9000)?.url, '/estoque-1');
  }
});

