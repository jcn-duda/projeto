// Premiumize: varredura de transferências mortas e paradas (`sweepDead`).
// Extraído de test/debrid-torrent-status.test.ts pelo teto de 400 linhas —
// lá ficam os parsers de /torrentStatus de cada adaptador; aqui, a varredura,
// que tem dublê e payload próprios. Fetch dublado, sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as premiumize from '../src/debrid/premiumize.js';
import * as held from '../src/debrid/protected.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { markerKey, markerValue } from '../src/providers/autofetch-marker.js';

process.env.CACHE_PERSIST = 'false';

const btih = (h: string) => `magnet:?xt=urn:btih:${h}`;

// --- Premiumize: varredura de mortas e paradas -----------------------------
//
// O `/transfer/list` do Premiumize não devolve carimbo de tempo nenhum (as
// chaves são file_id, folder_id, id, message, name, other_cloud_id, progress,
// src, status), então `minAgeMs` não tem de onde ser calculado e a idade se
// reconstrói por observação. É o que estes testes fixam.

/** Dublê que separa a listagem da remoção, para contar o que foi apagado. */
function stubSweep(body: unknown, removidos: string[]) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any) => {
    const href = String(url);
    if (href.includes('/transfer/delete')) removidos.push(href);
    return { ok: true, status: 200, json: async () => (href.includes('/transfer/delete') ? { status: 'success' } : body) };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

const PARADA = '1'.repeat(40);

function payloadVarredura() {
  return {
    status: 'success',
    transfers: [
      { id: 'erro-1', status: 'error', src: btih('e'.repeat(40)), name: 'Release Qualquer 1080p' },
      { id: 'parada-1', status: 'running', src: '', name: PARADA, progress: 0, message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left' },
      { id: 'ok-1', status: 'running', src: btih('9'.repeat(40)), progress: 0.63, message: '14.16 MB/s from 7 peers, 10.9 GB of 17.2 GB' },
    ],
  };
}

test('premiumize sweepDead: erro sai na primeira passada, parada só na segunda', async () => {
  premiumize.resetStallMemory();
  const removidos: string[] = [];

  let restore = stubSweep(payloadVarredura(), removidos);
  let primeira;
  try {
    primeira = await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
  } finally {
    restore();
  }
  // Apagar a parada já na primeira observação mataria a transferência recém
  // criada pelo autofetch — ela nasce exatamente em "0 Bytes of 0 Bytes".
  assert.equal(primeira.varridos, 1, 'só o estado terminal sai de imediato');
  assert.equal(primeira.observados, 1, 'a parada foi anotada, não removida');

  restore = stubSweep(payloadVarredura(), removidos);
  try {
    const segunda = await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
    assert.equal(segunda.varridos, 2, 'na segunda observação a parada também sai');
  } finally {
    restore();
  }
  assert.equal(removidos.length, 3);
  assert.ok(removidos.every((url) => url.includes('/transfer/delete')));
});

test('premiumize sweepDead: transferência protegida pelo held nunca é varrida', async () => {
  premiumize.resetStallMemory();
  const account = accountScope('chave-de-teste');
  const removidos: string[] = [];
  held.hold(PARADA, 600, account);
  try {
    for (let i = 0; i < 3; i += 1) {
      const restore = stubSweep({ status: 'success', transfers: [payloadVarredura().transfers[1]] }, removidos);
      try {
        await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
      } finally {
        restore();
      }
    }
  } finally {
    held.release(PARADA, account);
  }
  assert.equal(removidos.length, 0, 'download do autofetch em curso não pode ser varrido');
});

test('premiumize sweepDead: voltar a andar zera a observação de parada', async () => {
  premiumize.resetStallMemory();
  const removidos: string[] = [];
  const parada = { status: 'success', transfers: [payloadVarredura().transfers[1]] };
  const andando = {
    status: 'success',
    transfers: [{ ...payloadVarredura().transfers[1], progress: 0.4, message: '3 MB/s from 5 peers, 1 GB of 4 GB' }],
  };

  for (const body of [parada, andando, parada]) {
    const restore = stubSweep(body, removidos);
    try {
      await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
    } finally {
      restore();
    }
  }
  assert.equal(removidos.length, 0, 'a observação antiga não sobrevive a um período andando');
});

test('premiumize sweepDead: minAgeMs adia a remoção mesmo com parada já observada', async () => {
  premiumize.resetStallMemory();
  const removidos: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const restore = stubSweep({ status: 'success', transfers: [payloadVarredura().transfers[1]] }, removidos);
    try {
      await premiumize.sweepDead('chave-de-teste', { minAgeMs: 60_000 });
    } finally {
      restore();
    }
  }
  assert.equal(removidos.length, 0, 'observada, mas ainda dentro da janela de idade');
});

test('premiumize sweepDead: nome humano só é varrido com a ponte id -> hash do marker', async () => {
  // Caso medido na conta do operador: a fila enche de post de agregador
  // ("[WWW.BLUDV.TV] ... [DUBLADO]") parado em "0 Bytes of 0 Bytes". Nenhum
  // campo da listagem carrega o hash, então a varredura não conseguia nem
  // consultar o `held` e a transferência ocupava vaga para sempre.
  const HUMANO = '7'.repeat(40);
  const account = accountScope('chave-de-teste');
  const linha = {
    id: 'bludv-1',
    status: 'running',
    src: '',
    name: '[WWW.BLUDV.TV] A Morte Te Dá Parabéns 2 2019 (1080p) [DUBLADO]',
    progress: 0,
    message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left',
  };
  const body = { status: 'success', transfers: [linha] };

  cache.forget(markerKey('premiumize', account, HUMANO));
  premiumize.resetStallMemory();
  const semMarker: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const restore = stubSweep(body, semMarker);
    try {
      await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
    } finally {
      restore();
    }
  }
  assert.equal(semMarker.length, 0, 'sem marker não há como identificá-la — nada é apagado');

  cache.set(markerKey('premiumize', account, HUMANO), markerValue('bludv-1'), 600);
  premiumize.resetStallMemory();
  const comMarker: string[] = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const restore = stubSweep(body, comMarker);
      try {
        await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
      } finally {
        restore();
      }
    }
    assert.equal(comMarker.length, 1, 'com a ponte, a segunda observação remove');

    // E o `held` volta a proteger: o download em curso do autofetch sobrevive.
    premiumize.resetStallMemory();
    const protegido: string[] = [];
    held.hold(HUMANO, 600, account);
    try {
      for (let i = 0; i < 2; i += 1) {
        const restore = stubSweep(body, protegido);
        try {
          await premiumize.sweepDead('chave-de-teste', { minAgeMs: 0 });
        } finally {
          restore();
        }
      }
    } finally {
      held.release(HUMANO, account);
    }
    assert.equal(protegido.length, 0, 'identificada, mas protegida pelo held');
  } finally {
    cache.forget(markerKey('premiumize', account, HUMANO));
  }
});
