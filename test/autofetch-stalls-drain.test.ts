// A derivação de parada por progresso, o colapso e o dreno da fila saíram do TS
// na leva B4: quem mede stall, colapsa o hash e sobe o fallback é o worker
// nativo do gateway (`adom-server/src/autofetch`, provado no `cargo test` de
// `adom-autofetch`/`recheck_expire.rs`). O que SOBRA no Node — e é o insumo
// dessa régua — é o adaptador: sem `progress` publicado (e com o campo cru
// `null` virando zero) a parada derivada nunca existiria.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import debrid from '../src/debrid/index.js';
import type { DebridAdapter } from '../types/domain.js';
import { withBodies } from './helpers/pipeline-oracle/debrid-bodies/index.js';

test('AllDebrid com progress: adapter só anexa progresso em Downloading com campos numéricos', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const ad = withBodies(debrid.BY_ID.get('alldebrid') as DebridAdapter);
  const ok = 'c3'.repeat(20);
  const nullo = 'c4'.repeat(20);
  const fila = 'c5'.repeat(20);
  const completo = 'c6'.repeat(20);
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: { magnets: [
        { id: 9, hash: ok, status: 'Downloading', size: 1000, downloaded: 250, downloadSpeed: 0, seeders: 0 },
        // null/ausente NÃO viram zero: sem os QUATRO campos numéricos não há progresso.
        { id: 10, hash: nullo, status: 'Downloading', size: 1000, downloaded: null, downloadSpeed: 0, seeders: 0 },
        // queued/processing não são Downloading: sem progresso (o state vira downloading).
        { id: 11, hash: fila, status: 'queued', size: 1000, downloaded: 250, downloadSpeed: 5, seeders: 3 },
        // bytes >= total (completo/limítrofe) também não publica progresso.
        { id: 12, hash: completo, status: 'Downloading', size: 1000, downloaded: 1000, downloadSpeed: 0, seeders: 0 },
      ] } }),
    })) as unknown as typeof globalThis.fetch;
    const out = await ad.torrentStatus!('chave-de-teste', [ok, nullo, fila, completo]);
    assert.equal(out[ok].state, 'downloading');
    assert.equal(out[ok].via, 'hash', 'listagem por hash: remoção terminal fora do gate removeById');
    assert.deepEqual(out[ok].progress, { bytes: 250, total: 1000, speed: 0, seeders: 0 });
    assert.equal(out[ok].stalled, undefined, 'o adaptador NÃO deriva stalled');
    assert.equal(out[nullo].progress, undefined, 'campo cru null não vira zero');
    assert.equal(out[fila].state, 'downloading');
    assert.equal(out[fila].progress, undefined, 'queued não publica progresso');
    assert.equal(out[completo].progress, undefined, 'bytes >= total não publica progresso');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
