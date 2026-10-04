// Pack pronto na Premiumize sem resolução no título ("O.Segredo.de.Widow's
// Bay.S01.Dub E01-E08", 10 GB, 2026-10-04): a checagem só dizia sim/não e o
// item seguia "sem resolução" até alguém tocá-lo. A checagem agora lê os
// arquivos em fundo e a busca seguinte usa o nome do arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packHashesMissingFiles } from '../src/providers/episode-size.js';
import { clearFileSizes, peekFileSizes } from '../src/debrid/file-sizes.js';
import { scheduleFileLists } from '../src/debrid/premiumize-files.js';
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

test('premiumize: falha da leitura não derruba nada', async () => {
  clearFileSizes();
  const call = async () => { throw new Error('rede'); };
  assert.equal(scheduleFileLists(call, 'key', [DUB], new Set([DUB])), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peekFileSizes(DUB), null);
});
