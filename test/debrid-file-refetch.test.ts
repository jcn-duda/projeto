// A checagem de cache é o único ponto que lê a lista de arquivos dos packs
// (AllDebrid /magnet/status, TorBox list_files), e é dela que sai o tamanho
// exato do episódio ou do filme dentro de uma coleção.
//
// Medido em Star Trek (2009), 2026-09-13: a coleção pronta vinha do davail e a
// checagem não abortável (caminho da AllDebrid) nem repassava `fileHashes` —
// zero leituras de arquivo, e a lista ficava com o total da coleção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import type { DebridAdapter } from '../types/domain.js';

interface CheckResult {
  cached: Set<string>;
  known: boolean;
}

test('pack sem arquivos servido pelo L1 volta ao serviço e a AllDebrid recebe fileHashes', async () => {
  const calls: Array<{ hashes: string[]; options?: { fileHashes?: string[] } }> = [];
  const adapter = {
    id: 'premiumize',
    label: 'AllDebrid-like fake',
    short: 'ad',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[], options?: { fileHashes?: string[] }) {
      calls.push({ hashes: [...infoHashes], ...(options ? { options } : {}) });
      return { cached: new Set(infoHashes), complete: true };
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: `chave-fake-file-refetch-${process.pid}` };
  const run = (hashes: string[], options?: { fileHashes?: string[] }) =>
    runtime.run({ opts, encoded: '' }, () => debrid.checkCached(hashes, options)) as Promise<CheckResult>;
  try {
    await run(['colecao-pronta', 'outro-hash']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options, undefined, 'sem pack pendente a chamada não muda de forma');

    const semPack = await run(['colecao-pronta']);
    assert.equal(calls.length, 1, 'sem fileHashes o L1 responde sozinho');
    assert.deepEqual([...semPack.cached], ['colecao-pronta']);

    const comPack = await run(['colecao-pronta'], { fileHashes: ['colecao-pronta'] });
    assert.equal(calls.length, 2, 'o pack sem arquivos volta ao serviço mesmo com positivo no L1');
    assert.deepEqual(calls[1].hashes, ['colecao-pronta']);
    assert.deepEqual(calls[1].options?.fileHashes, ['colecao-pronta'], 'a checagem não abortável repassa fileHashes');
    assert.deepEqual([...comPack.cached], ['colecao-pronta']);
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});
