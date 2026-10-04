// Pack pronto na Premiumize sem resolução no título ("O.Segredo.de.Widow's
// Bay.S01.Dub E01-E08", 10 GB, 2026-10-04): a checagem só dizia sim/não e o
// item seguia "sem resolução" até alguém tocá-lo. A checagem agora lê os
// arquivos em fundo e a busca seguinte usa o nome do arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packHashesMissingFiles } from '../src/providers/episode-size.js';
import { clearFileSizes, peekFileSizes } from '../src/debrid/file-sizes.js';
import { scheduleFileLists, freshFileLink } from '../src/debrid/premiumize-files.js';
import { scheduleVideoProbe, peekVideoQuality, videoQualityKey } from '../src/debrid/video-quality.js';
import * as cache from '../src/utils/cache.js';
import type { Stream } from '../types/domain.js';

const DUB = 'd4'.repeat(20);
const GB = 1024 ** 3;

test('item sem resolução pede a lista de arquivos, mesmo com 💾 e sem ser pack', () => {
  clearFileSizes();
  const stream = {
    infoHash: DUB,
    title: "O.Segredo.de.Widow's Bay.S01.Dub E01-E08\n👤 0 💾 10.10 GB ⚙️ kickasstorrents.to",
    _quality: 'sem resolução',
  } as Stream;
  assert.deepEqual(packHashesMissingFiles([stream], 1), [DUB]);
  assert.equal(packHashesMissingFiles([{ ...stream, _quality: '1080p' } as Stream], 1).length, 0);
});

test('premiumize: lê os arquivos só dos pedidos que estão prontos, com teto', async () => {
  clearFileSizes();
  const calls: string[] = [];
  const call = async (_key: string, path: string, init: { body: URLSearchParams }) => {
    calls.push(`${path} ${String(init.body.get('src')).slice(20, 28)}`);
    return { content: [{ path: `Widows.Bay.S01E01.1080p.WEB-DL.DUAL.mkv`, size: 1.3 * GB }] };
  };
  const hashes = ['a1', 'b2', 'c3', 'e5'].map((p) => p.repeat(20));
  const wanted = new Set([hashes[0], hashes[1], hashes[2]]);
  // e5 está pronto mas não foi pedido; o teto é 2 por checagem.
  const started = scheduleFileLists(call, 'key', hashes, wanted);
  assert.equal(started, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.startsWith('/transfer/directdl')));
  assert.equal(peekFileSizes(hashes[0])?.[0]?.path, 'Widows.Bay.S01E01.1080p.WEB-DL.DUAL.mkv');
  assert.equal(peekFileSizes(hashes[3]), null);
  // Já conhecido não é pedido de novo.
  assert.equal(scheduleFileLists(call, 'key', [hashes[0]], wanted), 0);
  clearFileSizes();
});

test('premiumize: link fresco do arquivo pedido, pelo caminho exato', async () => {
  const call = async () => ({
    content: [
      { path: "Pasta/O.Segredo.de.Widow's Bay.S01.Dub.EP-1.mp4", size: 1.48 * GB, link: 'https://cdn.test/ep1' },
      { path: "Pasta/O.Segredo.de.Widow's Bay.S01.Dub.EP-2.mp4", size: 1.32 * GB, link: 'https://cdn.test/ep2' },
    ],
  });
  const got = await freshFileLink(call, 'key', DUB, "Pasta/O.Segredo.de.Widow's Bay.S01.Dub.EP-2.mp4");
  assert.equal(got?.url, 'https://cdn.test/ep2');
  assert.equal(await freshFileLink(call, 'key', DUB, 'Pasta/outro.mp4'), null);
});

test('medição de cabeçalho usa o link do serviço, sem /link/unlock', async () => {
  const path = 'Pasta/EP-1.mp4';
  const key = videoQualityKey(DUB, path);
  cache.forget(key);
  let asked = 0;
  const queued = scheduleVideoProbe({
    hash: DUB, path, link: '', apiKey: 'key', size: 0,
    resolveUrl: async () => { asked += 1; return null; },
  });
  assert.equal(queued, true, 'sem link da lista, o resolveUrl basta para enfileirar');
  for (let i = 0; i < 20 && cache.peek(key) == null; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1);
  // Sem link do serviço: marcado como ilegível por um dia, sem nova tentativa a cada busca.
  assert.equal(peekVideoQuality(DUB, path), null);
  cache.forget(key);
});

test('premiumize: falha da leitura não derruba nada', async () => {
  clearFileSizes();
  const call = async () => { throw new Error('rede'); };
  assert.equal(scheduleFileLists(call, 'key', [DUB], new Set([DUB])), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peekFileSizes(DUB), null);
});
