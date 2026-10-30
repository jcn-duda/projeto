// Terminal medido da AllDebrid (frase exata, statusCode 10) reconhecido por
// torrentStatus sem condenar por código isolado; a listagem autoritativa volta
// a `via:'hash'`. Sem rede real.
//
// A varredura que APAGA o terminal não é mais do Node: quem monta o plano e
// aplica é o agendador NATIVO (`al_sweeps`, atrás do gate
// `DEBRID_AL_SWEEP_APPLY`). Aqui fica só a régua de classificação que a
// checagem/catálogo ainda usam.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import debrid from '../src/debrid/index.js';
import { isDeadMagnet, DEAD } from '../src/debrid/alldebrid-api.js';
import type { DebridAdapter } from '../types/domain.js';
import { withBodies } from './helpers/pipeline-oracle/debrid-bodies/index.js';

const hx = (seed: string) => seed.repeat(20);

function stubFetchJson(payload: unknown) {
  return (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof globalThis.fetch;
}

test('DEAD reconhece a mensagem exata e ignora statusCode isolado', () => {
  assert.equal(DEAD.test('Download took more than 3 days'), true);
  assert.equal(isDeadMagnet('Download took more than 3 days'), true);
  assert.equal(isDeadMagnet(undefined, 10), false, 'código 10 sozinho NÃO condena: o texto é a autoridade');
  assert.equal(isDeadMagnet('Downloading', 10), false, '10 com texto Downloading ainda baixa');
  assert.equal(isDeadMagnet('Downloading'), false);
  assert.equal(isDeadMagnet('Ready'), false);
  assert.equal(isDeadMagnet('queued', 1), false);
  assert.equal(isDeadMagnet('Ready', 4), false);
});

test('AllDebrid torrentStatus: frase terminal vira dead com via=hash; statusCode 10 não condena', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const ad = withBodies(debrid.BY_ID.get('alldebrid') as DebridAdapter);
  const hMsg = hx('d1');
  const hCode = hx('d2');
  const hReady = hx('d3');
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = stubFetchJson({ status: 'success', data: { magnets: [
      { id: 1, hash: hMsg, status: 'Download took more than 3 days' },
      { id: 2, hash: hCode, status: 'Downloading', statusCode: 10 },
      { id: 3, hash: hReady, status: 'Ready', statusCode: 4 },
    ] } });
    const out = await ad.torrentStatus!('chave-de-teste', [hMsg, hCode, hReady]);
    assert.equal(out[hMsg].state, 'dead', 'frase exata é terminal');
    assert.equal(out[hCode].state, 'downloading', 'statusCode 10 com texto Downloading NÃO é dead');
    assert.equal(out[hReady].state, 'ready');
    assert.equal(out[hMsg].via, 'hash', 'listagem autoritativa por hash');
    assert.equal(out[hCode].via, 'hash');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
